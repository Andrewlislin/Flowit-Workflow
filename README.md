<div align="center">

<img src="assets/flowit-hero.svg" alt="Flowit Workflow — durable orchestration for long-lived AI agent sessions" width="100%" />

<br />

[![CI](https://github.com/Andrewlislin/Flowit-Workflow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Andrewlislin/Flowit-Workflow/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-D22128?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%20%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-11.7-F69220?style=flat-square&logo=pnpm&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-experimental-F59E0B?style=flat-square)](#host-support)

**A host-neutral orchestration layer for durable schedules, multi-session work graphs, Skill binding, and bounded context flow.**

[Quick start](#quick-start) · [Architecture](#architecture) · [Host support](#host-support) · [Semantics](#durable-execution-semantics) · [Documentation](#documentation)

</div>

---

## Why Flowit

AI agents are good at executing a turn. Long-lived systems also need to decide **when work runs, which session owns it, how failures recover, and what context is allowed to cross boundaries**.

<table>
<tr>
<td width="50%">

### ⏱ Durable schedules

Run work once or on a cadence with atomic occurrence claims, worker leases, heartbeat renewal, retry, and stale-run recovery.

</td>
<td width="50%">

### 🔀 Pipeline / Work Graph

Compose session work as a DAG with durable event admission, node checkpoints, sibling isolation, retry, and bounded deduplication.

</td>
</tr>
<tr>
<td width="50%">

### 🧩 Skill binding

Resolve named Skills at execution time and fail closed when the selected host cannot establish the requested binding.

</td>
<td width="50%">

### 🧠 Context graph

Move bounded, read-only context references between sessions without copying credentials, authority, or complete transcripts.

</td>
</tr>
</table>

Flowit does **not** replace host authentication, permission systems, sandboxes, transcripts, or model configuration. Those remain authoritative in each Agent host.

## Quick start

### Requirements

- Node.js `^22.19.0` or `>=24`
- pnpm `11.7`
- At least one configured host adapter

```bash
git clone https://github.com/Andrewlislin/Flowit-Workflow.git
cd Flowit-Workflow

pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Start a detached worker for one host:

```bash
FLOWIT_WORKFLOW_ADAPTER=codex \
flowit-workflow daemon --adapter=codex --instance=default --detach
```

Run multiple adapters in one orchestration instance:

```bash
FLOWIT_WORKFLOW_OPENCODE_URL=http://localhost:4096 \
FLOWIT_WORKFLOW_ADAPTERS=opencode,codex \
flowit-workflow daemon \
  --adapter=opencode \
  --adapters=opencode,codex \
  --instance=research
```

Mutation-capable MCP tools are opt-in:

```bash
export FLOWIT_WORKFLOW_MUTATIONS=1
```

## Architecture

<img src="assets/flowit-architecture.svg" alt="Flowit Workflow architecture: schedules and host events enter the orchestration core, then execute through host adapters" width="100%" />

The Core stores orchestration facts and references. Host adapters translate those facts into host-native session, Skill, context, event, and lifecycle operations.

```ts
{
  adapterId: 'codex',
  sessionId: 'thread-id',
  prompt: 'Review the implementation',
  skills: ['code-review'],
  contextRefs: [
    { adapterId: 'codex', sessionId: 'research-thread' }
  ]
}
```

## Host support

| Host | Level | Dispatch | Skills | Context | Events |
| --- | --- | --- | --- | --- | --- |
| DeepSeek Harness | **Reference** | Native live/cold Session | Native | Native snapshot | Native |
| Claude Code | **Pilot** | Public `--resume` path | Verified wrapper Skill | Bounded summary | Durable Hooks journal |
| OpenCode V2 | **Experimental** | Official `@opencode-ai/sdk` V2 API | Official V2 Skill API | Bounded Session context | Reconnecting V2 event stream |
| Codex | **Experimental** | App Server v2 thread/turn API | Typed `skill` item | Bounded thread summary | App Server notifications |
| WorkBuddy | **Hybrid** | Bridge or managed driver | WorkBuddy Skill | Bounded summary | Hooks/bridge |
| 豆包办公 | **Bridge** | Host Worker only | Custom Skill | Bounded summary | No public event API claimed |

> OpenCode and Codex remain Experimental until pinned host-contract tests and real hosted end-to-end validation complete successfully.

## Durable execution semantics

Flowit uses **at-least-once execution**. It does not claim generic exactly-once side effects.

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

Core invariants include:

- Schedule claims atomically verify `active` status and the exact `nextRunAt`.
- Host events are durably admitted before the listener acknowledges them.
- Pipeline nodes use stable correlation keys across retries.
- Active and retryable runs survive audit-history pruning.
- Terminal replay deduplication is bounded by count and retention time.
- Side effects without host-native idempotency or transactions may still repeat after a crash.

<details>
<summary><strong>Default retention and recovery settings</strong></summary>

```text
leaseDurationMs             = 30 seconds
maxPipelineAttempts         = 3
maxScheduleAttempts         = 3
maxRunHistory               = 500
maxTerminalReceipts         = 100000
terminalReceiptRetentionMs  = 90 days
```

A receipt for the current active Schedule occurrence is protected until that Schedule advances.

</details>

## Storage and migration

Current default storage:

```text
~/.flowit-workflow/instances/<instanceId>/workflow.json
```

For the default instance, Flowit detects legacy v0.3 stores at:

```text
~/.flowit-workflow/<adapterId>/workflow.json
```

Use the offline migration command when explicit control is required:

```bash
flowit-workflow migrate --instance=default \
  --legacy-storage=/path/a/workflow.json \
  --legacy-storage=/path/b/workflow.json
```

Conflicting non-empty databases fail closed rather than being silently merged.

## Adapter notes

<details>
<summary><strong>OpenCode V2</strong></summary>

Set `FLOWIT_WORKFLOW_OPENCODE_URL`. Flowit pins the public npm package `@opencode-ai/sdk@1.18.23`, matching the OpenCode source revision against which the V2 contract was reviewed. It does not install an internal vendor tarball or a Git/HTTP dependency.

```text
client.v2.session.*
client.v2.skill.*
client.v2.event.*
```

The SDK remains an optional peer dependency so non-OpenCode consumers do not load it. Runtime loading is lazy. The adapter preserves stable host event identity, maps both `session.idle` and `session.status: idle`, preflights startup, and reconnects the event stream with bounded backoff.

</details>

<details>
<summary><strong>Codex App Server</strong></summary>

Flowit starts:

```text
codex app-server --listen stdio://
```

The client handles responses, notifications, server-initiated requests, string/number JSON-RPC IDs, terminal turn validation, timeouts, interruption, and fail-closed unattended approval.

</details>

<details>
<summary><strong>Bridge hosts</strong></summary>

WorkBuddy and 豆包办公 use Bridge protocol v2. Transport ownership (`requestId`) is separate from logical side-effect ownership (`idempotencyKey`). Shared receipts are versioned, completed-only, and atomically published.

See [`integrations/bridge/PROTOCOL.md`](integrations/bridge/PROTOCOL.md).

</details>

## Documentation

- [Architecture and execution model](docs/architecture.md)
- [AgentAdapter contract](docs/adapter-contract.md)
- [Host adapter capabilities](docs/host-adapters.md)
- [Claude Code pilot](docs/claude-code-pilot.md)
- [Bridge protocol v2](integrations/bridge/PROTOCOL.md)

## Development

```bash
pnpm install
pnpm check:supply-chain
pnpm typecheck
pnpm test
pnpm test:host-contracts
pnpm build
```

| Command | Purpose |
| --- | --- |
| `pnpm check:supply-chain` | Reject URL, Git, local-file, and tarball dependency specifiers |
| `pnpm typecheck` | Strict TypeScript validation |
| `pnpm test` | Unit, recovery, lease, migration, and concurrency tests |
| `pnpm test:host-contracts` | Pinned host protocol contracts |
| `pnpm build` | Emit the distributable package |

The repository treats a reviewed `pnpm-lock.yaml`, registry-only dependency sources, and a fully executed CI validation chain as release gates.

## Contributing

Issues and pull requests are welcome. Keep adapter capability claims conservative, preserve host permission boundaries, and include deterministic recovery or contract tests for concurrency-sensitive changes.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Attribution notices are recorded in [`NOTICE`](NOTICE).

Copyright © 2026 CoaseEdge.


## Minimal package installs

Flowit can now be installed at the same boundary used by the architecture:

```bash
# Host-agnostic Core only
pnpm add @coaseedge/flowit-core

# OpenCode deployment
pnpm add @coaseedge/flowit-core @coaseedge/flowit-adapter-opencode

# Claude Code deployment
pnpm add @coaseedge/flowit-core @coaseedge/flowit-adapter-claude-code

# Batteries-included / backwards-compatible distribution
pnpm add @coaseedge/flowit-workflow
```

The full package intentionally has the broadest SBOM. Minimal installations do not inherit unrelated Host SDKs. DSH consumers additionally satisfy the peer dependencies declared by `@coaseedge/flowit-adapter-dsh`.
