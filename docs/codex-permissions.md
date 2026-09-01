# Codex permission envelopes for explicit Flowit runs

This document describes how an explicit `run_once_start` request obtains bounded permission for a newly provisioned Codex Session.

## Scope

The first version supports only:

```text
workspace-read
workspace-write
network
```

It does not grant or imply:

```text
browser or Computer Use
administrator access
danger-full-access
arbitrary writable roots
external publishing or account access
cross-Adapter authority
```

## Why permission is separate from routing

A model-provided capability list is a request, not authorization.

```text
routing decision
= should this task use Flowit?

execution grant
= did the user approve this exact resource envelope?
```

Claude routing authority and Codex execution grants therefore use separate contracts. A Claude `callerToken` cannot authorize Codex, and a Codex execution grant cannot be reused as top-level routing authority.

## Approval sequence

For an explicit Codex run that requests `network` or `workspace-write`, Flowit performs:

```text
normalize the complete run input
        ↓
check requestId replay/conflict state
        ↓
construct a bounded permission envelope
        ↓
MCP elicitation/create
        ↓
user accepts the exact envelope
        ↓
issue a signed, expiring execution grant
        ↓
preflight model, Skills and Host support
        ↓
persist provisioning intent
        ↓
create the dedicated Codex Session
        ↓
run the bounded Pipeline
```

Before the user accepts, Flowit does not start the Codex Adapter, create a provisioning intent, create a Session, or admit a Run.

If the MCP client does not advertise form elicitation, a sensitive request fails with `HOST_APPROVAL_UNAVAILABLE`. Read-only offline runs do not need this additional grant.

## Fixed envelope mapping

| Requested capabilities | Thread sandbox | Turn sandbox policy | Network | Writable roots |
| --- | --- | --- | --- | --- |
| `workspace-read` | `read-only` | `readOnly` | off | none |
| `workspace-read`, `network` | `read-only` | `readOnly` | on | none |
| `workspace-read`, `workspace-write` | `workspace-write` | `workspaceWrite` | off | exact `dedicatedCwd` |
| `workspace-read`, `workspace-write`, `network` | `workspace-write` | `workspaceWrite` | on | exact `dedicatedCwd` |

The caller cannot submit raw `sandboxPolicy`, `approvalPolicy`, `writableRoots`, a prebuilt grant, or `danger-full-access`. Flowit derives these fields from the bounded capability list.

The dedicated Codex thread and every turn use:

```text
approvalPolicy = never
```

This does not mean unrestricted execution. It means that the user approves one fixed sandbox before the unattended Pipeline starts, and operations outside that sandbox fail instead of suspending a background node for an approval that no caller can answer.

## Grant binding

A grant is signed and bound to:

```text
requestId
normalized full-input digest
dedicatedCwd
requested capabilities
permission-envelope digest
expiry
```

Consequences:

```text
same requestId + same input
→ reuse the existing grant, Session and Run

same requestId + changed goal, steps, directory or permissions
→ fail closed

copied grant + different correlation or directory
→ fail closed
```

A grant is never accepted from ordinary MCP tool arguments. It is issued only after Flowit receives an accepted elicitation response for the computed envelope.

## Host verification

Codex `thread/start` and `thread/resume` responses report the active approval and sandbox policy. Flowit compares the Host response with the approved envelope.

If the Host returns a weaker, broader or structurally different policy, Flowit fails closed. A newly created managed Session is archived before a Run is admitted whenever a policy mismatch can be identified safely.

Every `turn/start` repeats the full bounded `sandboxPolicy`; later Pipeline nodes cannot silently drift to another permission profile.

Execution evidence records the requested and granted capabilities, sandbox mode, network flag, writable roots, grant source and envelope digest. This allows `run_once_get` and durable node checkpoints to distinguish user approval from model intent and Host enforcement.

## Failure behavior

| Condition | Result |
| --- | --- |
| User declines or cancels | No Session, intent or Run is created |
| Elicitation times out | Fail closed before Host startup |
| Client lacks elicitation | Sensitive run is rejected |
| Same requestId changes permissions | Request conflict; no second Session |
| Codex does not support required policy fields | `HOST_VERSION_INCOMPATIBLE` |
| Codex reports a mismatched active policy | Managed Session archived; no Run admitted |
| A node asks for permission beyond the envelope | Request is declined and the node fails |

## Current non-goals

This contract does not yet provide domain allowlists, browser authorization, arbitrary filesystem roots, persistent scheduled provisioning, per-node Sessions, cross-Host execution, automatic Codex upgrades, or a Host-neutral adaptive-routing confirmation protocol.
