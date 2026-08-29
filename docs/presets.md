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

`--dry-run` shows the exact workflow store, workspace, role bindings, Pipeline definition, and optional activation Schedule before mutation. `--yes` is required for non-interactive creation.

By default, Preset installation only creates or reuses the Pipeline definition. It does not execute the Pipeline during installation. Users can opt into a future durable activation Schedule explicitly.

## Activation scheduling

Manual activation remains the default:

```bash
flowit-workflow preset install content-studio \
  --adapter=workbuddy \
  --session=all=<session-id> \
  --input="AI engineering" \
  --schedule=manual \
  --yes
```

For a daily wall-clock run:

```bash
flowit-workflow preset install content-studio \
  --adapter=workbuddy \
  --session=all=<session-id> \
  --input="AI engineering" \
  --schedule=daily \
  --time=08:00 \
  --timezone=Asia/Shanghai \
  --dry-run
```

Weekday activation uses Monday through Friday:

```bash
--schedule=weekdays --time=08:00 --timezone=Asia/Shanghai
```

Fixed-interval activation is also available:

```bash
--schedule=every --every-seconds=3600
```

The interval floor is 60 seconds. `daily` and `weekdays` use IANA time-zone identifiers. Calendar schedules keep the requested local wall-clock time across time-zone offset changes; if a requested local time does not exist during a daylight-saving spring-forward transition, that occurrence is skipped rather than silently shifted to a different local time.

Preset activation creates a first-class durable Schedule that targets the Pipeline directly. It does not send an Agent prompt asking an Agent to run the Pipeline. The Schedule occurrence key is reused as the automatic Pipeline trigger key, so retries and multiple Flowit workers share the same durable occurrence identity.

Pipeline and Schedule definitions are independently idempotent. An identical same-name Schedule is reused. A same-name Schedule with different timing or a different Pipeline target fails closed; use `--schedule-name=<name>` instead of replacing existing automation.

Installation itself still does not run Agent work: the installer opens the workflow store with active workers disabled, and the first Schedule occurrence is in the future. At execution time, a running Flowit worker/Harness process and the required host adapters must be available. Bridge hosts such as WorkBuddy or 豆包办公 still require their configured Bridge Worker/host automation path.

Scheduling does not change the publishing boundary. `content-studio` still ends at a human-reviewable final artifact and does not automatically publish to external platforms.

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

For a scheduled DSH-only Preset, the Schedule is written to the same embedded Harness store; the Harness process must be running for the occurrence to execute.

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

Preset installation does not silently replace Pipelines or Schedules.

- If the generated Pipeline name does not exist, Flowit creates it.
- If exactly one existing Pipeline has the same name and identical semantic definition, Flowit reuses it.
- If the same Pipeline name belongs to a different or ambiguous definition, installation fails closed and asks for a different `--name`.
- If activation is requested, an identical same-name Schedule is reused; a conflicting Schedule fails closed and requires `--schedule-name`.
- Installation creates the workspace directory but does not delete or overwrite workspace artifacts.
- Installation does not run a Pipeline immediately and does not perform external publishing or irreversible side effects.

This keeps presets reusable without turning template installation into an implicit execution or deployment action.