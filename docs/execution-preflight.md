# Execution preflight and dedicated Sessions

Flowit previously bound an execution plan primarily to an existing `(adapterId, sessionId)`. That is sufficient for legacy Session dispatch, but it cannot faithfully represent a request such as:

```text
Use Codex with model X, high reasoning, in a clean workspace-owned Session.
Do not substitute another model.
```

The execution-preflight contract makes those requirements part of the reviewed and durable plan instead of leaving them only in natural-language prompts.

## Lifecycle

```text
workflow_assess
      ↓
workflow_prepare
      ├─ resolve existing Session, or
      └─ describe dedicated Session plan
      ↓
Adapter preflight (read-only)
      ├─ Host/executable compatibility
      ├─ model + reasoning availability
      ├─ Session state/ownership
      ├─ Skill availability
      └─ requested capability support
      ↓
proposal hash + one confirmation
      ↓
workflow_commit
      ↓
repeat preflight
      ↓
reserve a durable provisioning intent (when requested)
      ↓
provision dedicated Session
      ↓
journal the real Session id, then admit the durable run snapshot
      ↓
dispatch + checkpoint actual execution evidence
```

`workflow_prepare` does not call `provisionSession()`. A failed preflight therefore does not leave behind a user-visible Host task or an active Flowit Pipeline. Resource creation is behind the same proposal confirmation that covers the nodes, runtime, workspace and permissions.

## Runtime policy

The runtime requirement supports three policies:

- `inherit`: use the existing Host/Session configuration. No exact model claim is made.
- `exact`: the requested model and/or reasoning effort must be verified. Any mismatch blocks preparation or execution.
- `preferred`: the Adapter may accept a Host-reported substitute, but the actual runtime is recorded as evidence.

For Codex, the Adapter uses `model/list` during preflight, `thread/start` for a dedicated Session, and explicit `model`/`effort` fields at the turn boundary. Exact requests disable provider fallback.

## Existing versus dedicated Sessions

An existing target uses:

```json
{
  "adapterId": "codex",
  "sessionId": "thread-id"
}
```

A dedicated target uses:

```json
{
  "adapterId": "codex",
  "dedicatedCwd": "/absolute/workspace/path",
  "execution": {
    "runtime": {
      "model": "requested-model",
      "reasoningEffort": "high",
      "match": "exact"
    },
    "requiredCapabilities": ["workspace-write", "shell"]
  }
}
```

Exactly one of `sessionId` or `dedicatedCwd` is required.

A dedicated Session is preferable when the task requires isolation or an exact runtime. Reusing an unrelated Session is not an automatic fallback because it can introduce context contamination and different writer ownership.

## Codex executable candidates

`FLOWIT_WORKFLOW_CODEX_BIN` remains supported for one explicit executable. Multiple candidates can be supplied in priority order with `FLOWIT_WORKFLOW_CODEX_BINS`, separated by the operating system path delimiter. The Adapter selects the first candidate whose App Server starts and whose model catalog satisfies the requested runtime.

```bash
# macOS / Linux
export FLOWIT_WORKFLOW_CODEX_BINS="/path/to/new/codex:/usr/local/bin/codex"

# Windows uses the platform path delimiter.
```

Host-native permissions remain authoritative. Runtime preflight and Session provisioning do not grant filesystem, command, network, browser or approval permissions.


## Mixed-version and provisioning fencing

Execution-aware state is persisted as Workflow State version 2. Loading a version 1 database upgrades and rewrites it under the Store lock before workers continue. Older workers only understand version 1 and therefore fail closed when they observe the version 2 database instead of silently discarding `execution` requirements.

A dedicated Session is preceded by a durable provisioning intent. If the process stops after `thread/start` but before run admission, replay observes that reservation and does not create a second Session. A known provisioned Session is recoverable into the run snapshot; an unknown outcome remains `uncertain` and requires reconciliation rather than unsafe automatic retry.

Codex runtime/model preflight is supported. Requested filesystem, shell, network or browser capabilities currently fail closed because the Adapter cannot yet prove the complete effective permission and approval policy without mutating Host state. These capabilities must not be presented as verified merely because a later turn may request approval.
