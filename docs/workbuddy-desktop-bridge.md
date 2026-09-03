# WorkBuddy Desktop Bridge execution safety

WorkBuddy has two distinct Flowit execution modes:

```text
managed-agent-driver
= event-driven command integration
= preferred for unattended execution

desktop-bridge
= file transport plus on-demand WorkBuddy Skill invocation
= no automatic model polling
```

## Do not schedule the Bridge Worker as a recurring model task

A WorkBuddy native Automation creates an Agent task before the Bridge Worker can inspect the inbox. Consequently, a periodic Automation produces a visible WorkBuddy session and consumes model quota even when:

```text
~/.flowit-workflow/bridges/workbuddy/inbox/
```

is empty.

The instruction “exit silently when the inbox is empty” can reduce output, but it cannot prevent WorkBuddy from creating the Automation task. High-frequency polling can therefore produce hundreds of empty sessions and contribute to rate limiting.

Flowit no longer recommends model-powered periodic inbox polling.

## Immediate migration for existing installations

1. Pause or remove every recurring WorkBuddy Automation that invokes `Flowit Workflow Bridge Worker`.
2. Keep `~/.flowit-workflow/bridges/workbuddy/`; it may contain pending requests, receipts, cancellation records, and execution claims.
3. Run `flowit-workflow doctor workbuddy --json`.
4. For interactive use, invoke the Worker once only after a real Flowit request has been queued.
5. For unattended execution, configure `FLOWIT_WORKFLOW_WORKBUDDY_DRIVER` with a trusted event-driven command that runs only for an actual dispatch.

Do not delete or force-reset Bridge claims while a Flowit daemon, WorkBuddy Worker, or Automation may still be active.

## Installed paths

The default user-scope paths are deliberately separate:

```text
WorkBuddy MCP      ~/.workbuddy/mcp.json
Worker Skill       ~/.codebuddy/skills/flowit-workflow-bridge-worker/SKILL.md
Lifecycle Hooks    ~/.codebuddy/settings.json
Bridge state       ~/.flowit-workflow/bridges/workbuddy/
```

A prompt that points to `~/.workbuddy/skills/...` is using the wrong Skill root.

Project scope uses the corresponding `<project>/.workbuddy/` and `<project>/.codebuddy/` paths while retaining shared Bridge state under the user home.

## Failure semantics

The Worker must fail closed when it cannot prove request validity, Skill binding, lease ownership, receipt publication, or filesystem compatibility.

```text
Bridge failure
→ preserve request and durable artifacts
→ publish a request-specific error when safe
→ do not publish a completed receipt
→ do not simulate the Flowit Pipeline in the current chat
→ do not create replacement agents or research tasks
```

A current-chat manual execution may still be offered, but only as an explicit user-approved fallback and never as evidence that the Flowit run completed.

## Doctor interpretation

Without `FLOWIT_WORKFLOW_WORKBUDDY_DRIVER`, setup remains `manual-action-required`:

```text
transportConfigured = true
eventDrivenExecution = false
recurringModelPolling = unsupported
```

The MCP entry, Worker Skill, Hooks, and Bridge directories can all be installed correctly while unattended execution is still unavailable. `installed` and `execution-ready` are separate states.

## Future direction

The long-term WorkBuddy integration should use an event-driven managed driver backed by a documented WorkBuddy or CodeBuddy programmatic interface. Such a driver should start one Host task only for a real Flowit dispatch and should keep lease, receipt, retry, and quota handling in deterministic code rather than in a model prompt.
