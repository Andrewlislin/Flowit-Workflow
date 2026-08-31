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
