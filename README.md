# Flowit Workflow

**Flowit Workflow is an agent-agnostic orchestration layer for long-lived Agent sessions.**

It adds four reusable primitives:

- **Durable Schedule Engine** — run a task later or on a fixed cadence.
- **Pipeline / Work Graph** — move work across sessions in a DAG.
- **Skill Binding** — resolve named Skills at execution time in the target Agent.
- **Context Graph** — pass bounded/read-only context references between sessions.

DeepSeek Harness is the first reference adapter. **Claude Code is the first cross-Agent pilot.** Future hosts attach through the same `AgentAdapter` contract rather than changing the Core.

## Architecture

```text
                         Flowit Orchestration Core
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
 Schedule Engine            Pipeline Graph             Context Graph
        │                         │                         │
        └────────────────── Skill Binding ─────────────────┘
                                  │
                         AgentAdapter contract
                                  │
        ┌─────────────────────────┴─────────────────────────┐
        │                                                   │
 DeepSeek Harness                                      Claude Code
 native session/Skill/reference                  Hooks + MCP + Skills
                                                       + --resume
```

See [architecture](docs/architecture.md), [Adapter contract](docs/adapter-contract.md), and [Claude Code pilot](docs/claude-code-pilot.md).

## Core model

A scheduled task or Pipeline node stores only orchestration references:

```ts
{
  adapterId: 'claude-code',
  sessionId: '...',
  prompt: 'Review yesterday\'s changes',
  skills: ['code-review'],
  contextRefs: [
    { adapterId: 'claude-code', sessionId: 'research-session' }
  ]
}
```

Skill bodies and complete transcripts are not copied into Flowit Workflow. The target adapter resolves them when work actually runs.

## Claude Code pilot

The repository itself is a Claude Code plugin root:

```text
.claude-plugin/plugin.json
hooks/hooks.json
.mcp.json
skills/
  run-bound/SKILL.md
  orchestrate/SKILL.md
```

Claude Code officially loads these plugin components from the plugin root. Build the TypeScript runtime first:

```bash
npm install
npm run build
claude --plugin-dir .
```

The Hooks capture Session lifecycle and completion facts. The MCP server provides the orchestration control plane. Cold-session execution uses the public Claude CLI resume path.

### Try it

1. Start one or more Claude Code sessions with this plugin enabled so their session ids are captured.
2. Run `/flowit-workflow:orchestrate` and list sessions.
3. For mutation testing, explicitly opt in:

```bash
FLOWIT_WORKFLOW_CLAUDE_MUTATIONS=1 claude --plugin-dir .
```

4. Start the durable worker if schedules/event pipelines must outlive the current session:

```bash
node dist/cli.js claude-daemon --detach
```

### Claude safety defaults

- MCP mutation tools are **not exposed by default**.
- External dispatch to a Claude session still marked `live` is rejected by default.
- Cross-session summaries are read-only context and never permission/consent.
- A dispatched run must return a schema-valid Skill-binding result; missing requested Skills fail the node.
- Cross-adapter context currently fails closed.

## DeepSeek Harness adapter

The existing DSH implementation remains available as a host adapter and plugin subpath:

```ts
import * as flowitWorkflow from '@coaseedge/flowit-workflow/dsh'
```

It keeps the stronger native behavior:

- live Agent lookup / cold `ctx.agents.resume()`;
- target-cwd + Agent-scope `ctx.skills` resolution;
- immutable `dsh-session:` context references;
- DSH Session event triggers.

The general package root does not import DSH at module-load time; DSH dependencies are optional peers for non-DSH consumers.

## Durable state

Core state defaults to `.flowit-workflow/workflow.json` for embedded runtimes. Claude uses a user-level runtime directory:

```text
~/.flowit-workflow/claude/
  workflow.json
  sessions.json
  events.jsonl
  events.cursor
  daemon.pid
```

The Workflow store uses an inter-process lock plus atomic rename because Claude plugin MCP servers and the detached daemon can run as separate processes.

## Core API

```ts
import {
  FlowitOrchestrationCore,
  type AgentAdapter,
} from '@coaseedge/flowit-workflow/core'

const core = new FlowitOrchestrationCore({
  defaultAdapterId: 'my-agent',
  storageFile: '.flowit-workflow/workflow.json',
}, [myAdapter])
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

Implement `AgentAdapter` under `src/adapters/`:

```ts
interface AgentAdapter {
  id: string
  capabilities: AgentAdapterCapabilities
  listSessions(query?: string, signal?: AbortSignal): Promise<AgentSessionDescriptor[]>
  dispatch(request: AgentDispatchRequest, signal?: AbortSignal): Promise<AgentDispatchResult>
  subscribe?(listener: (event: AgentEvent) => Promise<void> | void): () => void
}
```

The next planned adapters can be Gemini CLI, OpenHands, OpenCode, WorkBuddy, Cursor, and Codex. The Core should not gain imports from those hosts.

## Development

```bash
npm run typecheck
npm test
npm run build
```

CI runs the same check/build sequence. If GitHub reports a job with zero executed steps, treat that as runner infrastructure failure rather than code validation.

## Current limitations

- Claude context flow is summary-level, not full transcript snapshot parity with DSH.
- Claude live-session external resume is deliberately not implemented as a safe primitive.
- The Claude mutation opt-in is deployment-level; per-action human consent is future work.
- A true cross-adapter Context Bridge is not implemented yet.
- The durable worker is a user-space daemon, not an OS service manager.

## License

MIT
