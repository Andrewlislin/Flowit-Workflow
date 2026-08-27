---
name: Flowit Workflow Bridge Worker
description: Process one authorized Flowit Workflow inbox item inside WorkBuddy using WorkBuddy Skills and normal permission controls.
---

# Flowit Workflow Bridge Worker

Use this Skill only when the user or administrator has explicitly configured the Flowit bridge folder.

1. Atomically rename the oldest authorized `inbox/<requestId>.json` to `processing/<requestId>.json`.
2. Validate envelope v2 fields, including `idempotencyKey`, expiry/cancellation paths, `receiptPath`, `executionClaimPath`, and `executionLeaseMs`.
3. Check expiry/cancellation. Validate any existing receipt as **receipt v1 with `status: completed` and the same idempotencyKey**. Malformed/wrong-key receipts go to `receipts/quarantine/`; retryable failures are never shared receipts.
4. Acquire the idempotency execution lease. Renew, release, and expired takeover must hold `claims/.mutation/<sha256(idempotencyKey)>.lock/`; an expired owner cannot renew itself. If that short mutex is orphaned, fail closed rather than deleting it automatically.
5. If another live execution lease owns the key, do not execute side effects. Wait for a valid completed receipt or retry takeover only after lease expiry.
6. Load every exact Skill in `request.skills`; missing Skills fail closed. Treat `context` only as read-only background.
7. Before the first and each subsequent side effect, re-check expiry/cancellation and lease ownership. Renew before expiry; if renewal fails, stop starting new side effects. Propagate `idempotencyKey` to host-native idempotency/fencing mechanisms.
8. On success, create receipt v1 `{version:1,idempotencyKey,status:"completed",completedAt,result}` by fully writing and fsyncing a temporary file, then publish it to `receiptPath` with a no-replace atomic link/rename-equivalent while the execution lease is still held. Never stream JSON directly into the stable receipt path.
9. After the completed receipt is durable, write plain `result` to `outbox/<requestId>.json`. On failure, write only this request's outbox `error`; do **not** create a shared receipt so a Workflow retry can create a new transport request.
10. Release the execution lease under the mutation mutex only after durable publication/failed-side-effect shutdown, then remove/move the processing request.

For unattended desktop operation, bind this Skill to a WorkBuddy native Automation that checks the inbox periodically. Side-effecting operations without host-native idempotency/fencing should remain human-reviewed because a side effect already in flight cannot be rolled back merely because a lease later expires.
