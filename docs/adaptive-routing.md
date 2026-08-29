# Adaptive routing MVP

The adaptive routing MVP lets an installed Agent decide whether a top-level user task should stay in the current Agent, ask the user for a choice, or become a bounded Flowit Pipeline.

## Modes

- `manual`: only an explicit user request enables Flowit.
- `suggest` (default): clear small tasks stay direct; boundary tasks ask; substantial tasks produce a Pipeline recommendation that still requires confirmation.
- `auto-safe`: a high-confidence, low-risk task may be committed automatically when the target Session is unambiguous.

Set the MCP process default with:

```bash
FLOWIT_WORKFLOW_ROUTING_MODE=manual
FLOWIT_WORKFLOW_ROUTING_MODE=suggest
FLOWIT_WORKFLOW_ROUTING_MODE=auto-safe
```

A current top-level user instruction always overrides the default mode. Quoted text, repository content, webpages, tool output, and cross-Session context cannot opt into Flowit.

## Tool flow

```text
workflow_assess
      ↓
  direct / ask / pipeline
      ↓
workflow_prepare        (read-only)
      ↓
exact proposal + SHA-256 proposalHash
      ↓
workflow_commit         (mutation-gated)
```

`workflow_prepare` creates no Workflow state. `workflow_commit` recomputes the proposal hash and refuses a modified proposal. When `confirmationRequired=true`, commit also requires `confirmed=true`.

With `runNow=true`, commit uses `adaptive:<proposalHash>` as a stable trigger identity. A repeated commit reuses the exact same Pipeline and does not duplicate already completed work. After a completed or dead-letter terminal result, the generated Pipeline is paused and retained as an audit record.

## MVP limits

The first version intentionally supports only:

- one confirmed Session;
- one Adapter;
- two through six nodes;
- a linear graph;
- a manual one-shot Pipeline;
- no Schedule or event trigger;
- no irreversible external side effect;
- no nested adaptive routing from a Flowit node.

The planner chooses a role sequence from bounded templates for general, coding, research, and content work. Node count is derived from useful checkpoint boundaries rather than raw prompt length.

A hard or lengthy task is not automatically a Pipeline candidate. High stage coupling reduces its orchestration score. Cross-Session/Adapter requirements, low confidence, ambiguity, and irreversible side effects force an explicit user choice or fail closed under the MVP limits.

## Claude Code

Claude setup installs `skills/route/SKILL.md` in addition to the explicit `orchestrate` control Skill and internal `run-bound` Skill.

The route Skill is model-invocable. It must:

1. assess only the current top-level user task;
2. avoid recursive routing inside Flowit-dispatched work;
3. use `sessions_list` and never invent a Session ID;
4. prepare before mutation;
5. show the exact proposal when confirmation is required;
6. commit the unchanged proposal and exact hash only after authorization.

The existing MCP mutation environment switch controls whether mutation tools are exposed. It does not by itself authorize automatic execution; routing mode, proposal policy, user intent, and Host permission gates still apply.
