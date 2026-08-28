# Flowit Presets

Presets are the product layer above Flowit's durable Pipeline primitives. A preset defines reusable **roles, prompts, artifact conventions, and graph topology**, while installation binds those roles to real host Sessions.

Presets do not create new authority. Host authentication, permissions, Skills, browsing, filesystem access, and external side effects remain controlled by the selected Agent host.

## Commands

```bash
flowit-workflow preset list
flowit-workflow preset show content-studio

flowit-workflow preset install content-studio \
  --adapter=workbuddy \
  --session=all=<session-id> \
  --input="AI engineering for enterprise readers" \
  --dry-run

flowit-workflow preset install content-studio \
  --adapter=workbuddy \
  --session=all=<session-id> \
  --input="AI engineering for enterprise readers" \
  --yes
```

`--dry-run` shows the exact workflow store, workspace, role bindings, and `CreatePipelineInput` before mutation. `--yes` is required for non-interactive pipeline creation.

Preset installation never executes the Pipeline. It creates or reuses the definition only. Running work remains an explicit later action.

## Single-session path

The simplest setup binds every role to one existing Session:

```bash
flowit-workflow preset install research-lab \
  --adapter=claude-code \
  --session=all=<session-id> \
  --input="What are the strongest technical and economic constraints on ...?" \
  --yes
```

This is especially useful for hosts where one durable Session is more reliable than targeted cold resume across many Sessions. Pipeline nodes still create explicit stage boundaries and durable checkpoints even when they dispatch sequentially to the same Session.

## Multi-session and multi-host roles

Roles can be rebound individually:

```bash
flowit-workflow preset install agent-team \
  --adapter=workbuddy \
  --session=all=<main-session> \
  --session=researcher=<research-session> \
  --role-adapter=researcher=claude-code \
  --session=reviewer=<review-session> \
  --role-adapter=reviewer=codex \
  --input="Prepare and review a migration plan" \
  --dry-run
```

Optional Skills can be bound with `--skill=all=<skill-a,skill-b>` or `--skill=<role>=<skill-a,skill-b>`. A host still fails closed at dispatch if it cannot establish a requested Skill binding.

DeepSeek Harness uses an embedded Flowit Core/store rather than the root daemon. A DSH-only preset defaults to `~/.flowit-workflow/dsh/workflow.json`, matching the setup provider. Mixed DSH/root-daemon roles are rejected as not runnable; use separate presets unless a future Context Bridge/runtime explicitly supports that topology. `--storage=<path>` can target an explicit compatible store.

## Built-in presets

### `content-studio`

Roles:

```text
Radar
  ↓
Topic Strategist
  ↓
Researcher
  ↓
Writer
  ↓
Fact Checker
  ↓
Chief Editor
```

The workflow performs current-signal discovery, weighted topic selection, evidence-first research, drafting, factual audit, and final editorial review. The generated prompts use a 100-point topic rubric:

- audience relevance — 25
- information value — 20
- timeliness — 15
- differentiation — 15
- reliable evidence — 15
- likely engagement — 10

When filesystem tools are available, durable artifacts are written under the configured workspace (`candidates.md`, `topic.md`, `research.md`, `sources.md`, `outline.md`, `draft.md`, `fact-check.md`, `final.md`). The final role explicitly does **not** publish.

### `research-lab`

Roles:

```text
Research Planner
  ↓
Researcher
  ↓
Skeptic
  ↓
Synthesizer
  ↓
Research Reviewer
```

`--input` is required and is treated as the research question. The workflow prioritizes primary evidence, separates fact/inference/analysis/uncertainty, forces a counter-evidence stage, and ends with a traceability/limitations review.

### `agent-team`

Roles:

```text
Planner
  ↓
Researcher
  ↓
Executor
  ↓
Reviewer
```

`--input` is required and becomes the team goal. This is the general-purpose preset for tasks that need explicit planning, evidence gathering, execution, and acceptance-criteria review.

## Idempotency and ownership

Preset installation does not silently replace Pipelines.

- If the generated pipeline name does not exist, Flowit creates it.
- If exactly one existing pipeline has the same name and identical semantic definition, Flowit reuses it.
- If the same name belongs to a different or ambiguous definition, installation fails closed and asks for a different `--name`.
- Installation creates the workspace directory but does not delete or overwrite workspace artifacts.
- Installation does not run a Pipeline and does not perform external publishing or irreversible side effects.

This keeps presets reusable without turning template installation into an implicit execution or deployment action.
