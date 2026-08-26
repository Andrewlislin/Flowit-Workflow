# Flowit Workflow for DeepSeek Harness

A DeepSeek Harness plugin bundle that adds four orchestration primitives without importing Flowit Desktop or Flowit Runtime:

- **Cross-session orchestration** — dispatch work to another DSH Session, resuming cold Sessions through `ctx.agents.resume()` when needed.
- **Durable scheduling** — persist one-shot/fixed-rate tasks in `.dsh/flowit-workflow.json` and wake the target Session when due.
- **Skill binding** — resolve Skill bodies at execution time against the target Agent's `cwd` and Agent scope; task definitions store names, not copied Skill text.
- **Context flow** — use DSH's canonical `dsh-session:` references so another Session enters as a bounded, read-only snapshot rather than copied transcript text.

The implementation targets DeepSeek Harness `0.1.1-rc.2` seams: `ctx.agents`, `ctx.skills`, `ctx.sessionReferenceResolver`, `ctx.tools`, `session/event`, `Agent.followup()`, `Agent.inject()`, and session persistence.

## Architecture

```text
                         @coaseedge/dsh-flowit-workflow
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
              DurableScheduler   PipelineRuntime   DshTargetDispatcher
                    │                 │                 │
             JSON durable state  session/event     ctx.agents
                    │             turn/end          ctx.skills
                    │                 │             session-reference
                    └──────────────┬──┴─────────────────┘
                                   │
                             target DSH Session
```

The first release deliberately keeps orchestration state outside the DSH transcript. DSH remains the authority for Session history; this plugin owns only automation definitions and run audit records.

## Install

After publishing:

```bash
pnpm add @coaseedge/dsh-flowit-workflow
```

For development from this repository, use it as a local or Git dependency. The package has a `prepare` script that builds TypeScript before Git-package installation.

## Cordis / DSH wiring

Load the package after the DSH services it uses (`agents`, `tools`, `skills`, `sessionReferenceResolver`, `sessionPersistence`). A representative plugin config is:

```yaml
plugins:
  "@coaseedge/dsh-flowit-workflow":
    storageFile: ".dsh/flowit-workflow.json"
    minimumIntervalSeconds: 60
    allowModelMutations: false
```

`allowModelMutations` defaults to **false**. When false, the plugin exposes read-only list/context-discovery tools but does not let the model create future autonomous work. Enable it only in a deployment where DSH's tool approval/policy layer explicitly covers these mutation tools.

## Model-facing tools

Read-only tools are always registered:

- `flowit_schedule_list`
- `flowit_pipeline_list`
- `flowit_context_candidates`

When `allowModelMutations: true`:

- `flowit_dispatch_session` — immediate cross-session dispatch with Skill + context bindings.
- `flowit_schedule_create` / `flowit_schedule_cancel` — durable background tasks.
- `flowit_pipeline_create_linear` — create the common A → B → C pipeline. Each downstream node receives the upstream Session as a DSH session-reference.
- `flowit_pipeline_run` — manual execution.

Programmatic DSH plugins can inject `flowitWorkflow` and call `ctx.flowitWorkflow.scheduler` / `ctx.flowitWorkflow.pipelines`; standalone callers can also use the exported runtime/classes to create arbitrary DAG pipelines; the model-facing first version exposes a linear builder to keep schemas and review simple.

## How Skill binding works

A definition persists only names:

```json
{
  "skills": ["industry-research", "wechat-writer"]
}
```

At execution time the dispatcher resolves each Skill with the target Agent's current `cwd` and Agent scope, checks that it is model-invocable, then injects the canonical DSH `renderSkillContent()` output. Skill updates therefore apply to future runs without rewriting schedules/pipelines.

## How context flow works

A task stores Session references:

```json
{
  "contextRefs": [
    { "sessionId": "industry-research", "label": "AI industry research" }
  ]
}
```

The dispatcher formats canonical `dsh-session:` mentions into the direct user follow-up. DSH's `session-reference` plugin resolves those mentions during `agent/pre-step` into its bounded, immutable read-only snapshots.

For GUI interaction, a later client plugin can map drag/drop to the exact same representation:

```text
Drag Session A → Composer / Pipeline node
              ↓
formatSessionReferenceMention(...)
              ↓
canonical dsh-session reference
```

The transport semantic is therefore independent of whether the UI uses drag/drop, `@Session` autocomplete, a context chip, or a pipeline editor.

## Pipeline semantics

A pipeline is a DAG. V0.1 executes nodes in deterministic topological order. For each node:

1. Resolve/resume the target Session.
2. Load bound Skills against that Session.
3. Add declared context references.
4. Add predecessor Sessions as read-only context when `inheritUpstreamContext=true`.
5. `followup()` the task and wait for `agent.whenIdle()`.
6. Continue to the next node.

A pipeline may be manual or triggered by a successful `turn/end` on a source Session. Node DAG cycles are rejected, and event-triggered pipelines are additionally checked as one global Session-level trigger graph, preventing A ↔ B loops assembled across multiple pipelines.

## Scheduling semantics

- `at`: one-shot future ISO timestamp.
- `every`: fixed interval, minimum 60 seconds by default.
- Missed fixed-rate intervals collapse to the next future occurrence; the scheduler does not replay a catch-up storm.
- The DSH host process must be running. This plugin can resume a cold Session, but it is not an OS-level daemon that starts DeepSeek Harness itself.

## Persistence

Default file:

```text
.dsh/flowit-workflow.json
```

Writes use temp-file + rename and mutations are serialized. The file contains:

```text
version
schedules[]
pipelines[]
runs[]
```

Run history is bounded (`maxRunHistory`, default 500).

## Safety boundary

Future autonomous execution is more sensitive than an ordinary one-turn tool call. V0.1 therefore uses three constraints:

1. Model mutation tools are opt-in (`allowModelMutations=false` by default).
2. Pipeline graphs are acyclic.
3. Session context is DSH read-only session-reference data; referenced content cannot directly become an authorization source.

A production UI should add an explicit human confirmation record for background Autopilot-style tasks if the deployment intends to grant stronger-than-normal tool authority. Do not treat generic prior `write` approval as consent for recurring autonomous work.

## Development

```bash
pnpm install
pnpm check
pnpm build
```

Pure domain/store tests do not require a running DSH host. Integration tests against a real Harness composition are the next milestone.

## Current limitations

- No visual DSH Web Client drag/drop adapter yet; native `@Session`/session-reference semantics are already used underneath.
- Pipeline execution is deterministic sequential DAG execution; parallel fan-out/join is deferred.
- The host process must stay alive for timers.
- No per-definition human-consent ledger is implemented yet; model mutation registration remains opt-in for that reason.
- Real DSH integration CI should be added by testing this package inside a pinned DeepSeek Harness checkout.
