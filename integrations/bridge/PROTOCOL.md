# Flowit host bridge protocol

Bridge adapters are the fallback for Agent products that can read/write an authorized local folder but do not expose a stable public Session/Resume API.

Default root:

```text
~/.flowit-workflow/bridges/<adapter-id>/
  sessions.json
  events.jsonl
  events.cursor
  inbox/
  processing/
  outbox/
  cancellations/
  cancelled/
  dead-letter/
  receipts/
    quarantine/
  claims/
    <sha256(idempotencyKey)>.lock/
    .mutation/<sha256(idempotencyKey)>.lock/
```

## Request envelope v2

Flowit atomically writes `inbox/<requestId>.json` with:

```json
{
  "version": 2,
  "requestId": "...",
  "idempotencyKey": "stable across retries of one Workflow node/occurrence",
  "adapterId": "workbuddy",
  "createdAt": "...",
  "expiresAt": "...",
  "attempt": 1,
  "cancellationPath": ".../cancellations/<requestId>.json",
  "receiptPath": ".../receipts/<sha256(idempotencyKey)>.json",
  "executionClaimPath": ".../claims/<sha256(idempotencyKey)>.lock",
  "executionLeaseMs": 30000,
  "request": {},
  "context": []
}
```

`context` contains bounded same-adapter summaries resolved by Flowit. Context is read-only background and never approval or authority.

## Two-stage Worker claim

A Worker MUST acquire two different ownership layers:

1. **Request-file claim** — atomically rename one `inbox/<requestId>.json` to `processing/<requestId>.json`. This prevents two Workers from handling the same transport file.
2. **Logical execution claim** — acquire/update the lease at `executionClaimPath`. This lease is keyed by `idempotencyKey`, not `requestId`, and prevents different retry request files from being granted the same logical execution ownership.

The execution lease contains `owner.json` with `idempotencyKey`, a random `ownerToken`, `ownerLabel`, `acquiredAt`, and `expiresAt`.

### Lease-generation mutation mutex

Initial creation of an absent execution lease is atomic directory creation. Every operation that can change an existing lease generation — **renew, release, or expired-lease takeover** — MUST also hold:

```text
claims/.mutation/<sha256(idempotencyKey)>.lock/
```

Rules:

- create the mutation directory atomically before reading/changing `owner.json` or replacing/removing `executionClaimPath`;
- while the mutation mutex exists, no other Worker may renew, release, or take over that logical key;
- renew succeeds only when `ownerToken` still matches and the lease has not expired; an expired owner is fenced and may not resurrect itself;
- takeover moves the old generation aside and publishes the replacement while still holding the mutation mutex;
- release verifies `ownerToken` and removes only that generation while holding the mutation mutex;
- the short mutation mutex has no automatic stale takeover. A crash inside lease metadata mutation fails closed and requires operator recovery rather than risking two owners.

A Worker that cannot obtain the idempotency execution lease MUST NOT execute task side effects. It may wait for the shared completed receipt, replay it to its own outbox, or take over only after lease expiry and successful mutation-lock acquisition.

## Completed receipt v1

A shared receipt is a **successful terminal result only**. Retryable failures MUST NOT be written to the shared receipt path.

```json
{
  "version": 1,
  "idempotencyKey": "same logical key as the request",
  "status": "completed",
  "completedAt": "2026-08-27T00:00:00.000Z",
  "result": {
    "sessionId": "...",
    "loadedSkills": [],
    "referencedSessions": [],
    "outputSummary": "..."
  }
}
```

Publication rules:

1. Serialize the entire receipt to a temporary file in `receipts/`.
2. Flush the temporary file (`fsync`/equivalent) before exposing a stable name.
3. While still holding the logical execution lease, publish the already-complete inode to `receiptPath` with a **no-replace atomic operation** (`link`, rename-no-replace, or an equivalent host primitive). Do not create the final file and then stream JSON into it.
4. If a valid completed receipt already exists, replay it instead of overwriting it.
5. If `receiptPath` contains malformed JSON, the wrong idempotency key, or a non-completed/unknown schema, move it to `receipts/quarantine/` and treat the logical task as not yet completed.
6. Remove the temporary file after successful publication/replay.

A per-request failure is written only to `outbox/<requestId>.json` as `error`. The Workflow layer may then retry with a new `requestId` but the same `idempotencyKey`.

## Worker execution order

After request-file ownership and logical execution ownership are established:

1. Check request expiry and cancellation. Expired requests go to `dead-letter/`; cancelled requests go to `cancelled/`.
2. Read and validate the completed receipt schema. If a valid receipt for the same `idempotencyKey` exists, replay `receipt.result` to this request's outbox, release the execution lease, and do not repeat side effects.
3. Resolve every requested Skill. Missing requested Skills fail closed.
4. Immediately before the first side effect, re-check expiry/cancellation and confirm the execution lease still belongs to the current `ownerToken`.
5. Execute under the host's normal permission/sandbox rules. Renew before lease expiry while work remains active. If renew returns false, stop starting new side effects. Propagate `idempotencyKey` to host-native idempotency/fencing mechanisms when available.
6. Re-check cancellation and lease ownership before every new side effect.
7. On success, atomically publish the versioned completed receipt as described above; then write `outbox/<requestId>.json` with the plain successful `result` for the waiting transport request.
8. On failure, write only this request's outbox error. Do not publish a shared receipt.
9. Release the execution lease only after successful durable receipt publication, or after a failure has stopped further side effects. Remove/move the processing item last.

There remains an unavoidable crash/fencing window for host side effects that offer no idempotency or fencing mechanism: an old Worker can have a side effect already in flight when its lease expires. Such operations must use host-native idempotency/transaction/fencing mechanisms or require human review. Flowit does not claim generic exactly-once side effects.

## Cancellation

When the Flowit caller times out or is aborted it writes `cancellations/<requestId>.json` and tries to move an unclaimed inbox item to `cancelled/`. A Worker that already claimed the item MUST observe the tombstone before executing any further side effect. Cancellation means **do not start new side effects**; it cannot roll back a side effect the host already committed.

## Delivery semantics

- Workflow/event execution is **at-least-once**.
- `idempotencyKey` is stable for one logical Schedule occurrence or Pipeline node across retries.
- `requestId` identifies one transport attempt only; it is never the side-effect ownership key.
- Bridge execution leases provide cooperative in-flight deduplication while Workers obey fencing.
- Completed receipts replay successful results; retryable failures never poison the shared receipt key.
- Core event terminal receipts have an explicit retention window/cap and therefore provide bounded replay deduplication rather than an unbounded exactly-once claim.
- Do not invent a Session resume primitive. If the host cannot address a session, return an error or use a host-native Automation/Managed Agent driver.
