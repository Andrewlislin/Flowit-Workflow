# Adaptive routing MVP

Adaptive routing lets an installed Agent decide whether a top-level task should remain in the current Agent, be presented as a choice, or be prepared as a bounded Flowit run-once Pipeline.

The MVP is deliberately conservative. It does not treat model output as routing authority, and it does not install generated one-off work as a permanent PipelineDefinition.

## Decision flow

```text
top-level user task
        ↓
trusted Host authority, when available
        ↓
workflow_assess
        ↓
 direct | ask | pipeline
        ↓
workflow_prepare
        ↓
expiring signed proposal + exact binding fingerprint
        ↓
workflow_commit
        ↓
durable run snapshot + immediate runId
```

## Trusted authority

`FLOWIT_WORKFLOW_ROUTING_MODE` is process configuration and is never accepted as an MCP caller argument. Supported values are:

- `manual`;
- `suggest` (default);
- `auto-safe`.

The caller also cannot submit `explicitIntent` or `confidence`. A Host integration may issue an opaque HMAC token bound to the exact top-level task and a short expiry. Only that token can attest `force-flowit`, `force-direct`, `preview`, or a trusted unspecified top-level turn.

Without Host-issued authority:

- `manual` does not auto-select Flowit;
- `suggest` can recommend or prepare work, but commit requires confirmation;
- `auto-safe` cannot enable automatic execution.

`FLOWIT_WORKFLOW_ROUTING_AUTHORITY_SECRET` may provide a shared secret for a Host integration. It must contain at least 32 bytes. Without it, the MCP process uses an ephemeral secret, so assessment tokens remain valid only for that process lifetime.

## Fail-closed signals

Model-supplied semantic signals are advisory. They are merged with deterministic text rules so that supplied values can increase, but never lower, these hard boundaries:

- irreversible side-effect risk;
- cross-Session need;
- cross-Adapter need;
- ambiguity;
- tight coupling.

For example, a task containing production deployment or customer notification remains `irreversible` even when the caller supplies `sideEffectRisk=none`.

`workflow_assess` returns a signed assessment token. `workflow_prepare` consumes that token rather than accepting a reconstructed assessment. `workflow_commit` validates the same token, expiry, proposal hash, and executable content.

## Binding preflight

Preparation starts the selected Adapter only for read/preflight operations, lists Sessions, and requires exactly one matching `{adapterId, sessionId}`. It rejects:

- missing or duplicate Sessions;
- ended or unknown Sessions;
- live Sessions when the Adapter has `liveDispatch=false`;
- idle Sessions that are neither resumable nor dispatchable;
- requested Skills without an Adapter-level preflight contract.

The proposal records the full Session descriptor, Adapter capabilities, normalized Skill list, and a SHA-256 fingerprint. Commit performs the same preflight again before any Workflow mutation. Any change requires a new assessment and proposal.

Current generic adapters do not expose a portable Skill-enumeration contract. Therefore the adaptive MVP uses an empty Skill list unless an Adapter implements `validateSkillBindings()`.

## Durable run-once execution

Commit does not call `pipelines.create()`. It atomically persists one `AutomationRunRecord` containing:

- a stable adaptive definition/trigger identity;
- the executable Pipeline snapshot;
- lease ownership and expiry;
- attempt count;
- node checkpoints;
- permanent terminal dedupe identity.

The first claim and executable intent are written in one Store transaction. If the process dies immediately afterward, an active Flowit worker can reclaim the expired lease and execute the persisted snapshot. No entry is added to `state.pipelines`.

Transient failures retain a retry boundary in the leased run; terminal completion or dead-letter writes the normal bounded terminal receipt. Runs remain subject to existing run-history retention, while terminal dedupe remains subject to terminal-receipt retention.

`workflow_commit` returns immediately with a `runId`. Use `workflow_run_get` to read status and node checkpoints. Start the detached daemon when the work must survive the current MCP process and no other active worker is available.

## MVP limits

The generated graph is restricted to:

- one Adapter;
- one exact Session;
- 2–6 nodes;
- a connected linear graph;
- manual run-once activation;
- no caller-supplied context references;
- no nested adaptive routing;
- no irreversible external side effects.

Persistent Pipelines, Schedules, event triggers, cross-Session graphs, cross-Host execution, approval nodes, and parallel ready-set execution remain separate explicit features.
