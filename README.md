# Flowit Workflow

**Flowit Workflow is an agent-agnostic orchestration layer for long-lived Agent sessions.**

It adds four reusable primitives above the host Agent:

- **Durable Schedule Engine** — run a task later or on a fixed cadence.
- **Pipeline / Work Graph** — move work across sessions and hosts in a DAG.
- **Skill Binding** — bind named Skills and resolve them at execution time.
- **Context Graph** — pass bounded, read-only context references between sessions.

The Core does not own model configuration, host authentication, transcripts or permission systems. Those remain authoritative in each host through an `AgentAdapter`.

## Supported hosts

| Host | Support | Resume/dispatch | Skill binding | Context | Events |
| --- | --- | --- | --- | --- | --- |
| DeepSeek Harness | Full reference | native live + cold resume | native | native snapshot | native |
| Claude Code | Full pilot | public `--resume` path | verified wrapper Skill | bounded summary | Hooks journal |
| OpenCode V2 | Full | V2 Session client | native Skill catalog | bounded Session context | V2 event stream |
| Codex | Full | App Server v2 thread/turn API | typed native `skill` input | bounded thread summary | App Server notifications |
| WorkBuddy | Hybrid | file bridge or configured Managed-Agent/Host driver | WorkBuddy Skill | bounded summary | Hooks/bridge |
| 豆包办公 | Bridge | host-native Worker only; no public resume assumed | custom Skill | bounded summary | no public event API assumed |

See [Host adapters](docs/host-adapters.md) for the exact capability boundary.

## Architecture

```text
                         Flowit Orchestration Core
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
 Schedule Engine            Pipeline / Work Graph      Context Graph
        │                         │                         │
        └────────────────── Skill Binding ─────────────────┘
                                  │
                         AgentAdapter contract
                                  │
     ┌───────────┬───────────┬────┴────┬────────────┬─────────────┐
     │           │           │         │            │             │
    DSH      Claude Code  OpenCode    Codex      WorkBuddy    豆包办公
   Full         Full        Full       Full        Hybrid       Bridge
```

A task or Pipeline node stores orchestration references, not copied Skill bodies or whole transcripts:

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

## Install and build

```bash
pnpm install
pnpm build
```

OpenCode additionally needs its V2 client in the runtime environment:

```bash
pnpm add @opencode-ai/client@beta
```

## Generic control plane

The CLI and MCP server now select a built-in adapter through environment/configuration:

```bash
FLOWIT_WORKFLOW_ADAPTER=codex flowit-workflow sessions --adapter=codex
FLOWIT_WORKFLOW_ADAPTER=opencode flowit-workflow daemon --adapter=opencode --detach
FLOWIT_WORKFLOW_ADAPTERS=opencode,codex flowit-workflow daemon --adapter=opencode --adapters=opencode,codex
```

Mutation-capable MCP tools remain disabled unless explicitly enabled:

```bash
FLOWIT_WORKFLOW_MUTATIONS=1
```

The old `FLOWIT_WORKFLOW_CLAUDE_MUTATIONS=1` variable remains accepted for Claude compatibility.

## OpenCode V2

Flowit uses the documented V2 generated client. It can connect to an existing OpenCode server:

```bash
FLOWIT_WORKFLOW_ADAPTER=opencode \
FLOWIT_WORKFLOW_OPENCODE_URL=http://localhost:4096 \
flowit-workflow daemon --adapter=opencode
```

If no URL is provided, the adapter uses `@opencode-ai/client/service` `Service.ensure()` to obtain a compatible local service. Requested Skills are resolved from OpenCode's Skill catalog at the target Session location before the task is sent. Event pipelines consume the OpenCode event stream.

To expose Flowit tools inside OpenCode, copy/merge [the example V2 MCP configuration](integrations/opencode/opencode.jsonc.example).

OpenCode V2 is currently beta, so all OpenCode-specific code stays isolated in `src/adapters/opencode.ts` and can evolve without changing Core.

## Codex

Flowit launches the documented:

```text
codex app-server --stdio
```

and uses v2 `thread/list`, `thread/resume`, `thread/read`, `turn/start`, `turn/completed` and `skills/list`. Requested Skills are passed as native typed `skill` turn items and named with `$skill-name` in the user text.

```bash
FLOWIT_WORKFLOW_ADAPTER=codex flowit-workflow daemon --adapter=codex
```

Use [the Codex MCP example](integrations/codex/config.toml.example) to make Flowit Workflow tools callable from Codex. MCP is the control plane; App Server is the execution adapter.

## WorkBuddy

Flowit supports two WorkBuddy paths.

### Desktop bridge

WorkBuddy's Claude-compatible Hooks can publish Session lifecycle facts into Flowit:

1. Merge [the Hook example](integrations/workbuddy/settings.json.example) into `.codebuddy/settings.json`.
2. Configure [the Flowit MCP server](integrations/workbuddy/mcp.json.example) in WorkBuddy if you want Workflow tools inside the Agent.
3. Install/import [the Flowit bridge worker Skill](integrations/workbuddy/flowit-bridge-worker/SKILL.md).
4. Authorize `~/.flowit-workflow/bridges/workbuddy/`.
5. For unattended desktop polling, bind that Skill to a WorkBuddy native Automation.

The bridge uses an inbox/outbox protocol and requires the host worker to attest every requested Skill actually loaded.

### Managed Agent / Host driver

For enterprise WMA or a maintained Host CLI wrapper, configure a driver command rather than hard-coding undocumented cloud endpoints:

```bash
export FLOWIT_WORKFLOW_WORKBUDDY_DRIVER='["node","/opt/company/workbuddy-flowit-driver.mjs"]'
flowit-workflow daemon --adapter=workbuddy
```

Flowit sends one normalized dispatch JSON on stdin and expects one `AgentDispatchResult` JSON on stdout. When this driver is configured, the WorkBuddy adapter advertises cold-resume capability.

## 豆包办公

Flowit intentionally uses a constrained Bridge Adapter because a stable public Session/Resume developer API has not been established as part of this integration.

1. Install/import [the bridge worker Skill](integrations/doubao-office/flowit-bridge-worker/SKILL.md) into豆包办公任务模式.
2. Authorize `~/.flowit-workflow/bridges/doubao-office/`.
3. Use豆包原生定时任务 to invoke the worker periodically if unattended processing is desired.

The adapter reports `coldResume=false`, `liveDispatch=false`, and `eventSubscription=false`; Flowit will not pretend that product UI features are programmatic Session APIs.

## Claude Code pilot

The repository remains a Claude Code plugin root:

```text
.claude-plugin/plugin.json
hooks/hooks.json
.mcp.json
skills/
  run-bound/SKILL.md
  orchestrate/SKILL.md
```

```bash
FLOWIT_WORKFLOW_CLAUDE_MUTATIONS=1 claude --plugin-dir .
flowit-workflow claude-daemon --detach
```

The Claude adapter rejects external resume of a Session still marked live by default, uses a durable Hook journal/cursor, and requires schema-valid Skill-binding attestation.

## DeepSeek Harness

The original reference implementation remains available from the DSH subpath:

```ts
import * as flowitWorkflow from '@coaseedge/flowit-workflow/dsh'
```

It retains native `ctx.agents.resume()`, `ctx.skills`, immutable `dsh-session:` context references, and DSH Session events.

## Bridge protocol

WorkBuddy desktop and豆包办公 share a host-neutral bridge protocol under:

```text
~/.flowit-workflow/bridges/<adapter-id>/
  sessions.json
  events.jsonl
  events.cursor
  inbox/
  outbox/
```

See [Bridge protocol](integrations/bridge/PROTOCOL.md). The bridge is a deliberate compatibility layer, not an attempt to reverse-engineer a private API.

## Core API

```ts
import { FlowitOrchestrationCore } from '@coaseedge/flowit-workflow/core'
import { CodexAgentAdapter } from '@coaseedge/flowit-workflow/adapters/codex'

const core = new FlowitOrchestrationCore({
  defaultAdapterId: 'codex',
  storageFile: '.flowit-workflow/workflow.json',
}, [new CodexAgentAdapter()])
```

Important services:

```text
core.adapters
core.dispatcher
core.scheduler
core.pipelines
core.contextGraph
core.skillBinder
```

## Adding another Agent

Implement the stable host boundary instead of adding host imports to Core. A new adapter must fail closed for unsupported capabilities and preserve the host's own permission/sandbox authority.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Current limitations

- Cross-adapter Context Bridge is still deferred; foreign-host context refs fail closed unless deliberately projected.
- OpenCode V2's client/plugin APIs are beta and may require adapter-only updates.
- WorkBuddy WMA integration is a driver seam until a stable public endpoint/SDK contract is pinned and tested in this repository.
- 豆包办公 is Bridge-level support; no public cold Session resume/event API is claimed.
- The durable worker is a user-space daemon, not an OS service manager.
- Hosted GitHub Actions in this account may report a failed job with zero executed steps; that is not treated as code validation.

## License

MIT
