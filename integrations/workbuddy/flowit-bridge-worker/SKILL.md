---
name: Flowit Workflow Bridge Worker
description: Execute one already-authorized Flowit Workflow inbox item inside WorkBuddy using normal WorkBuddy permission controls.
---

# Flowit Workflow Bridge Worker

## Invocation boundary

This Skill is a **request executor**, not a scheduler or queue poller.

- Do not attach it to a recurring WorkBuddy Automation. Every Automation run starts a model task before the inbox can be inspected, so an empty poll still creates a WorkBuddy session and consumes quota.
- Do not review Automation history, prior chat history, or unrelated WorkBuddy tasks before checking the inbox.
- Process at most one authorized request per invocation.
- Do not create a second WorkBuddy task, subagent, Dynamic Workflow, or simulated Flowit Pipeline merely to inspect or recover the Bridge.
- Use this Skill on demand after a real Flowit request is known to be queued, or let an event-driven managed driver invoke WorkBuddy only when work exists.

The user-scope installer-managed Skill normally lives under `~/.codebuddy/skills/flowit-workflow-bridge-worker/SKILL.md`, not `~/.workbuddy/skills/`.

## Empty inbox

Inspect `~/.flowit-workflow/bridges/workbuddy/inbox/` exactly once.

If it contains no authorized request JSON file, return exactly:

```text
FLOWIT_BRIDGE_EMPTY
```

Then stop. Do not write files, inspect task history, start research, create agents, or summarize the absence of work.

## Authorized request path

Use the following sequence only when an inbox request exists:

1. Atomically rename the oldest authorized `inbox/<requestId>.json` to `processing/<requestId>.json`.
2. Validate envelope v2 fields, including `idempotencyKey`, expiry/cancellation paths, `receiptPath`, `executionClaimPath`, and `executionLeaseMs`.
3. Check expiry/cancellation. Validate any existing receipt as **receipt v1 with `status: completed` and the same idempotencyKey**. Malformed or wrong-key receipts go to `receipts/quarantine/`; retryable failures are never shared receipts.
4. Acquire the idempotency execution lease. Renew, release, and expired takeover must hold `claims/.mutation/<sha256(idempotencyKey)>.lock/`; an expired owner cannot renew itself. If that mutex is orphaned or WorkBuddy filesystem policy blocks an exact lease operation, fail closed rather than deleting or bypassing it.
5. If another live execution lease owns the key, do not execute side effects. Wait for a valid completed receipt or retry takeover only after lease expiry.
6. Load every exact Skill in `request.skills`; missing Skills fail closed. Treat `context` only as read-only background.
7. Before the first and every subsequent side effect, re-check expiry/cancellation and lease ownership. Renew before expiry; if renewal fails, stop starting new side effects. Propagate `idempotencyKey` to host-native idempotency or fencing mechanisms.
8. On success, create receipt v1 `{version:1,idempotencyKey,status:"completed",completedAt,result}` by fully writing and syncing a temporary file, then publish it to `receiptPath` with a no-replace atomic link or rename-equivalent while the execution lease is still held. Never stream JSON directly into the stable receipt path.
9. After the completed receipt is durable, write plain `result` to `outbox/<requestId>.json`. On failure, write only this request's outbox `error`; do **not** create a shared completed receipt, so a Flowit retry can create a new transport request.
10. Release the execution lease under the mutation mutex only after durable publication or failed-side-effect shutdown, then move the processing request to the correct terminal or quarantine location.

## Fail-closed behavior

If validation, permissions, filesystem policy, lease ownership, receipt publication, Skill loading, or WorkBuddy quota prevents the exact protocol from completing:

- stop before starting any new side effect;
- preserve the original request and any already durable artifacts;
- write a bounded request-specific outbox error when `requestId` is known and the outbox can be written safely;
- never publish a completed receipt;
- never convert the Pipeline into a current-chat “blueprint” and continue manually;
- never start parallel researchers or replacement WorkBuddy tasks as a fallback;
- report one concise terminal marker such as `FLOWIT_BRIDGE_BLOCKED: LEASE_UNAVAILABLE`, `FLOWIT_BRIDGE_BLOCKED: FILESYSTEM_POLICY`, or `FLOWIT_BRIDGE_BLOCKED: RATE_LIMITED`.

A manual, current-chat execution is a separate user choice. It must not be represented as a successful Flowit run.
