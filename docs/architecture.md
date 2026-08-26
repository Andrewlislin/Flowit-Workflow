# Architecture

Flowit Workflow is an **agent orchestration runtime**, not a DeepSeek Harness feature wrapper.

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
                  ┌───────────────┴───────────────┐
                  │                               │
          DeepSeek Harness                  Claude Code
             adapter                        pilot adapter
                  │                               │
        native sessions/skills          hooks + MCP + Skills
        session-reference               `claude --resume -p`
```

Future adapters (Gemini CLI, OpenHands, OpenCode, WorkBuddy, Cursor, Codex) attach below the same `AgentAdapter` boundary. The Core must not import any host Agent package.

## Core ownership

The Core owns only orchestration facts:

- scheduled task definitions and next-fire state;
- pipeline DAG definitions and run records;
- cross-session/context references;
- requested Skill names;
- adapter selection and normalized session identity.

The Core does **not** own host transcripts, model configuration, host permissions, Skill bodies, or host authentication.

## AgentAdapter

Every adapter exposes:

- `listSessions()` — discover host sessions usable as targets/context;
- `dispatch()` — run one normalized task in one target session;
- optional `subscribe()` — produce normalized durable/lifecycle events;
- capability metadata for cold resume, live dispatch, Skill binding, context-reference fidelity, and event subscriptions.

`AutomationTarget.adapterId` selects the host. If omitted, the Core uses its configured default adapter.

## Schedule Engine

Schedules are host-neutral `AutomationTarget + timing` records. The active worker reconciles disk state every second so a separate MCP/CLI control process can create or cancel a schedule while the daemon is already running.

The JSON store uses an inter-process lock and atomic rename. A fixed-rate task that missed several intervals runs once when observed due, then advances to the next future slot instead of producing a catch-up storm.

## Pipeline Graph

A Pipeline is a DAG of `AutomationTarget` nodes. A downstream node can inherit predecessor sessions as Context Graph references. Triggers are normalized host events such as `turn_completed`, `task_completed`, or `subagent_completed`.

Creation/activation performs a second graph check at the **session level**, across all active pipelines, so independently valid DAGs cannot combine into an autonomous A → B → A loop. The check and durable write occur under the same cross-process store transaction.

Event-derived runs use deterministic trigger keys. Adapters that replay events can redeliver safely because a pipeline already holding a run for that `definitionId + triggerKey` is not executed twice.

## Context Graph

The Core stores identity references (`adapterId`, `sessionId`, optional label). It deliberately does not serialize entire transcripts.

Each adapter chooses the strongest safe representation it supports:

- DSH: native immutable `dsh-session:` reference snapshot;
- Claude Code pilot: bounded last-assistant-message summary captured by Hooks;
- future cross-adapter bridge: explicit resolver/projection layer.

Context is always background information; it never carries approval or permission authority.

## Skill Binding

The Core stores Skill names, not Skill bodies. Resolution happens at execution time in the target host so updated/project-local Skills remain authoritative.

- DSH resolves through `ctx.skills` with the target Agent scope and cwd.
- Claude Code routes through the private `/flowit-workflow:run-bound` Skill and requires a structured completion result that attests the Skills actually invoked.

## Multi-process model

Claude Code plugins may create one MCP process per Claude session while a detached Workflow daemon also runs. Therefore:

- durable JSON state is cross-process locked;
- the daemon periodically reconciles new schedules;
- Pipeline definition validation and writes are transactional;
- Claude Hook events are append-only JSONL;
- the daemon has one PID lease and a durable event-consumer cursor.

This is the minimum needed to make the orchestration state authoritative when control plane and execution plane live in different processes.
