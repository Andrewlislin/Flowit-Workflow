# Architecture

Flowit Workflow is an **agent orchestration runtime**, not a wrapper around one Agent product.

```text
                         Flowit Orchestration Core
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
 Durable Schedule Engine    Pipeline / Work Graph      Context Graph
        │                         │                         │
        └────────────────── Skill Binding ─────────────────┘
                                  │
                         AgentAdapter contract
                                  │
      DSH / Claude / OpenCode / Codex / WorkBuddy / 豆包办公 / future
```

Host SDKs stay below `AgentAdapter`; Core owns orchestration facts only.

## Core ownership

Core owns Schedule definitions/occurrences, Pipeline DAGs, durable event admissions, run lease/retry/checkpoint state, bounded terminal receipts, context references, requested Skill names, and adapter/session identity. It does not own host transcripts, authentication, permissions, sandboxes, model configuration, Skill bodies or credentials.

## AgentAdapter lifecycle

Adapters may implement:

```ts
start?(signal?: AbortSignal): Promise<void> | void
```

Lifecycle state is bound to the registered Adapter **instance/generation**, not only its string ID. Unregistering an Adapter aborts that generation; a replacement with the same ID starts independently. Dispatcher/control-plane host calls lazily start an Adapter before use.

For active workers, `core.ready` means:

```text
storage load / migration
        ↓
all enabled Adapter start(signal) preflights
        ↓
Pipeline event subscriptions
        ↓
recoverable inbox/run reconciliation
        ↓
Scheduler reconciliation
```

Core owns a startup AbortController. Disposal aborts startup first, stops Scheduler/Pipeline work, disposes host adapters with a bounded fallback, then observes startup settlement only for a bounded grace period. OpenCode uses the startup signal for its service preflight; Codex uses it for App Server initialize and terminates the child if startup is cancelled.

Detached daemon readiness is published atomically. Partial JSON is treated as incomplete. The parent terminates an unready daemon with bounded TERM → KILL escalation, using the detached process group on POSIX.

## Durable event admission

Host event ingestion is separate from Pipeline business execution.

```text
host event
   ↓
match all active Pipelines
   ↓
Store transaction writes eventInbox[] rows
   ↓
host listener returns
   ↓
worker claim moves durable admission into run lease
   ↓
execute / retry / checkpoint
```

`claimPipelineTrigger()` creates/claims the run and removes its matching inbox row in the same Store transaction. If a process dies while a trigger is waiting behind another run, the admission remains in `eventInbox`; if it dies after claim, the run lease/retry record is the recovery authority.

One Pipeline failure does not reject sibling delivery. OpenCode stream reconnect/backoff improves transport liveness, but the durable inbox is the mechanism that protects already-received events from in-process queue loss.

## Run execution model

Execution is **at-least-once**.

- Schedule ownership uses `claimScheduleOccurrence()` with `active + exact nextRunAt + trigger claim` in one transaction.
- Pipeline ownership uses Store-backed claim/lease/heartbeat.
- stale running work is recoverable after lease expiry.
- failed work may retry; max attempts become dead-letter.
- Pipeline node checkpoints are inherited by later attempts.
- stable correlation/idempotency keys flow to adapters/host-native mechanisms.
- generic exactly-once side effects are not claimed.

### Bounded terminal receipts

Terminal event receipts live outside bounded `runs[]`, but they are also bounded to avoid unbounded JSON growth. Defaults are 100,000 receipts and 90 days. The earliest limit reached can evict old event dedupe evidence. A current active Schedule occurrence receipt is protected until Schedule state advances.

Therefore terminal receipt semantics are a **bounded replay-deduplication window**, not permanent exactly-once history. A future storage backend can replace this JSON index with SQLite/another indexed store without changing the orchestration contract.

## Schedule Engine

Each occurrence is keyed by Schedule ID + scheduled timestamp. `claimScheduleOccurrence()` atomically verifies the Schedule still exists, remains active, still points at the expected `nextRunAt`, and the trigger is claimable. Cancellation/reschedule between observation and claim therefore prevents dispatch.

Fixed-rate catch-up remains collapsed to the next future slot rather than replaying all missed intervals.

## Pipeline Graph

A Pipeline is a DAG of `AutomationTarget` nodes. Creation/activation checks the combined adapter+session autonomous graph under one Store transaction to prevent independently valid definitions from forming an automatic cycle.

Recovered runs rebuild predecessor context from persisted node checkpoints. Event triggers have durable inbox admission before execution and bounded terminal replay receipts after completion/dead-letter.

## Orchestration storage and v0.3 migration

v0.4 default:

```text
~/.flowit-workflow/instances/<instanceId>/workflow.json
```

v0.3 default:

```text
~/.flowit-workflow/<adapterId>/workflow.json
```

For the default v0.4 instance without explicit storage, migration scans all built-in legacy adapter paths. It acquires every legacy `daemon.pid` path with v0.3's atomic `open(..., 'wx')` ownership convention before locking/reading legacy databases. That both detects a live old daemon and prevents one from starting inside the migration check/use window.

Migration rules:

- one non-empty legacy state → migrate and archive;
- multiple structurally equal states → migrate once and archive all;
- multiple different non-empty states → fail closed;
- non-empty new state differing from legacy → fail closed.

Equality uses structured deep comparison, so object property order is irrelevant.

Explicit offline entry point:

```bash
flowit-workflow migrate --instance=default \
  --legacy-storage=/path/a/workflow.json \
  --legacy-storage=/path/b/workflow.json
```

## Daemon worker lease

The storage database, not Adapter/instance label, is the daemon ownership key. Flowit canonicalizes the storage path and acquires:

```text
~/.flowit-workflow/leases/<sha256(canonical-storage)>.lock/
  owner.json
```

The directory is the atomic claim. Owner-token checked release, initialization grace and dead-PID stale recovery prevent duplicate ownership/path-alias races.

## Context Graph and Skill Binding

Core stores `{adapterId, sessionId, label?}` rather than transcripts. Foreign-adapter references fail closed until a provenance-carrying Context Bridge exists. Skill binding stores names and resolves them at execution time in each host.

## Bridge protocol

Bridge v2 separates transport request ownership from logical side-effect ownership. Request files use `requestId`; execution leases use stable `idempotencyKey`; renew/release/takeover of a lease generation are serialized by a short mutation mutex.

Shared receipt format is completed-only:

```text
receipt v1 = version + idempotencyKey + status:completed + completedAt + result
```

The receipt is fully written/fsynced to a temporary inode before a no-replace atomic publish. Corrupt/wrong-key receipts are quarantined. Failed attempts write only per-request outbox errors, so retryable failures cannot poison the shared idempotency key. Successful replay repairs the Bridge Session summary catalog before returning.

The bridge remains cooperatively fenced/at-least-once. External side effects need host-native idempotency/transactions/fencing for stronger guarantees.

## Host event identity

OpenCode preserves authoritative host event IDs when available, then durable aggregate+sequence, then deterministic canonical-content hashes. Deprecated `session.idle` and current idle `session.status` normalize to the same Flowit event kind. Codex accepts both string and numeric JSON-RPC IDs.

## Host status

- **DeepSeek Harness** — reference implementation.
- **Claude Code** — pilot adapter with durable Hook journal/cursor.
- **OpenCode V2** — Experimental; pinned generated client, abortable preflight, reconnecting event stream.
- **Codex** — Experimental; bidirectional App Server v2, abortable startup, fail-closed approvals, terminal checks and deadlines.
- **WorkBuddy** — Hybrid bridge/driver.
- **豆包办公** — constrained Bridge; no unverified Session Resume/Event API claims.


## Package boundaries

Flowit's `AgentAdapter` boundary is also an npm package boundary. `@coaseedgeltd/flowit-core` contains the host-agnostic orchestration engine and has no third-party runtime dependencies or peers. Host integrations ship separately as `@coaseedgeltd/flowit-adapter-*` packages. The existing `@coaseedgeltd/flowit-workflow` package remains the batteries-included compatibility distribution and re-exports its previous public subpaths.

Minimal consumers install only Core plus the adapters they use. The full package intentionally aggregates every built-in adapter and therefore has the broadest SBOM.
