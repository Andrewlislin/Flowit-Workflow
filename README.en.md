<div align="center">

<img src="assets/flowit-hero.svg" alt="Flowit Workflow — durable orchestration for long-lived AI agent sessions" width="100%" />

<br />

[![CI](https://github.com/Andrewlislin/Flowit-Workflow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Andrewlislin/Flowit-Workflow/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-D22128?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%20%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Release](https://img.shields.io/badge/release-v0.5.0--beta.1-F59E0B?style=flat-square)](https://github.com/Andrewlislin/Flowit-Workflow/releases/tag/v0.5.0-beta.1)

# Flowit Workflow

**Turn the AI agents you already use into durable, repeatable workflows.**

[中文（默认）](README.md) · **English** · [Setup](docs/setup.md) · [Presets](docs/presets.md) · [Architecture](docs/architecture.md)

</div>

---

## What is Flowit?

WorkBuddy, Claude Code, Codex, OpenCode, DeepSeek Harness and similar agents are already good at doing a task when you ask them.

Flowit solves a different problem: **how to make those agents keep doing multi-step work reliably over time**.

A single agent usually looks like this:

```text
You
 ↓
Agent
 ↓
One task
 ↓
Result
```

Flowit adds a durable orchestration layer:

```text
Schedule / event / manual start
            ↓
         Planning
            ↓
         Research
            ↓
        Execution
            ↓
          Review
            ↓
      Human approval
```

Flowit tracks when work should run, which Session owns each step, which Skills are required, what context may cross boundaries, which nodes have completed, and how retries/recovery should work.

It does **not** replace the host's model, authentication, permissions, sandbox, workspace trust or tools. The selected Agent host remains authoritative.

## When should I use it?

Use the Agent directly for small one-off tasks such as rewriting an email, summarizing one file, explaining a function or fixing a tiny bug.

Flowit becomes useful when the job is **repeated, multi-step, long-running, review-heavy or split across agents**.

| Direct Agent | Flowit + Agent |
| --- | --- |
| “Do this now” | “Keep this workflow running” |
| One long prompt | Explicit stages and checkpoints |
| You remember to trigger it | Durable schedules can trigger it |
| One Session often does everything | Roles may use one or many Sessions |
| Failure may require rebuilding context | Completed nodes and durable state are retained |
| Process lives mostly in the prompt | Process becomes a reusable workflow |

A useful rule of thumb:

> **AI helps me do one thing → use the Agent directly.**  
> **AI should keep operating a process → use Flowit.**

## The easiest way to get started: ask your Agent

Flowit has a CLI underneath, but ordinary users do not need to memorize it. For MCP-connected hosts, the recommended experience is to let the Agent perform setup and workflow management for you.

Give your Agent a request like this:

> Install the latest Flowit Workflow beta for this Agent. First inspect my environment and existing configuration without changing anything. Show me what you plan to modify and what permissions are involved. Wait for my confirmation, then install it, run a health check, and explain any remaining manual steps in plain language.

After setup, you can continue with natural language:

> Show me the workflows Flowit currently has.

> Create a research workflow for this Session.

> Run my migration-review workflow now.

> Make my industry briefing run every weekday at 8:00 AM.

The Flowit MCP surface exposes Session discovery, Pipeline creation/execution, Schedule management and daemon startup so a capable host Agent can translate these requests into durable Flowit operations.

<details>
<summary><strong>Direct beta bootstrap for advanced users</strong></summary>

Requirements: Node.js `^22.19.0` or `>=24.0.0`.

```bash
npx @coaseedge/flowit-workflow@beta setup
```

Or install globally and use `flowit-workflow setup`.

</details>

## Setup by Agent host

### WorkBuddy — best fit for ordinary office automation

Tell WorkBuddy:

> Install Flowit for my current WorkBuddy environment. Preserve my existing MCP servers, Skills and Hooks. Show me the plan first, then apply it after I approve it, and run a health check.

Flowit configures the machine-side pieces automatically: MCP, the Bridge Worker Skill, lifecycle Hooks and durable Bridge directories.

**One WorkBuddy Desktop step remains manual:** create a native WorkBuddy Automation that periodically invokes **Flowit Workflow Bridge Worker**. That Automation acts like a mailbox worker: it checks whether Flowit has work and does nothing when the inbox is empty. A managed WorkBuddy driver does not need this desktop polling step.

Typical use:

> Use Flowit to create a weekday 8:00 AM industry briefing. Find current AI and enterprise-software news, select the important items, research the background, fact-check the claims, and produce a management summary. Do not publish anything automatically.

### Claude Code — strong for technical research, documents and large code tasks

Tell Claude Code:

> Install Flowit for my personal Claude Code environment. Keep it isolated from unrelated settings, show the plan before changing anything, then reload the plugin and verify the installation.

Flowit installs one self-contained personal plugin under `~/.claude/skills/flowit-workflow/` containing the Flowit Skills, Hooks and MCP boundary. Project scope is also supported; Claude's own workspace-trust and project approval gates remain in force.

Typical use:

> Use Flowit to research whether we should migrate this service to event-driven architecture. Plan the research, gather evidence, deliberately search for counter-evidence, synthesize the findings, and review the final recommendation for unsupported claims.

Or for development:

> Use Flowit to refactor the authentication module. First analyze scope and risks, then make a plan, implement it, and have a separate review stage check the acceptance criteria.

### Codex — strong for implementation, tests and code review

Tell Codex:

> Install Flowit for this Codex environment. Do not reformat or overwrite my existing config.toml. Manage only Flowit's own configuration, stop if you find a conflict, then verify MCP health.

Flowit manages only its marked `mcp_servers.flowit-workflow` block and preserves unrelated TOML bytes, comments and ordering. Project-scoped configuration keeps Codex's trust boundary intact.

Typical use:

> Use Flowit to handle issue #128. Analyze the requirement and codebase, gather the necessary context, implement the change, run the relevant checks, and finish with an independent review. Stop for human approval before merge.

### OpenCode V2 — useful for existing OpenCode development environments

Tell OpenCode:

> Install Flowit without changing my models, agents, comments or other MCP servers. After setup, check whether my OpenCode V2 server is reachable and tell me what to do if it is not.

Flowit edits only `mcp.servers.flowit-workflow` in JSON/JSONC and preserves comments, trailing commas and unrelated configuration. It deliberately does not start an unmanaged OpenCode server behind your back.

Typical use:

> Create a nightly code-health workflow. Inspect dependency risk, failing tests, obvious technical debt and important TODOs. Do not modify code; produce a report and use a second review stage to challenge the first conclusion.

### DeepSeek Harness — best fit for long-running native agent systems

Tell the Harness agent:

> Install the native Flowit plugin in my Harness home configuration. Preserve my other Cordis plugins and patch entries, show the plan first, and tell me whether Harness needs a restart.

User scope uses the persistent Harness patch layer. Project scope generates an explicit runtime overlay because Harness currently has no project-local persistent patch layer.

Typical use:

> Every morning, research the projects on my watch list. Use primary sources, keep history, search for contradictory evidence, and produce a reviewed summary only when there is meaningful change.

DSH-only workflows use Harness's embedded Flowit store. Mixed DSH/root-daemon roles are intentionally rejected until a supported cross-runtime context bridge exists.

### Doubao Office — guided Bridge execution for office scenarios

Doubao Office is currently an execution endpoint rather than a fully self-configuring Flowit control surface. Flowit does not claim undocumented Session Resume, Skill-installation or Automation-management APIs.

Machine-side setup stages the **Flowit Workflow Bridge Worker** Skill and creates the durable Bridge transport. In the Doubao Office UI, the user or administrator still needs to:

1. import/enable the staged Worker Skill;
2. authorize it only for the Flowit Bridge directory;
3. create a native scheduled task that periodically invokes the Worker.

Typical use:

> At 5:30 PM on workdays, summarize today's project documents and meeting notes into Completed / Open / Tomorrow / Risks. Generate the report only; do not send it automatically.

Today, workflow creation/management is best done from another Flowit MCP-capable host or a deployment tool, while Doubao Office executes the Bridge work.

## Built-in work modes

Flowit ships three reusable product workflows. Chinese UI names are primary in the localized product, while stable technical IDs remain compatible.

| Work mode | Stable ID | Best for |
| --- | --- | --- |
| **Content Studio** / 内容工作室 | `content-studio` | news, newsletters, industry content, recurring briefs |
| **Research Lab** / 深度研究 | `research-lab` | market, technical, competitive and policy research |
| **AI Project Team** / AI 项目小组 | `agent-team` | coding, planning and complex multi-step work |

### Content Studio

```text
Signal discovery
      ↓
Topic selection
      ↓
Research
      ↓
Writing
      ↓
Fact-check
      ↓
Editorial review
```

It deliberately ends at a human-reviewable final artifact and does not auto-publish.

### Research Lab

```text
Frame the question
       ↓
Gather evidence
       ↓
Find counter-evidence
       ↓
Synthesize
       ↓
Review
```

It emphasizes primary evidence, explicit uncertainty and contradictory evidence.

### AI Project Team

```text
Plan
 ↓
Research
 ↓
Execute
 ↓
Review
```

It is the general-purpose workflow for software tasks, migration plans and complex office projects.

## Natural-language workflow examples

You can describe the result instead of thinking in Pipeline terminology.

**Office briefing**

> Create an industry briefing that runs every weekday at 8:00 AM. Use my current WorkBuddy Session for all stages. Track AI, enterprise software and intelligent office products. Research before writing, fact-check the important claims, and stop at a final report for me to review.

**Weekly competitor research**

> Every Monday morning, compare Company A, B and C across product launches, financing, hiring, marketing and major news. Keep source references, look for evidence that contradicts the obvious narrative, and finish with risks, opportunities and what to watch next week.

**Large coding issue**

> Create an AI Project Team for issue #128. Use Claude Code for planning, Codex for implementation, and a separate Codex Session for review. Do not merge automatically.

**Cross-agent analysis**

> WorkBuddy should collect web evidence, Claude Code should analyze it, Codex should review technical claims, and WorkBuddy should assemble the final management report. Show me the workflow before creating it.

## Scheduling in plain language

Built-in Presets support manual activation, daily schedules, weekday schedules and fixed intervals. Users should be able to say:

> Run this manually only.

> Run every day at 8 AM.

> Run every weekday at 9:30 AM.

> Check every two hours.

Calendar schedules use real IANA time zones and keep the requested local wall-clock time across time-zone changes. Installation itself does not execute the workflow immediately; the first scheduled occurrence remains in the future.

## Important safety boundaries

- Flowit never replaces host authentication, permissions, sandboxes, workspace trust or approval gates.
- Setup is plan-first and confirmation-gated; conflicting or malformed configuration fails closed instead of being guessed over.
- Preset installation creates/reuses definitions and optional future Schedules; it does not run Agent work during installation.
- Content Studio does not publish externally by default.
- Flowit uses **at-least-once execution**, not generic exactly-once side effects. External actions such as sending mail, publishing, deleting data, payments or production deployment should use host-native idempotency/transactions or an explicit human approval boundary.

## Architecture for developers

<img src="assets/flowit-architecture.svg" alt="Flowit Workflow architecture" width="100%" />

Flowit Core stores orchestration facts and references. Host adapters translate those facts into host-native Session, Skill, context, event and lifecycle operations.

Core capabilities include:

- durable schedules with atomic occurrence claims, worker leases, heartbeats, retry and stale-run recovery;
- Pipeline / DAG execution with durable admission, node checkpoints, sibling isolation and bounded deduplication;
- Skill binding that fails closed when the target host cannot establish the requested Skill;
- bounded read-only context references between Sessions without copying credentials or authority.

### Host support

| Host | Level | Dispatch | Skills | Context | Events |
| --- | --- | --- | --- | --- | --- |
| DeepSeek Harness | **Reference** | Native live/cold Session | Native | Native snapshot | Native |
| Claude Code | **Pilot** | Public `--resume` path | Verified wrapper Skill | Bounded summary | Durable Hooks journal |
| OpenCode V2 | **Experimental** | Official V2 SDK API | Official V2 Skill API | Bounded Session context | Reconnecting V2 event stream |
| Codex | **Experimental** | App Server v2 thread/turn API | Typed `skill` item | Bounded thread summary | App Server notifications |
| WorkBuddy | **Hybrid** | Bridge or managed driver | WorkBuddy Skill | Bounded summary | Hooks/bridge |
| Doubao Office | **Bridge** | Host Worker only | Custom Skill | Bounded summary | No public event API claimed |

### Durable execution semantics

```text
trigger observed
      ↓
durable admission / atomic claim
      ↓
worker lease + heartbeat
      ↓
dispatch / checkpoint / retry
      ↓
completed → bounded terminal receipt
failed    → retry or dead-letter
```

Current default storage:

```text
~/.flowit-workflow/instances/<instanceId>/workflow.json
```

See [architecture](docs/architecture.md), [adapter contract](docs/adapter-contract.md), [host adapters](docs/host-adapters.md), [setup](docs/setup.md), [presets](docs/presets.md) and [Bridge protocol v2](integrations/bridge/PROTOCOL.md) for the technical specification.

## Development

```bash
pnpm install
pnpm check:supply-chain
pnpm typecheck
pnpm test
pnpm test:host-contracts
pnpm build
```

The repository treats reviewed lockfiles, registry-only dependency sources, strict TypeScript, package smoke tests, recovery/concurrency tests and host-contract tests as release gates.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Attribution notices are recorded in [`NOTICE`](NOTICE).

Copyright © 2026 CoaseEdge.
