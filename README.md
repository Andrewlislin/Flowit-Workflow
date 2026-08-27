# Flowit Workflow

**Flowit Workflow is an agent-agnostic orchestration layer for long-lived Agent sessions.**

It provides four host-neutral primitives:

- **Durable Schedule Engine** — run work later or on a fixed cadence.
- **Pipeline / Work Graph** — move work across sessions/hosts in a DAG.
- **Skill Binding** — resolve named Skills at execution time.
- **Context Graph** — pass bounded, read-only context references between sessions.

Host authentication, transcripts, permissions, sandboxes and model configuration remain authoritative in each Agent host.

## Support matrix

| Host | Release level | Dispatch | Skill | Context | Events |
| --- | --- | --- | --- | --- | --- |
| DeepSeek Harness | Reference | native live/cold Session | native | native snapshot | native |
| Claude Code | Pilot | public `--resume` path | verified wrapper Skill | bounded summary | durable Hooks journal |
| OpenCode V2 | **Experimental** | pinned generated Session API | generated Skill catalog | bounded Session context | generated event stream |
| Codex | **Experimental** | App Server v2 thread/turn API | typed `skill` item | bounded thread summary | App Server notifications |
| WorkBuddy | Hybrid | bridge or configured enterprise driver | WorkBuddy Skill | bounded summary | Hooks/bridge |
| 豆包办公 | Bridge | host Worker only; no public Session resume claimed | custom Skill | bounded summary | no public event API claimed |

OpenCode and Codex remain **Experimental** until pinned host-contract tests and real hosted E2E execute successfully.

## Architecture

```text
                         Flowit Orchestration Core
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
 Durable Schedule            Pipeline / Work Graph     Context Graph
        │                         │                         │
        └────────────────── Skill Binding ─────────────────┘
                                  │
                         AgentAdapter contract
                                  │
  DSH / Claude / OpenCode / Codex / WorkBuddy / 豆包办公 / future hosts
```

Workflow definitions store references, not copied Skill bodies or entire transcripts.

## Durable execution semantics

Flowit uses **at-least-once** execution semantics. It does not claim generic exactly-once side effects.

### Schedule occurrences

A Schedule occurrence is claimed only in a Store transaction that simultaneously verifies:

```text
Schedule exists
status == active
nextRunAt == expected occurrence
trigger is still claimable
```

A claimed run carries owner/lease/heartbeat state. Failed work may retry; stale running work may be reclaimed; Pipeline node checkpoints survive attempts.

### Event Pipeline admission

Host event receipt and Pipeline business execution are deliberately separated:

```text
host event arrives
      ↓
match active Pipelines
      ↓
ONE Store transaction
persist eventInbox rows for every matching Pipeline
      ↓
host listener may return
      ↓
worker claims durable admission → running lease
      ↓
execute / retry / checkpoint
```

Therefore an event queued behind a long-running Pipeline is not only an in-memory Promise. If the daemon exits after admission but before execution, the next Core instance sees `eventInbox` and resumes it.

A failing Pipeline is isolated from siblings matching the same event. OpenCode event consumption reconnects with bounded exponential backoff after stream failure, but reconnect is not used as a substitute for Flowit's own durable admission.

### Terminal dedupe retention

`runs[]` is bounded audit/recovery history. Terminal Pipeline receipts are stored separately, but are also intentionally bounded instead of growing forever.

Defaults:

```text
maxTerminalReceipts = 100000
terminalReceiptRetentionMs = 90 days
```

The earliest limit reached may evict an old event receipt. Active Schedule-occurrence receipts needed to close the crash-after-complete/before-advance window are protected until the Schedule advances. This means old event replay deduplication is a **bounded retention guarantee**, not permanent exactly-once delivery.

## Adapter lifecycle and daemon readiness

`AgentAdapter` may implement:

```ts
start?(signal?: AbortSignal): Promise<void> | void
```

Lifecycle state is tracked per registered Adapter instance, not only by string ID. Unregistering an Adapter aborts that generation; registering another Adapter with the same ID gets a new lifecycle. Control-plane host operations lazily call Adapter startup before `listSessions`/dispatch.

For an active daemon, `core.ready` means:

1. durable storage load/migration succeeded;
2. enabled Adapter preflights succeeded;
3. Pipeline event subscriptions were attached;
4. recoverable work was reconciled;
5. Scheduler startup completed.

`dispose()` aborts startup before stopping workers and disposing adapters. OpenCode startup passes the abort signal to its service request; Codex startup passes it into App Server initialization and terminates the child on cancellation.

Detached startup uses an atomic readiness file. Partial JSON is treated as not-yet-published state. On readiness failure/timeout the parent sends `SIGTERM`, waits a bounded grace period, then escalates to `SIGKILL` (process-group signalling on POSIX) if the child still exists. A stale storage daemon lease is subsequently recoverable from its dead PID.

MCP `daemon_start` delegates to this same CLI `--detach` lifecycle.

## v0.3 → v0.4 storage migration

v0.4 default state is:

```text
~/.flowit-workflow/instances/<instanceId>/workflow.json
```

v0.3 stored state by default Adapter:

```text
~/.flowit-workflow/<adapterId>/workflow.json
```

For `instanceId=default` without an explicitly configured storage path, Flowit scans **all built-in legacy Adapter paths**, not only the current default Adapter.

Migration rules:

```text
no non-empty legacy DBs             → normal new storage
one non-empty legacy DB              → migrate + archive legacy
multiple semantically equal DBs      → migrate once + archive all
multiple different non-empty DBs     → fail closed
new non-empty DB differs from legacy → fail closed
```

State equivalence uses structured deep equality, not JSON property order.

Migration acquires the legacy v0.3 `daemon.pid` paths with the same `open(..., 'wx')` ownership primitive used by v0.3 before touching legacy database files. A live old daemon therefore blocks migration, while the migration guard prevents an old daemon from starting in the check/use gap.

For explicit/offline migration:

```bash
flowit-workflow migrate --instance=default
flowit-workflow migrate --instance=default \
  --legacy-storage=/path/a/workflow.json \
  --legacy-storage=/path/b/workflow.json
```

`FLOWIT_WORKFLOW_LEGACY_STORAGE_FILES` can also provide explicit legacy paths. Explicit `FLOWIT_WORKFLOW_STORAGE_FILE` does not trigger automatic legacy discovery.

## Generic control plane

```bash
FLOWIT_WORKFLOW_INSTANCE_ID=research \
FLOWIT_WORKFLOW_ADAPTER=codex \
flowit-workflow daemon --adapter=codex --instance=research --detach

FLOWIT_WORKFLOW_ADAPTERS=opencode,codex \
flowit-workflow daemon --adapter=opencode --adapters=opencode,codex
```

Mutation-capable MCP tools remain opt-in with `FLOWIT_WORKFLOW_MUTATIONS=1`.

## OpenCode V2 — Experimental

Flowit follows the pinned generated plural client contract:

```text
OpenCode.make(...)
client.sessions.*
client.skills.*
client.events.*
```

There is no `/service` runtime import. `FLOWIT_WORKFLOW_OPENCODE_URL` is required. The Adapter preserves host event `id`, then durable aggregate/sequence identity, then a deterministic canonical-content hash. Deprecated `session.idle` and current `session.status` idle both normalize to `turn_completed`.

`start(signal)` preflights the service with that signal. Unexpected SSE termination reconnects with bounded exponential backoff.

## Codex — Experimental

Flowit uses:

```text
codex app-server --listen stdio://
```

The client handles responses, notifications and server-initiated requests; JSON-RPC IDs are `string | number`; unattended approval defaults fail closed; only `completed` is success. Request/turn deadlines, `turn/interrupt`, process-exit rejection and forced shutdown remain enabled. App Server initialization is part of `start(signal)` and therefore part of active daemon readiness.

## Bridge protocol v2

Bridge transport ownership (`requestId`) and side-effect ownership (`idempotencyKey`) are separate. Renew/release/expired takeover of an execution lease are serialized by a short per-key mutation mutex, and an expired old owner cannot renew itself.

Shared receipts are now versioned **completed-only** records:

```json
{
  "version": 1,
  "idempotencyKey": "...",
  "status": "completed",
  "completedAt": "...",
  "result": {}
}
```

A successful receipt is fully written to a temporary file, flushed, then atomically published to the final path with no-replace semantics. Malformed/wrong-key receipts are quarantined and do not poison future attempts. Retryable failures are written only to the current request outbox; they never become a shared terminal receipt.

Successful receipt replay also restores the Session summary catalog before returning, so a crash after receipt publication but before `sessions.json` update does not break downstream Context references.

See `integrations/bridge/PROTOCOL.md`.

## DeepSeek Harness / Claude Code

The DSH reference remains available from `@coaseedge/flowit-workflow/dsh`. The repository also remains a Claude Code plugin root with Hooks, MCP and bound-run Skills.

## Development and release evidence

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:host-contracts
pnpm build
```

Unit/recovery tests live in `tests/*.test.ts`; host contract tests live separately in `tests/contracts/*.test.ts`.

The repository still does **not** contain `pnpm-lock.yaml`. CI therefore has two distinct signals: a non-frozen code-validation job and a `release-lockfile` gate that requires a real lockfile plus `pnpm install --frozen-lockfile`. A reviewed lockfile is still a merge/release requirement.

GitHub-hosted Actions for this repository have also failed before runner allocation (`runner_id=0`, `steps=[]`) in prior heads. Such runs are neither passing evidence nor code-failure evidence. Do not treat this PR as release-ready until a working runner executes the validation chain and the lockfile gate is green.

## License

MIT
