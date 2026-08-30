# Adaptive routing MVP

Adaptive routing lets an installed Agent decide whether a top-level task should remain in the current Agent, require a user choice, or become a bounded Flowit run-once Pipeline.

The MVP is conservative in four places:

1. routing mode and explicit user intent are not model-supplied;
2. an `ask` decision and the final proposal confirmation require Host-issued proof;
3. every adaptive MCP call is bound to the actual Claude Session by `PreToolUse`;
4. approved one-off work is stored as a durable run snapshot, not a permanent `PipelineDefinition`.

## Claude Code decision flow

```text
Claude UserPromptSubmit
        ↓
exact top-level prompt + Claude Session id
        ↓
Host-private HMAC authority token
        ↓
Claude PreToolUse attests the actual MCP caller Session
        ↓
workflow_assess
        ↓
 direct | ask | pipeline
        │       │
        │       └─ ask → user selects 1 / 2 / 3
        │                    ↓
        │              UserPromptSubmit signs the choice
        │                    ↓
        │              workflow_assess again
        ↓
workflow_prepare
        ↓
expiring proposal + exact binding fingerprint
+ confirmationCode derived from proposalHash
        ↓
user replies “确认执行 <confirmationCode>”
        ↓
UserPromptSubmit resolves that exact proposal
        ↓
PreToolUse attests the actual commit caller Session
        ↓
workflow_commit(confirmationToken)
        ↓
durable run snapshot + immediate runId
```

`workflow_run_get` reads progress and node checkpoints without holding the commit call open.

## Trusted authority and actual caller identity

`FLOWIT_WORKFLOW_ROUTING_MODE` is trusted process configuration and is never accepted as an MCP caller argument. Supported values are:

- `manual`;
- `suggest` (default);
- `auto-safe`.

Claude's `UserPromptSubmit` Hook receives the exact submitted `prompt` and `session_id`. It emits `additionalContext` containing an opaque task-bound token. The Hook recognizes only anchored top-level forms for:

- `force-flowit`;
- `force-direct`;
- `preview`;
- `unspecified`.

Quoted blocks, JSON envelopes, repository text, webpages, tool output, and Flowit `run-bound` prompts cannot mint an override.

A separate Claude `PreToolUse` Hook runs for `workflow_assess`, `workflow_prepare`, and `workflow_commit`. It signs:

- the actual Claude `session_id`;
- the exact tool name;
- the exact tool input;
- the Claude tool-use id;
- a short expiry and single-use nonce.

The MCP server atomically consumes this caller attestation before using routing or confirmation authority. A token created in Session A therefore cannot be replayed from Session B, even when the task, proposal, and bearer token are copied together.

## Runtime authority state

The Hook and MCP process share retained runtime state under:

```text
~/.flowit-workflow/claude/routing-authority/
  secret.key
  pending.json
```

The directory and files may be overridden with:

```text
FLOWIT_WORKFLOW_ROUTING_AUTHORITY_DIR
FLOWIT_WORKFLOW_ROUTING_AUTHORITY_SECRET_FILE
FLOWIT_WORKFLOW_ROUTING_AUTHORITY_STATE_FILE
```

The signing secret is retained runtime state, not an installer-owned plugin asset. It is not written into `.mcp.json` and is intentionally retained when the Claude plugin files are uninstalled.

On first use, secret creation is serialized by a sidecar initialization lock and published by atomic rename after the complete secret has been written and synced. Concurrent Hook and MCP startup therefore cannot observe a newly created but empty `secret.key`. A malformed or truncated existing key fails closed.

## User choices and exact proposal confirmation

A model cannot authorize mutation by passing `confirmed=true`.

When an assessment returns `ask`, Flowit stores a short-lived Host-private routing challenge keyed by Host and Claude Session. A subsequent exact choice (`1`, `2`, or `3`, or the corresponding text) is processed by `UserPromptSubmit`, which issues a new token bound to the original task.

When `workflow_prepare` returns an executable proposal, it also returns:

```text
proposalHash
confirmationCode
```

`confirmationCode` is the first 12 hexadecimal characters of the reviewed `proposalHash`, rendered in uppercase. Pending challenges are keyed by:

```text
Host + Claude Session + proposalHash
```

A new proposal does not overwrite an older unconfirmed proposal. The user must reply with an exact command such as:

```text
确认执行 7F31A2B4C9D0
取消 7F31A2B4C9D0
```

The Hook resolves only the matching pending proposal. A plain `确认执行`, an unknown code, or a code for another proposal cannot mint a confirmation token.

`workflow_commit` verifies that the confirmation token is unexpired and matches:

- the exact `proposalHash`;
- the Host context carried by the signed assessment;
- the actual current Claude caller Session attested by `PreToolUse`.

A preview-only proposal cannot be committed. The user must explicitly choose Flowit execution and obtain a new assessment.

## Safety signal merge

Model-supplied semantic signals are advisory. Hard boundaries use fail-closed merging:

- side-effect risk uses the maximum inferred/supplied risk;
- cross-Session and cross-Adapter requirements use logical OR;
- ambiguity and coupling use the maximum inferred/supplied level;
- inferred stage and durability requirements cannot be reduced.

Production deployment, external publishing/sending, payment, deletion, and cross-Host work therefore cannot be relabelled as safe by the caller.

## Exact binding preflight

`workflow_prepare` and `workflow_commit` both:

- require and start the selected Adapter;
- list Sessions and require one exact `{adapterId, sessionId}` match;
- reject ended or unknown Sessions;
- reject live Sessions when `liveDispatch=false`;
- reject idle Sessions that cannot be resumed or dispatched;
- normalize requested Skills;
- require `validateSkillBindings()` for non-empty Skill lists;
- compare a SHA-256 fingerprint over the Session descriptor, Adapter capabilities, and Skill list.

Any binding change after preparation fails before durable admission.

## Durable run-once execution

`workflow_commit` does not call `pipelines.create()`. Core atomically persists one leased `AutomationRunRecord` containing:

- stable definition and trigger identities;
- the executable Pipeline snapshot;
- attempt and lease state;
- completed node checkpoints;
- terminal dedupe identity.

Run-once lease heartbeats are fenced by run ownership rather than a permanent Pipeline definition. Existing Schedule and persistent Pipeline callers continue supplying their definition guards.

Active workers reconcile expired run-once leases from the stored snapshot. `state.pipelines` remains unchanged, and terminal replay does not repeat completed work.

## MVP limits

The MVP supports:

- one exact Session;
- one Adapter;
- 2–6 nodes;
- one connected linear graph;
- a manual run-once snapshot;
- no Schedule or event trigger;
- no caller-supplied context references;
- no irreversible external side effect;
- no nested adaptive routing.

Execution remains at-least-once. Host permissions, sandboxes, workspace trust, approvals, and host-native idempotency remain authoritative.
