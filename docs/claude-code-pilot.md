# Claude Code pilot adapter

The Claude Code adapter is the first non-DSH pilot for the AgentAdapter contract.

## Host surfaces used

The plugin packages:

- `.claude-plugin/plugin.json` — plugin identity;
- `hooks/hooks.json` — Session/turn/task/subagent lifecycle capture;
- `.mcp.json` — Workflow control plane;
- `skills/run-bound/SKILL.md` — private execution boundary used by dispatched runs;
- `skills/orchestrate/SKILL.md` — explicit human control entry.

Cold dispatch runs:

```text
claude --resume <session-id> -p "/flowit-workflow:run-bound <json>" \
  --output-format json --json-schema <schema> --plugin-dir <plugin-root>
```

The adapter requires the structured result to report `completed` and every requested Skill in `loadedSkills`; otherwise the Workflow node fails.

## Session registry and events

Hooks write:

- `~/.flowit-workflow/claude/sessions.json`
- `~/.flowit-workflow/claude/events.jsonl`

The daemon persists its acknowledged line cursor at:

- `~/.flowit-workflow/claude/events.cursor`

That allows Stop/TaskCompleted/SubagentStop events generated while the daemon is down to be consumed after restart without replaying already acknowledged events.

## Live-session rule

The pilot advertises `liveDispatch=false`. A session last marked `live` is rejected by external `claude --resume` by default, because two processes driving one transcript is not a safe concurrency contract.

For live Claude peers, use Claude Code's own live/background session facilities. `FLOWIT_WORKFLOW_CLAUDE_ALLOW_LIVE_RESUME=1` exists only as an explicit unsafe override for controlled testing.

## Context projection

The pilot does not parse Claude Code's transcript file as a compatibility API. It uses the bounded `last_assistant_message` supplied by lifecycle Hooks. This is lower fidelity than DSH native session-reference, but it has a clear stability and trust boundary.

Cross-adapter context (for example DSH → Claude) fails closed until a dedicated Context Bridge is implemented.

## Mutation consent boundary

The plugin MCP server exposes only read tools by default. To opt into model-visible mutation tools for the pilot, start Claude Code with:

```bash
FLOWIT_WORKFLOW_CLAUDE_MUTATIONS=1 claude --plugin-dir /path/to/Flowit-Workflow
```

This is a coarse deployment-level opt-in, not per-action consent. A future version should add a first-class human consent ledger before enabling autonomous schedule creation by default.

## Daemon

Schedules and event-triggered pipelines require one long-lived worker:

```bash
flowit-workflow claude-daemon --detach
```

or call the opt-in MCP `daemon_start` tool. A PID lease rejects duplicate daemons. CLI/MCP control processes run with `activeWorkers=false` and only mutate/query durable state.
