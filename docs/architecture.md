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
      ┌────────┬──────────┬───────┼───────┬───────────┬───────────┐
      │        │          │       │       │           │           │
     DSH    Claude     OpenCode  Codex  WorkBuddy   豆包办公    future hosts
    Full     Full        Full     Full    Hybrid      Bridge
```

The Core must not import host-specific SDKs. Every host lives below the `AgentAdapter` boundary.

## Core ownership

The Core owns only orchestration facts:

- scheduled task definitions and next-fire state;
- pipeline DAG definitions and run records;
- cross-session/context references;
- requested Skill names;
- adapter selection and normalized session identity.

The Core does **not** own host transcripts, model configuration, host permissions, Skill bodies, user authentication, or host credentials.

## AgentAdapter

Every adapter exposes:

- `listSessions()` — discover host sessions usable as targets/context;
- `dispatch()` — run one normalized task in one target session/runtime;
- optional `subscribe()` — produce normalized lifecycle/completion events;
- capability metadata for cold resume, live dispatch, Skill binding, context-reference fidelity, and event subscriptions.

`AutomationTarget.adapterId` selects the host. If omitted, Core uses the configured default adapter.

Capabilities are contractual. `coldResume=true` requires an actual programmatic resume/start path; a similar-looking UI feature is insufficient. Pipeline event wiring only attaches to adapters that declare `eventSubscription=true`.

## Host implementations

### DeepSeek Harness

Reference-native adapter: live Agent lookup, `ctx.agents.resume()`, target-scoped `ctx.skills`, immutable `dsh-session:` references and Session events.

### Claude Code

Public CLI/Hooks pilot: cold Session execution through `claude --resume`, durable Hook journal/cursor, bounded context summaries, and a wrapper Skill that produces structured Skill-binding attestation.

### OpenCode V2

Full adapter over `@opencode-ai/client`: Session list/get/prompt/wait/context, Skill catalog resolution and event subscription. If no server URL is supplied, `@opencode-ai/client/service` may ensure a compatible local service. The V2 API remains beta, so this code is isolated in one adapter.

### Codex

Full adapter over `codex app-server --stdio`: v2 thread list/resume/read, turn start/completed notifications, and `skills/list`. Bound Skills are represented as typed `skill` turn input items, keeping Skill resolution native to Codex.

### WorkBuddy

Hybrid adapter:

- desktop mode: Claude-compatible Hooks record lifecycle; a WorkBuddy Skill/Automation consumes an authorized file bridge;
- managed mode: a configurable external driver command represents WMA SDK/API or a maintained Host CLI bridge. Flowit does not hard-code undocumented cloud endpoints.

### 豆包办公

Bridge adapter: user-authorized local inbox/outbox plus a custom Worker Skill and host-native scheduled task. It deliberately reports no cold-resume or event-subscription capability because this repository has not pinned a stable public Session/Resume developer contract.

## Schedule Engine

Schedules are host-neutral `AutomationTarget + timing` records. The active worker reconciles disk state so a separate MCP/CLI control process can create or cancel a schedule while the daemon runs.

The JSON store uses an inter-process lock and atomic rename. A fixed-rate task that missed several intervals runs once when observed due, then advances to the next future slot instead of producing a catch-up storm.

## Pipeline Graph

A Pipeline is a DAG of `AutomationTarget` nodes. A downstream node can inherit predecessor sessions as Context Graph references. Triggers are normalized host events such as `turn_completed`, `task_completed`, or `subagent_completed`.

Creation/activation performs a second graph check at the **adapter + session** level across all active pipelines, so independently valid DAGs cannot combine into an autonomous A → B → A loop. The check and durable write occur under the same cross-process store transaction.

Event-derived runs use deterministic trigger keys. Adapters that replay events can redeliver safely because a pipeline already holding a run for the same `definitionId + triggerKey` is not executed twice.

## Context Graph

The Core stores identity references (`adapterId`, `sessionId`, optional label), not entire transcripts.

Each adapter chooses the strongest safe representation it supports:

- DSH: native immutable snapshot;
- Claude/OpenCode/Codex: bounded host-derived summary;
- WorkBuddy/豆包: bounded bridge payload;
- future cross-adapter bridge: explicit resolver/projection with provenance.

Foreign-adapter context currently fails closed. Context is background information and never carries approval or permission authority.

## Skill Binding

Core stores Skill names, not Skill bodies. Resolution happens at execution time in the target host so updated/project-local Skills remain authoritative.

- DSH: `ctx.skills` in target scope/cwd.
- Claude: wrapper Skill + structured loaded-Skill attestation.
- OpenCode: target-location Skill catalog.
- Codex: `skills/list` + typed `skill` turn items.
- WorkBuddy/豆包: host Worker must attest every requested Skill in its result.

## Multi-process model

MCP servers, host Hooks and the detached Workflow daemon may run in different processes. Therefore:

- authoritative Workflow JSON uses cross-process locking;
- bridge Session catalogs use cross-process locking;
- bridge/Hook events are append-only journals;
- event consumers use durable cursors;
- the daemon periodically reconciles schedules;
- Pipeline definition validation and writes are transactional.

This separation keeps the control plane, scheduler and Agent execution plane independently replaceable.
