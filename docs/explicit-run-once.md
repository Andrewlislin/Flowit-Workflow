# Explicit dedicated run-once workflows

This document describes the first non-Claude Host execution path that creates a clean dedicated Session instead of selecting an existing historical Session.

## Why this control exists

The trusted adaptive routing path uses Host-issued current-turn authority:

```text
workflow_assess
→ workflow_prepare
→ workflow_commit
```

Claude Code currently supplies that proof through `UserPromptSubmit` and `PreToolUse` Hooks. Codex does not expose an equivalent trusted current-turn Hook contract, so it must not receive a fake or impossible `callerToken` requirement.

At the same time, falling back to ordinary `dispatch` forces the caller to choose an existing `sessionId`. That is unsafe as the default for a new user task because the selected Thread can contain old context, an old model choice, or a stale lifecycle state.

The explicit run-once control therefore has a separate contract:

```text
Host-native tool approval
→ run_once_start
→ read-only preflight
→ durable provisioning intent
→ new dedicated Codex Thread
→ bounded 2–6 stage linear Pipeline
→ run_once_get
```

It is an explicit mutation, not adaptive routing authority.

## MCP tools

### `run_once_start`

The tool is currently advertised only by the Codex MCP configuration and only when Flowit mutation tools are enabled.

```json
{
  "requestId": "dexterous-hand-primary-market-2026-09-01",
  "name": "机器人灵巧手一级市场分析",
  "goal": "形成一份可追溯、面向一级市场投资决策的行业分析。",
  "target": {
    "dedicatedCwd": "/absolute/workspace/path",
    "skills": ["deep-research"],
    "execution": {
      "runtime": {
        "model": "gpt-5.5",
        "reasoningEffort": "high",
        "match": "preferred"
      }
    }
  },
  "steps": [
    {
      "id": "scope",
      "prompt": "界定行业边界、研究范围与证据标准。"
    },
    {
      "id": "evidence",
      "prompt": "完成市场、技术、产业链、公司与融资证据研究。"
    },
    {
      "id": "review",
      "prompt": "综合投资判断并独立审核关键结论。"
    }
  ]
}
```

The caller supplies no `sessionId`, Adapter override, context reference, schedule, edge list, or Claude authority token. Flowit binds every stage to the one Session it provisions and generates the linear edges itself.

### `run_once_get`

```json
{
  "runId": "<returned run id>"
}
```

The response contains durable status and node checkpoints for the explicit run. It does not mutate or resume a run.

## Idempotency

`requestId` is a strong idempotency key.

Flowit derives:

```text
definitionId = explicit-run-once:<sha256(requestId)>
triggerKey   = explicit:<sha256(normalized full input)>
```

Consequences:

```text
same requestId + same normalized input
→ reuse the existing provisioning intent, Session and run

same requestId + different normalized input
→ fail closed before another Session is provisioned
```

The conflict check covers in-flight provisioning intents, retained runs, and terminal receipts, so it remains effective after bounded run-history pruning.

## Provisioning recovery

Before calling the Host, Flowit persists a deterministic `SessionProvisioningIntent`.

```text
reserved
→ provisioned
→ run admitted
→ intent removed
```

If a process restarts after the actual Session ID was journaled but before run admission, replaying the same request admits the Pipeline using that Session and does not call `thread/start` again.

If the Host outcome is uncertain and no safe release can be proven, Flowit retains an `uncertain` intent and refuses automatic reprovisioning. This avoids duplicate Codex Threads after an ambiguous failure.

## Bounded first version

The first version intentionally supports only:

```text
Codex
one new dedicated Session
2–6 stages
one linear graph
one shared Skill list
optional runtime model / reasoning preference
downstream-only inherited summaries
manual run-once execution
```

It does not yet support:

```text
requiredCapabilities claims
network/browser permission pre-authorization
cross-Adapter execution
one Session per stage
persistent schedules
nested Flowit dispatch
Host-neutral adaptive authorization
```

Network, browser, shell and workspace approval remain Codex-native execution boundaries. Their absence from the new tool Schema is deliberate; Flowit must not claim verified permission evidence before that contract exists.
