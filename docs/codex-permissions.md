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

Codex `thread/start` and `thread/resume` responses report the active approval and sandbox policy. Flowit compares that lifecycle state with the approved envelope before any task turn begins.

The stable Codex App Server v0.152.0 lifecycle request accepts `sandbox: SandboxMode` plus generic configuration. It has a typed `sandbox_workspace_write` configuration, but no stable field that can encode `readOnly(networkAccess=true)`. The full structured `SandboxPolicy` belongs to `turn/start`.

Flowit therefore separates two checks:

```text
thread/start / thread/resume
→ approvalPolicy must remain exactly never
→ sandbox type must match
→ lifecycle policy must never be broader than the grant
→ workspaceWrite remains exact because the stable config can express it
→ approved readOnly(networkAccess=true) may bootstrap as readOnly(false)

turn/start
→ send the complete exact approved sandboxPolicy
→ no task work begins before this request
```

A newly created managed Session is archived before Run admission if its lifecycle is broader or structurally incompatible. Every `turn/start` repeats the complete approved `sandboxPolicy`, so read-only network access is enabled only at the execution boundary and later Pipeline nodes cannot silently drift.

`thread/start`, every permission-bound `thread/read` (including executable probing and post-turn readback), and `thread/resume` must still report the exact approved `dedicatedCwd`. A mismatch keeps the deterministic `PERMISSION_UNAVAILABLE` classification instead of being wrapped as a retryable Host outage. If an exact model is rerouted, Flowit immediately interrupts that specific turn rather than waiting for the replacement model to finish and applying a post-hoc error.

The Host contract suite pins the relevant upstream v0.152.0 schema facts in `tests/fixtures/codex-app-server-v0.152.0-sandbox-contract.json`; the fake Host derives lifecycle state from the outbound request instead of being injected with the expected answer.

Execution evidence records the requested and granted capabilities, sandbox mode, network flag, writable roots, grant source and envelope digest. This allows `run_once_get` and durable node checkpoints to distinguish user approval from model intent and Host enforcement.

## Review regression gates

The Host contract suite preserves the execution-side invariants independently of grant signing:

```text
readOnly offline approved → lifecycle reports network on → reject and archive
readOnly online approved  → lifecycle reports network off → accept narrower bootstrap
readOnly online approved  → first turn omits exact online policy → contract test fails
approved dedicatedCwd     → thread/start cwd drifts → reject before Run admission
approved dedicatedCwd     → any thread/read drifts → reject before Skills or turn/start
approved dedicatedCwd     → thread/resume cwd drifts → reject before turn/start
exact model X             → Host reroutes X to Y → interrupt the exact turn before completion
journaled Session cwd      → differs after restart → refuse recovery admission
```

The lifecycle check is no-broader-than-approved where the stable protocol cannot express the full envelope. The actual task boundary remains exact: every turn carries the complete user-approved structured policy.

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
