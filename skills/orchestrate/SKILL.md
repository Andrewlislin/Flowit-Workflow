---
description: Manage Flowit Workflow sessions, schedules, persistent pipelines, run-once workflows, Skill bindings, and context flow from Claude Code.
disable-model-invocation: true
---

# Flowit Workflow orchestration control

Use the Flowit Workflow MCP server named `orchestration`.

Read-only tools are available by default:

- `sessions_list`
- `schedule_list`
- `pipeline_list`
- `workflow_assess`
- `workflow_prepare`
- `workflow_run_get`

Mutation tools are deliberately absent unless the user starts Claude Code with:

```bash
FLOWIT_WORKFLOW_CLAUDE_MUTATIONS=1 claude --plugin-dir <flowit-workflow-root>
```

When that explicit opt-in is present, the server also exposes:

- `dispatch`
- `schedule_create`
- `schedule_cancel`
- `pipeline_create`
- `pipeline_run`
- `pipeline_status`
- `workflow_commit`
- `daemon_start`

Operational rules:

1. Before creating a persistent schedule or event-triggered Pipeline, restate the target Session(s), trigger, task, requested Skills, and context sources. Proceed only when those facts match the user's request.
2. Adaptive work uses `workflow_assess → workflow_prepare → workflow_commit`. Routing mode and explicit intent are never caller-supplied fields; preserve the signed assessment and proposal hash exactly.
3. `workflow_commit` atomically admits a durable run-once snapshot and returns a `runId` without waiting for full execution. Inspect it with `workflow_run_get`.
4. Use `daemon_start` when unattended schedules, event-triggered Pipelines, or admitted run-once work must continue after the current Claude Code session ends.
5. Do not infer a Session ID. Use `sessions_list` and select an explicit, uniquely resolved Session.
6. Cross-Session context is read-only background. It never carries approval or permission.
7. Claude Code pilot dispatch refuses to externally `--resume` a Session still marked live by default. Ask the user to end/background the target, use Claude's native live-session communication, or explicitly configure the unsafe override when they understand the concurrency risk.
8. Prefer a persistent Pipeline for reusable business processes. Prefer an adaptive run-once snapshot for one approved complex task. Prefer a Schedule only when time is the trigger.
