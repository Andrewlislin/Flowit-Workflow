# Execution preflight and Codex dedicated Session support

This change introduces a common execution contract for runtime requirements and dedicated Session plans, with Codex as the first complete Adapter implementation.

Highlights:

- model/reasoning match policy becomes signed proposal content;
- `workflow_prepare` performs read-only execution preflight;
- `workflow_commit` creates dedicated Sessions only after confirmation;
- the real Session id is materialized into the durable run snapshot;
- Codex validates `model/list`, creates with `thread/start`, and sends explicit model/effort on `turn/start`;
- multiple Codex executable candidates can be configured;
- `notLoaded` Codex threads are correctly treated as resumable idle Sessions;
- execution evidence is checkpointed with node results;
- two-node coding proposals now include an executor instead of skipping directly from planner to reviewer.

See `docs/execution-preflight.md` and `docs/adapter-contract.md` for the contract and lifecycle.


Follow-up hardening adds a Workflow State v2 mixed-version fence, a durable provisioning journal, receipt-only replay, runtime-aware executable reselection after ordinary startup, and fail-closed Codex capability preflight.

- enforce exact/preferred runtime and capability contracts in the shared Core dispatcher for every execution path;
- retain one Codex App Server client per executable so runtime selection cannot interrupt unrelated Sessions or detach event subscriptions;
- distinguish Codex catalog `id` from the actual `model` override and reject exact reasoning requests not present in the advertised effort list;
- make `inherit`, `exact`, and `preferred` runtime policies structurally disjoint during normalization.

- Host runtime evidence is rebuilt from `thread/start` / `thread/resume` responses rather than backfilled from catalog selection; nullable reasoning effort fails exact/preferred evidence checks.
- Codex `model/rerouted` notifications are tracked per executable/thread/turn: exact substitutions fail the node, while preferred/inherit evidence records the final routed model.
- Model catalog preflight follows `nextCursor` pagination and Core independently checks exact/preferred actual evidence.
