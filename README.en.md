<div align="center">

<img src="assets/flowit-hero.svg" alt="Flowit Workflow — CoaseEdge multi-agent durable workflow orchestration" width="100%" />

<br />

[![CI](https://github.com/Andrewlislin/Flowit-Workflow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Andrewlislin/Flowit-Workflow/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-D22128?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%20%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Release](https://img.shields.io/badge/release-v0.5.0--beta.3-F59E0B?style=flat-square)](https://github.com/Andrewlislin/Flowit-Workflow/releases/tag/v0.5.0-beta.3)

# Flowit Workflow · 浮域

**Turn the AI agents you already use from one-shot assistants into durable, role-based, recoverable, scheduled workflows.**

A **CoaseEdge / 高斯边界** product.

[中文（默认）](README.md) · **English** · [Setup & Repair](docs/setup.md) · [Built-in Work Modes](docs/presets.md) · [Architecture](docs/architecture.md)

</div>

---

## What is Flowit?

WorkBuddy, Claude Code, Codex, OpenCode, DeepSeek Harness, Doubao Office and similar agents are already good at doing a task when asked.

Flowit solves a different problem: **how to keep those agents doing a repeatable, multi-step job reliably over time.**

```text
Schedule / event / manual start
            ↓
           Plan
            ↓
         Research
            ↓
         Execute
            ↓
          Review
            ↓
      Human approval
```

Flowit tracks when work should run, which Session owns each stage, which Skills are required, what context may cross boundaries, which stages are complete, and where recovery resumes after a failure.

It does **not** replace host authentication, models, permissions, sandboxes, workspace trust or tool approvals. The selected agent still performs the actual work.

## When is Flowit worth using?

For a quick email rewrite, one PDF summary, one small function or a tiny bug fix, directly using WorkBuddy, Claude Code or Codex is usually simpler.

Flowit becomes more useful when work is:

- repeated daily or weekly;
- made of fixed stages;
- reviewed by a second role;
- long enough that interruption and recovery matter;
- split across different agents or hosts;
- valuable enough to standardize as a reusable team workflow.

A simple rule:

> **AI helps me do one thing → use the agent directly.**  
> **AI should keep operating a repeatable process → use Flowit.**

## How is Flowit different from a Harness or Agent Team?

Think of them as three layers:

- **Harness**: makes an agent runnable and provides models, tools, Sessions and host capabilities.
- **Agent Team**: coordinates multiple role-based agents such as Planner, Researcher, Coder and Reviewer.
- **Flowit**: adds a **durable workflow control plane** above agents and agent teams for scheduling, persisted state, recovery, cross-host execution and reliable orchestration.

| Capability | Typical Harness | Typical Agent Team | **Flowit Workflow** |
| --- | --- | --- | --- |
| Primary role | Agent runtime / tool environment | Multi-agent coordination | **Durable agent workflow control plane** |
| Single-agent execution | Strong | Depends on its harness | Reuses existing agents rather than replacing them |
| Multiple roles / agents | Usually limited | Strong | **Strong; one Session or many Sessions** |
| Workflow state | Often Session / process local | Often remembered by a manager agent | **Persisted Pipeline / Run / Node state** |
| Scheduling | Often cron / external system | Usually not core | **First-class durable Schedule** |
| DAG / fixed process | Optional | Often conversation / handoff driven | **Pipeline DAG + durable checkpoints** |
| Failure recovery | Mostly Session-level | Coordinator-dependent | **Lease + retry + checkpoint + stale recovery** |
| Event reliability | Implementation-specific | Often process-queue based | **Durable event admission before execution** |
| Cross-host execution | Usually tied to one host | Usually inside one framework | **WorkBuddy / Claude / Codex / OpenCode / DSH / Doubao** |
| Skill requirements | Host-internal | Often prompt conventions | **Execution-time Skill binding; fail closed when unavailable** |
| Context transfer | Transcript / memory | Agent-to-agent messages | **Context Graph references; no automatic authority/transcript copying** |
| Multi-worker races | Often assumes one instance | Rarely a core concern | **Atomic claims, leases, heartbeats and fencing** |
| Weak-API / Bridge hosts | Custom integration work | Usually limited | **Bridge v2 with request IDs, idempotency keys, receipts and leases** |
| Product templates | Skill / agent template | Team template | **Preset = roles + prompts + artifacts + graph + host + schedule** |
| Setup lifecycle | Host-specific | Usually no unified layer | **setup / doctor / repair / uninstall** |
| Side-effect semantics | Often implicit | Often implicit | **Explicit at-least-once; no fake generic exactly-once claim** |
| Best fit | One agent doing work | Temporary multi-agent collaboration | **Long-running, repeatable, recoverable cross-agent business processes** |

In one line:

```text
Harness    = make one agent runnable
Agent Team = make multiple agents collaborate
Flowit     = make agents / agent teams operate reliably as a long-lived system
```

## Four core advantages

### Natural-language setup

Ordinary users do not need to memorize CLI syntax. The recommended path is to ask the current agent to inspect, install, repair and verify Flowit:

> Install the latest beta of Flowit Workflow and integrate it with the agent you are running in. First inspect my environment and existing configuration. Do not modify anything yet. Show me what files and permissions you plan to change, wait for my approval, then install it and run a health check. If any host-native UI step is still required, explain it in simple language.

The setup framework plans first, requires confirmation, then applies changes. Ownership conflicts fail closed instead of being silently overwritten.

### Multi-agent collaboration

```text
WorkBuddy
Web / office work
      ↓
Claude Code
Deep analysis
      ↓
Codex
Implementation / review
      ↓
WorkBuddy
Final report
```

Every role can also use one Session. Flowit separates **role boundaries** from **Session count**: start with one agent working in explicit stages, then split roles across agents when needed.

### Recoverable execution

Long jobs can fail because of network issues, host restarts or temporary agent failures. Flowit persists pipelines, node checkpoints, retries, leases and durable state.

The user-facing difference is simple: **resume from the unfinished stage instead of explaining the whole task again.**

### Scheduled automation

Flowit supports manual, daily, weekday and fixed-interval durable schedules. Users can simply say:

> Run this every day at 8:00 AM.

> Run this every weekday at 9:30 AM.

> Check every two hours.

The Schedule belongs to Flowit’s durable state; it does not depend on the agent remembering to do something tomorrow.

## The easiest way to start: talk to your agent

After setup, users can continue with natural language:

> Show me the workflows Flowit currently knows about.

> Create a Deep Research workflow using this Session.

> Run the “authentication refactor” workflow now.

> Change the “industry daily” workflow to run every weekday at 8:00 AM.

Flowit MCP exposes Session discovery, Pipeline creation/execution, Schedule management and daemon startup, so an authorized host agent can translate those requests into durable workflow operations.

<details>
<summary><strong>Advanced users: install the beta directly</strong></summary>

Requires Node.js `^22.19.0` or `>=24.0.0`.

```bash
npx @coaseedgeltd/flowit-workflow@beta setup
```

Stable technical identifiers remain:

```text
npm: @coaseedgeltd/flowit-workflow
CLI: flowit-workflow
```

</details>

## Six supported hosts

| Host | Flowit integration | Good ordinary-user scenarios | Important boundary |
| --- | --- | --- | --- |
| **WorkBuddy** | MCP + Hooks + Bridge / Managed Driver | Daily briefs, web research, office automation, GUI work | Desktop Bridge needs a WorkBuddy Automation to invoke the Worker periodically |
| **Claude Code** | skills-directory Plugin + Hooks + MCP | Technical research, long documents, large refactors | Project scope still obeys Claude workspace-trust and MCP approval |
| **Codex** | App Server v2 + MCP config | Implementation, tests, code review | Codex sandbox and approval boundaries remain authoritative |
| **OpenCode V2** | Official V2 SDK / HTTP Server | Nightly code checks and development workflows | Flowit does not silently launch an OpenCode server |
| **DeepSeek Harness** | Native Cordis Plugin | Long-running research and background agents | DSH uses an embedded Flowit store; mixed root-daemon topologies fail closed |
| **Doubao Office** | Bridge Worker | Office summaries, meeting/document workflows | Skill enablement and native recurring tasks remain host-UI steps |

See [docs/setup.md](docs/setup.md) for setup, Doctor, Repair and Uninstall behavior.

## Three built-in work modes

| Work mode | Flow | Best for |
| --- | --- | --- |
| **Content Studio / 内容工作室** | Discover → Select → Research → Write → Fact-check → Chief edit | News, industry content, daily reports, article drafts |
| **Deep Research / 深度研究** | Frame → Evidence → Counter-evidence → Synthesize → Review | Market, technical, competitor and policy research |
| **AI Project Team / AI 项目小组** | Plan → Research → Execute → Review | Coding, migration, complex plans and multi-step execution |

Content Studio ends at a human-reviewable final artifact and **does not publish externally by default**.

A Preset can bind every role to one Session or map roles to different Sessions, hosts and Skills. Presets can also create daily, weekday and fixed-interval durable Schedules. See [docs/presets.md](docs/presets.md).

## Representative office scenarios

### Daily industry briefing

```text
Weekday 08:00
     ↓
Discover signals
     ↓
Select important items
     ↓
Deep research
     ↓
Write + fact-check
     ↓
Management summary
```

### Weekly competitor research

```text
Research plan
    ↓
Collect evidence for A / B / C
    ↓
Counter-evidence and gaps
    ↓
Compare products / funding / hiring / marketing
    ↓
Conclusions, risks, opportunities and next-week watchlist
```

WorkBuddy or Doubao Office can also summarize documents, meeting notes, tasks and risks at a fixed time while stopping at human review.

## Representative coding scenarios

### Large issue / module refactor

```text
Planner
Goals and constraints
      ↓
Researcher
Code and dependencies
      ↓
Executor
Implementation and tests
      ↓
Reviewer
Independent blocking review
      ↓
Human approval
```

For a two-minute fix, direct Codex is simpler. For a 30–60 minute multi-stage job that must recover and be reviewed, Flowit has more value.

### Nightly code-health report

Run dependency, failing-test, TODO, technical-debt and risk checks every night, producing a report without automatically modifying production code.

## Safety boundaries

Flowit improves **reliability, organization, repeatability and recovery**. It does not make the underlying model intrinsically smarter.

Important boundaries:

- host authentication, permissions, sandboxes, workspace trust and approvals remain host-authoritative;
- setup uses plan → confirmation → apply and stops on conflicting ownership;
- installing a Preset does not immediately execute agent work;
- Content Studio does not publish automatically;
- Bridge history and durable state are conservatively retained on uninstall;
- Flowit uses **at-least-once execution**, not generic exactly-once external side effects.

For email sending, publishing, deletion or production deployment, prefer human approval or host-native idempotency.

## Architecture

<img src="assets/flowit-architecture.svg" alt="Flowit architecture: Schedule, Host Event, Pipeline and Host Adapter" width="100%" />

```text
Schedule / Host Event
        ↓
Durable admission
        ↓
Pipeline / Work Graph
        ↓
Checkpoint / Retry / Lease
        ↓
Host Adapter
        ↓
WorkBuddy / Claude Code / Codex / OpenCode / DSH / Doubao Office
```

The Core stores orchestration facts and references. Host adapters translate those facts into host-native Session, Skill, Context, Event and lifecycle operations.

See [docs/architecture.md](docs/architecture.md) for the execution model.

## Developer quick start

```bash
pnpm install
pnpm check:supply-chain
pnpm typecheck
pnpm test
pnpm test:host-contracts
pnpm build
```

## Documentation

- [Setup, Doctor, Repair and Uninstall](docs/setup.md)
- [Built-in work modes and scheduling](docs/presets.md)
- [Architecture and execution model](docs/architecture.md)
- [AgentAdapter contract](docs/adapter-contract.md)
- [Host adapter capabilities](docs/host-adapters.md)
- [Bridge Protocol v2](integrations/bridge/PROTOCOL.md)
- [Chinese product naming](docs/zh-CN.md)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright © 2026 CoaseEdge.
