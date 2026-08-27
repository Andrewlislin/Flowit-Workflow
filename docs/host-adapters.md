# Host adapters

Flowit Workflow keeps host-specific execution below the `AgentAdapter` boundary. Capability flags describe technical primitives; release labels describe actual contract/E2E evidence.

| Host | Release level | Notes |
| --- | --- | --- |
| DeepSeek Harness | Reference | Native Session resume, Skills, immutable references and events. |
| Claude Code | Pilot | Public `--resume`, Hooks journal/cursor and wrapper Skill attestation. |
| OpenCode V2 | Experimental | Official `@opencode-ai/sdk` V2 client, abortable preflight, stable event IDs and reconnecting stream. |
| Codex | Experimental | Bidirectional App Server v2, typed Skills, abortable startup, terminal checks and string/number JSON-RPC IDs. |
| WorkBuddy | Hybrid | Desktop Bridge or configured enterprise/Managed-Agent driver. |
| 豆包办公 | Bridge | Host Worker Skill/file bridge; no unverified Session resume/event API claims. |

## Adapter lifecycle and readiness

Adapters may implement `start(signal)`. Lifecycle state belongs to one registered Adapter instance/generation. Replacing an Adapter with another instance using the same ID does not inherit the old `started` state; unregister aborts the old startup and removes its event subscription.

Active daemon readiness waits for Adapter startup. Control-plane cores do not eagerly start hosts, but `sessions.list` and dispatch call Adapter startup lazily before the host operation.

Core disposal aborts startup first. Detached CLI startup publishes readiness atomically and on timeout/error performs bounded TERM → KILL cleanup. OpenCode passes startup cancellation to its preflight request; Codex passes it into App Server initialize and terminates App Server on cancellation.

## Durable host event admission

An Adapter listener is acknowledged only after Core persists one `eventInbox` row for every matching active Pipeline in a Store transaction. Pipeline business execution occurs asynchronously after durable admission. A long Pipeline therefore does not need to hold the host event reader open, and a process restart can recover admissions that never reached `claimRun()`.

Adapter replay properties still matter for events not yet observed by Flowit. OpenCode reconnects its stream, but no undocumented server cursor/durable replay guarantee is claimed.

## Durable host-boundary requirements

- stable logical correlation/idempotency identity across retries;
- fail-closed Skill binding;
- bounded, read-only context projection;
- honest event replay/durability claims;
- cancellation propagated where supported;
- no generic exactly-once claim without host-native idempotency/transactions/fencing.

### OpenCode

The built-in runtime requires `FLOWIT_WORKFLOW_OPENCODE_URL`. Flowit pins the public npm package `@opencode-ai/sdk@1.18.23`, which is the SDK version declared by the OpenCode source revision used for the V2 contract review. The repository no longer consumes OpenCode's internal `vendor/*.tgz` client artifact.

Runtime integration uses the public V2 SDK surface:

```text
client.v2.session.*
client.v2.skill.*
client.v2.event.*
```

The SDK remains an optional peer dependency and is dynamically imported only when the OpenCode adapter is used. `start(signal)` preflights `v2.session.active` with cancellation. Unexpected event-stream end/failure reconnects with bounded exponential backoff. Event normalization preserves `event.id`, then durable aggregate+sequence, then a deterministic canonical-content hash; wall-clock time is never trigger identity.

CI runs `scripts/check-dependency-sources.mjs` before dependency installation and rejects direct URL, Git, local-file and tarball dependency specifiers in release manifests.

### Codex

Flowit starts `codex app-server --listen stdio://` and implements bidirectional JSON-RPC. Both string and number IDs are supported. `start(signal)` owns App Server initialization and kills the child when startup is cancelled/failed. Unattended approvals fail closed unless an explicit policy handler is configured; failed/interrupted turns never report success.

### Bridge hosts

WorkBuddy/豆包 Bridge v2 separates request transport ownership from logical side-effect ownership. Per-idempotency execution leases are fenced by a short mutation mutex for renew/release/takeover.

Shared receipts are versioned, completed-only and atomically published from a fully written/fsynced temporary inode. Invalid receipts are quarantined. Retryable failures remain per-request outbox errors and cannot poison future retries. Successful receipt replay repairs Session summary state before returning.

See `integrations/bridge/PROTOCOL.md`.

## State-path compatibility

v0.4 default storage is `~/.flowit-workflow/instances/default/workflow.json`. Automatic default-instance migration scans every built-in v0.3 path `~/.flowit-workflow/<adapterId>/workflow.json`, independent of the current default Adapter.

Migration atomically occupies each legacy `daemon.pid` path using the v0.3 ownership convention before reading legacy databases. One non-empty state migrates; multiple structurally equal states migrate once; differing non-empty states fail closed. Explicit/offline migration is available through `flowit-workflow migrate --legacy-storage=...`.

## Retention

Core terminal event receipts are bounded (default 100,000 / 90 days). This controls JSON Store growth and makes replay deduplication explicitly retention-bounded. Current Schedule occurrence receipts are protected until Schedule state advances.

## Release evidence

OpenCode and Codex remain Experimental until:

1. pinned host contract tests execute successfully;
2. real host/App Server E2E executes successfully;
3. repository CI actually executes `typecheck → unit/recovery → host-contract → build`;
4. a reviewed `pnpm-lock.yaml` exists and the frozen-lockfile gate is green.

A GitHub Actions run with `runner_id=0` and `steps=[]` is neither code-failure evidence nor passing evidence.
