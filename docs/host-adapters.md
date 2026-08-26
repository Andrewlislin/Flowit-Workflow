# Host adapters

Flowit Workflow keeps orchestration semantics in Core and represents host differences through `AgentAdapter.capabilities`.

| Host | Level | coldResume | Skill binding | Context | Events | Dispatch mechanism |
| --- | --- | ---: | ---: | --- | ---: | --- |
| DeepSeek Harness | Full | yes | native | native snapshot | yes | `ctx.agents` / Session Reference |
| Claude Code | Full pilot | yes | verified wrapper Skill | summary | yes | public `claude --resume` + Hooks |
| OpenCode V2 | Full | yes | OpenCode Skill catalog | summary | yes | `@opencode-ai/client` session API |
| Codex | Full | yes | native typed `skill` turn items | summary | yes | `codex app-server --stdio` v2 thread/turn API |
| WorkBuddy | Hybrid | driver-dependent | native WorkBuddy Skill | summary | Hooks/bridge | desktop file bridge or configured WMA/Host driver |
| 豆包办公 | Bridge | no | host Skill | summary | no public event API assumed | authorized file bridge + host-native scheduled Worker |

## Capability rule

A host adapter must not advertise a capability merely because the UI appears to support a similar feature. `coldResume=true` requires a programmatic, stable way to address and resume/start work in the intended target session or runtime. `eventSubscription=true` requires an event stream or an explicit bridge that actually records durable events.

## Cross-adapter context

The Core already carries `{adapterId, sessionId}` in context references, but adapters currently reject foreign-adapter context unless a deliberate Context Bridge exists. This keeps transcript/privacy semantics explicit. A future bridge should convert an authoritative host snapshot into a bounded, provenance-carrying read-only summary rather than copying raw transcripts blindly.

## OpenCode

Target: OpenCode 2/V2. The adapter uses the generated `@opencode-ai/client` and can optionally start/discover the local service through `@opencode-ai/client/service`.

Install the beta client next to Flowit Workflow:

```bash
npm install @opencode-ai/client@beta
```

Then either set an existing server:

```bash
FLOWIT_WORKFLOW_ADAPTER=opencode \
FLOWIT_WORKFLOW_OPENCODE_URL=http://localhost:4096 \
flowit-workflow daemon --adapter=opencode
```

or omit the URL and allow `Service.ensure()` to obtain the local OpenCode service. The V2 client is beta, so this adapter is intentionally thin and isolated from Core.

The included `integrations/opencode/opencode.jsonc.example` shows how to expose Flowit MCP tools inside OpenCode.

## Codex

The Codex adapter launches the documented `codex app-server --stdio` integration surface. It uses v2 `thread/list`, `thread/resume`, `thread/read`, `turn/start`, `turn/completed`, and `skills/list`. Bound skills are passed as typed `skill` input items and are also named with `$skill-name` in the text instruction.

```bash
FLOWIT_WORKFLOW_ADAPTER=codex flowit-workflow daemon --adapter=codex
```

`integrations/codex/config.toml.example` exposes the Flowit MCP control plane to Codex. This is separate from the adapter's App Server process: MCP lets Codex call Flowit; App Server lets Flowit orchestrate Codex threads.

## WorkBuddy

WorkBuddy supports Skills, MCP, Automation and Claude-compatible Hooks. Flowit therefore offers two modes:

- `desktop-bridge`: Hooks record Session lifecycle; a WorkBuddy Skill/Automation processes the authorized bridge inbox.
- `managed-agent-driver`: set `FLOWIT_WORKFLOW_WORKBUDDY_DRIVER` to a JSON command array (or simple command line). Flowit writes one dispatch request to the driver's stdin and expects an `AgentDispatchResult` JSON on stdout. This is the seam for an enterprise WMA SDK/API or a maintained WorkBuddy Host CLI wrapper without hard-coding undocumented endpoints.

Example:

```bash
export FLOWIT_WORKFLOW_WORKBUDDY_DRIVER='["node","/opt/company/workbuddy-flowit-driver.mjs"]'
flowit-workflow daemon --adapter=workbuddy
```

Merge `integrations/workbuddy/settings.json.example` into `.codebuddy/settings.json`; configure `integrations/workbuddy/mcp.json.example` when the Agent itself should call Flowit tools; install the bridge worker Skill; and keep WorkBuddy's native permission controls enabled.

## 豆包办公

豆包办公/办公任务模式 currently has strong user-facing Skills, local-computer task execution and native scheduled tasks, but Flowit does not rely on an unverified public Session/Resume developer API. The adapter therefore advertises `coldResume=false`, `liveDispatch=false`, and uses the documented/observable host capability only through an authorized bridge folder.

Install/import `integrations/doubao-office/flowit-bridge-worker/SKILL.md` as a custom Skill, authorize the bridge folder, and create a豆包原生定时任务 to invoke it periodically. This produces useful Schedule/Pipeline integration without misrepresenting a UI feature as a stable programmatic API.
