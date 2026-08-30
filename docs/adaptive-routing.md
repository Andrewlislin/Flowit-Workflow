# Adaptive routing MVP

Adaptive routing lets an installed Agent decide whether a top-level task should remain in the current Agent, require a user choice, or become a bounded Flowit run-once Pipeline.

The MVP is conservative in three places:

1. routing mode and explicit user intent are not model-supplied;
2. an `ask` decision and the final proposal confirmation require Host-issued proof;
3. approved one-off work is stored as a durable run snapshot, not a permanent `PipelineDefinition`.

## Claude Code decision flow

```text
Claude UserPromptSubmit
        ↓
exact top-level prompt + Claude Session id
        ↓
Host-private HMAC authority token
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
        ↓
user replies “确认执行”
        ↓
UserPromptSubmit signs proposalHash
        ↓
workflow_commit(confirmationToken)
        ↓
durable run snapshot + immediate runId
```

`workflow_run_get` reads progress and node checkpoints without holding the commit call open.

## Trusted authority

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

The Hook and MCP process share a private key under:

```text
~/.flowit-workflow/claude/routing-authority/
  secret.key
  pending.json
```

The directory and key may be overridden with:

```text
FLOWIT_WORKFLOW_ROUTING_AUTHORITY_DIR
FLOWIT_WORKFLOW_ROUTING_AUTHORITY_SECRET_FILE
FLOWIT_WORKFLOW_ROUTING_AUTHORITY_STATE_FILE
```

The secret is generated with exclusive creation and stored with owner-only permissions where the platform supports POSIX modes. The secret is not written into `.mcp.json`.

## User choices and proposal confirmation

A model cannot authorize mutation by passing `confirmed=true`.

When an assessment returns `ask`, Flowit stores a short-lived Host-private routing challenge keyed by Host and Claude Session. A subsequent exact choice (`1`, `2`, or `3`, or the corresponding text) is processed by `UserPromptSubmit`, which issues a new token bound to the original task.

When `workflow_prepare` returns an executable proposal, it registers a second short-lived challenge containing:

- `proposalHash`;
- Host / Session context;
- expiry;
- random challenge nonce.

The user must reply `确认执行` to mint a `confirmationToken`. `workflow_commit` verifies that the token is unexpired and matches both the exact `proposalHash` and the Host context carried by the signed assessment. `取消` clears the pending proposal without Workflow mutation.

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
