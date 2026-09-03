from pathlib import Path
from textwrap import dedent

state_path = Path('src/setup/providers/workbuddy-state.ts')
state = state_path.read_text(encoding='utf-8')

manual_start = state.index('export function workBuddyManualSteps(context: HostSetupContext): string[] {')
manual_end = state.index('\nexport function requiresDesktopAutomation', manual_start)
new_manual = dedent('''\
export function workBuddyManualSteps(context: HostSetupContext): string[] {
  const steps = ['Restart/reload WorkBuddy after setup so MCP, Skills, and lifecycle Hooks are reloaded.']
  if (requiresDesktopAutomation(context)) {
    const codeBuddyRoot = context.env.CODEBUDDY_CONFIG_DIR?.trim()
      ? path.resolve(context.env.CODEBUDDY_CONFIG_DIR)
      : path.join(context.homeDir, '.codebuddy')
    const skillFile = path.join(
      codeBuddyRoot,
      'skills',
      WORKBUDDY_SKILL_NAME,
      'SKILL.md',
    )
    steps.unshift(
      'Pause or remove any recurring WorkBuddy Automation that invokes the Flowit Workflow Bridge Worker. A native Automation creates a model task before the Worker can discover that the inbox is empty, so periodic polling creates empty sessions and consumes WorkBuddy quota.',
      'For interactive Desktop Bridge use, invoke the Worker once only after a real Flowit request has been queued. For unattended execution, configure FLOWIT_WORKFLOW_WORKBUDDY_DRIVER as a trusted event-driven managed driver. Do not use a model-powered recurring inbox poller.',
      `The installer-managed user Skill is ${skillFile}; it is not under ~/.workbuddy/skills/. Project scope uses <project>/.codebuddy/skills/${WORKBUDDY_SKILL_NAME}/SKILL.md.`,
      'Operational guidance: https://github.com/Andrewlislin/Flowit-Workflow/blob/main/docs/workbuddy-desktop-bridge.md',
    )
  }
  return steps
}
''')
state = state[:manual_start] + new_manual + state[manual_end:]

doctor_scope = state.index('export function workBuddyDoctorChecks(')
doctor_start = state.index('  checks.push(\n    requiresDesktopAutomation(context)', doctor_scope)
doctor_end = state.index('\n  return checks', doctor_start)
new_doctor = dedent('''\
  const modelPollingRequired = requiresDesktopAutomation(context)
  checks.push(
    modelPollingRequired
      ? {
          id: 'worker-execution',
          status: 'warning',
          summary: 'No event-driven managed WorkBuddy driver is configured',
          detail: 'Desktop Bridge requests can be processed only by an on-demand Worker invocation. Configure FLOWIT_WORKFLOW_WORKBUDDY_DRIVER for unattended execution.',
          repairable: false,
        }
      : { id: 'worker-execution', status: 'ok', summary: 'Managed WorkBuddy driver is configured' },
  )
  checks.push(
    modelPollingRequired
      ? {
          id: 'model-polling-safety',
          status: 'warning',
          summary: 'Recurring model-powered WorkBuddy inbox polling is unsupported',
          detail: 'Do not attach the Bridge Worker Skill to a recurring WorkBuddy Automation. WorkBuddy creates a model task before inbox inspection, so an empty poll still creates a visible session and consumes quota. Pause existing recurring Bridge Worker Automations; use on-demand invocation or an event-driven managed driver.',
          repairable: false,
        }
      : {
          id: 'model-polling-safety',
          status: 'ok',
          summary: 'Event-driven WorkBuddy dispatch avoids empty model polling',
        },
  )
''')
state = state[:doctor_start] + new_doctor + state[doctor_end:]
state_path.write_text(state, encoding='utf-8')

Path('integrations/workbuddy/flowit-bridge-worker/SKILL.md').write_text(dedent('''\
---
name: Flowit Workflow Bridge Worker
description: Execute one already-authorized Flowit Workflow inbox item inside WorkBuddy using normal WorkBuddy permission controls.
---

# Flowit Workflow Bridge Worker

## Invocation boundary

This Skill is a **request executor**, not a scheduler or queue poller.

- Do not attach it to a recurring WorkBuddy Automation. Every Automation run starts a model task before the inbox can be inspected, so an empty poll still creates a WorkBuddy session and consumes quota.
- Do not review Automation history, prior chat history, or unrelated WorkBuddy tasks before checking the inbox.
- Process at most one authorized request per invocation.
- Do not create a second WorkBuddy task, subagent, Dynamic Workflow, or simulated Flowit Pipeline merely to inspect or recover the Bridge.
- Use this Skill on demand after a real Flowit request is known to be queued, or let an event-driven managed driver invoke WorkBuddy only when work exists.

The user-scope installer-managed Skill normally lives under `~/.codebuddy/skills/flowit-workflow-bridge-worker/SKILL.md`, not `~/.workbuddy/skills/`.

## Empty inbox

Inspect `~/.flowit-workflow/bridges/workbuddy/inbox/` exactly once.

If it contains no authorized request JSON file, return exactly:

```text
FLOWIT_BRIDGE_EMPTY
```

Then stop. Do not write files, inspect task history, start research, create agents, or summarize the absence of work.

## Authorized request path

Use the following sequence only when an inbox request exists:

1. Atomically rename the oldest authorized `inbox/<requestId>.json` to `processing/<requestId>.json`.
2. Validate envelope v2 fields, including `idempotencyKey`, expiry/cancellation paths, `receiptPath`, `executionClaimPath`, and `executionLeaseMs`.
3. Check expiry/cancellation. Validate any existing receipt as **receipt v1 with `status: completed` and the same idempotencyKey**. Malformed or wrong-key receipts go to `receipts/quarantine/`; retryable failures are never shared receipts.
4. Acquire the idempotency execution lease. Renew, release, and expired takeover must hold `claims/.mutation/<sha256(idempotencyKey)>.lock/`; an expired owner cannot renew itself. If that mutex is orphaned or WorkBuddy filesystem policy blocks an exact lease operation, fail closed rather than deleting or bypassing it.
5. If another live execution lease owns the key, do not execute side effects. Wait for a valid completed receipt or retry takeover only after lease expiry.
6. Load every exact Skill in `request.skills`; missing Skills fail closed. Treat `context` only as read-only background.
7. Before the first and every subsequent side effect, re-check expiry/cancellation and lease ownership. Renew before expiry; if renewal fails, stop starting new side effects. Propagate `idempotencyKey` to host-native idempotency or fencing mechanisms.
8. On success, create receipt v1 `{version:1,idempotencyKey,status:"completed",completedAt,result}` by fully writing and syncing a temporary file, then publish it to `receiptPath` with a no-replace atomic link or rename-equivalent while the execution lease is still held. Never stream JSON directly into the stable receipt path.
9. After the completed receipt is durable, write plain `result` to `outbox/<requestId>.json`. On failure, write only this request's outbox `error`; do **not** create a shared completed receipt, so a Flowit retry can create a new transport request.
10. Release the execution lease under the mutation mutex only after durable publication or failed-side-effect shutdown, then move the processing request to the correct terminal or quarantine location.

## Fail-closed behavior

If validation, permissions, filesystem policy, lease ownership, receipt publication, Skill loading, or WorkBuddy quota prevents the exact protocol from completing:

- stop before starting any new side effect;
- preserve the original request and any already durable artifacts;
- write a bounded request-specific outbox error when `requestId` is known and the outbox can be written safely;
- never publish a completed receipt;
- never convert the Pipeline into a current-chat “blueprint” and continue manually;
- never start parallel researchers or replacement WorkBuddy tasks as a fallback;
- report one concise terminal marker such as `FLOWIT_BRIDGE_BLOCKED: LEASE_UNAVAILABLE`, `FLOWIT_BRIDGE_BLOCKED: FILESYSTEM_POLICY`, or `FLOWIT_BRIDGE_BLOCKED: RATE_LIMITED`.

A manual, current-chat execution is a separate user choice. It must not be represented as a successful Flowit run.
'''), encoding='utf-8')

Path('docs/workbuddy-desktop-bridge.md').write_text(dedent('''\
# WorkBuddy Desktop Bridge execution safety

WorkBuddy has two distinct Flowit execution modes:

```text
managed-agent-driver
= event-driven command integration
= preferred for unattended execution

desktop-bridge
= file transport plus on-demand WorkBuddy Skill invocation
= no automatic model polling
```

## Do not schedule the Bridge Worker as a recurring model task

A WorkBuddy native Automation creates an Agent task before the Bridge Worker can inspect the inbox. Consequently, a periodic Automation produces a visible WorkBuddy session and consumes model quota even when:

```text
~/.flowit-workflow/bridges/workbuddy/inbox/
```

is empty.

The instruction “exit silently when the inbox is empty” can reduce output, but it cannot prevent WorkBuddy from creating the Automation task. High-frequency polling can therefore produce hundreds of empty sessions and contribute to rate limiting.

Flowit no longer recommends model-powered periodic inbox polling.

## Immediate migration for existing installations

1. Pause or remove every recurring WorkBuddy Automation that invokes `Flowit Workflow Bridge Worker`.
2. Keep `~/.flowit-workflow/bridges/workbuddy/`; it may contain pending requests, receipts, cancellation records, and execution claims.
3. Run `flowit-workflow doctor workbuddy --json`.
4. For interactive use, invoke the Worker once only after a real Flowit request has been queued.
5. For unattended execution, configure `FLOWIT_WORKFLOW_WORKBUDDY_DRIVER` with a trusted event-driven command that runs only for an actual dispatch.

Do not delete or force-reset Bridge claims while a Flowit daemon, WorkBuddy Worker, or Automation may still be active.

## Installed paths

The default user-scope paths are deliberately separate:

```text
WorkBuddy MCP      ~/.workbuddy/mcp.json
Worker Skill       ~/.codebuddy/skills/flowit-workflow-bridge-worker/SKILL.md
Lifecycle Hooks    ~/.codebuddy/settings.json
Bridge state       ~/.flowit-workflow/bridges/workbuddy/
```

A prompt that points to `~/.workbuddy/skills/...` is using the wrong Skill root.

Project scope uses the corresponding `<project>/.workbuddy/` and `<project>/.codebuddy/` paths while retaining shared Bridge state under the user home.

## Failure semantics

The Worker must fail closed when it cannot prove request validity, Skill binding, lease ownership, receipt publication, or filesystem compatibility.

```text
Bridge failure
→ preserve request and durable artifacts
→ publish a request-specific error when safe
→ do not publish a completed receipt
→ do not simulate the Flowit Pipeline in the current chat
→ do not create replacement agents or research tasks
```

A current-chat manual execution may still be offered, but only as an explicit user-approved fallback and never as evidence that the Flowit run completed.

## Doctor interpretation

Without `FLOWIT_WORKFLOW_WORKBUDDY_DRIVER`, setup remains `manual-action-required`:

```text
transportConfigured = true
eventDrivenExecution = false
recurringModelPolling = unsupported
```

The MCP entry, Worker Skill, Hooks, and Bridge directories can all be installed correctly while unattended execution is still unavailable. `installed` and `execution-ready` are separate states.

## Future direction

The long-term WorkBuddy integration should use an event-driven managed driver backed by a documented WorkBuddy or CodeBuddy programmatic interface. Such a driver should start one Host task only for a real Flowit dispatch and should keep lease, receipt, retry, and quota handling in deterministic code rather than in a model prompt.
'''), encoding='utf-8')

Path('tests/workbuddy-polling-safety.test.ts').write_text(dedent('''\
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import type { HostSetupContext } from '../src/setup/types.js'
import {
  WORKBUDDY_HOOK_EVENTS,
  WORKBUDDY_MCP_SERVER,
  workBuddyDoctorChecks,
  workBuddyManualSteps,
  type WorkBuddyState,
} from '../src/setup/providers/workbuddy-state.js'

function context(env: NodeJS.ProcessEnv = {}): HostSetupContext {
  return {
    cwd: '/workspace',
    homeDir: '/home/test',
    packageRoot: '/package',
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '24.0.0',
    env,
  }
}

function healthyState(): WorkBuddyState {
  const desiredMcpEntry = { command: 'node', args: ['mcp-server.js'] }
  const desiredHookEntry = {
    hooks: [{ type: 'command', command: 'flowit bridge-hook workbuddy' }],
  }
  return {
    paths: {
      mcpFile: '/home/test/.workbuddy/mcp.json',
      settingsFile: '/home/test/.codebuddy/settings.json',
      skillFile: '/home/test/.codebuddy/skills/flowit-workflow-bridge-worker/SKILL.md',
      sourceSkillFile: '/package/integrations/workbuddy/flowit-bridge-worker/SKILL.md',
      mcpServerFile: '/package/dist/mcp-server.js',
      cliFile: '/package/dist/cli.js',
      bridgeRoot: '/home/test/.flowit-workflow/bridges/workbuddy',
      manifestFile: '/home/test/.flowit-workflow/setup/workbuddy-user.json',
    },
    mcp: {
      exists: true,
      hash: 'mcp',
      value: { mcpServers: { [WORKBUDDY_MCP_SERVER]: desiredMcpEntry } },
    },
    settings: {
      exists: true,
      hash: 'settings',
      value: {
        hooks: Object.fromEntries(
          WORKBUDDY_HOOK_EVENTS.map(event => [event, [desiredHookEntry]]),
        ),
      },
    },
    skill: { exists: true, content: 'worker', hash: 'skill' },
    sourceSkill: { content: 'worker', hash: 'skill' },
    desiredMcpEntry,
    desiredHookEntry,
    bridgeMissing: [],
    conflicts: [],
  }
}

test('WorkBuddy setup no longer recommends recurring model-powered inbox polling', () => {
  const steps = workBuddyManualSteps(context()).join('\n')
  assert.match(steps, /Pause or remove any recurring WorkBuddy Automation/)
  assert.match(steps, /FLOWIT_WORKFLOW_WORKBUDDY_DRIVER/)
  assert.match(steps, /\.codebuddy\/skills\/flowit-workflow-bridge-worker/)
  assert.match(steps, /not under ~\/\.workbuddy\/skills/)
  assert.doesNotMatch(
    steps,
    /enable one WorkBuddy native Automation that periodically invokes/i,
  )

  const managed = workBuddyManualSteps(context({
    FLOWIT_WORKFLOW_WORKBUDDY_DRIVER: '["node","driver.js"]',
  })).join('\n')
  assert.doesNotMatch(managed, /recurring WorkBuddy Automation/)
})

test('WorkBuddy doctor separates installed transport from quota-efficient execution', () => {
  const desktopChecks = workBuddyDoctorChecks(context(), healthyState())
  const worker = desktopChecks.find(check => check.id === 'worker-execution')
  const polling = desktopChecks.find(check => check.id === 'model-polling-safety')
  assert.equal(worker?.status, 'warning')
  assert.match(worker?.summary ?? '', /No event-driven managed WorkBuddy driver/)
  assert.equal(polling?.status, 'warning')
  assert.match(polling?.summary ?? '', /Recurring model-powered WorkBuddy inbox polling is unsupported/)
  assert.match(polling?.detail ?? '', /empty poll still creates a visible session and consumes quota/)

  const managedChecks = workBuddyDoctorChecks(context({
    FLOWIT_WORKFLOW_WORKBUDDY_DRIVER: 'driver',
  }), healthyState())
  assert.equal(
    managedChecks.find(check => check.id === 'worker-execution')?.status,
    'ok',
  )
  assert.equal(
    managedChecks.find(check => check.id === 'model-polling-safety')?.status,
    'ok',
  )
})

test('Bridge Worker is on-demand and forbids simulated Flowit fallback', async () => {
  const skill = await readFile(
    path.join(
      process.cwd(),
      'integrations',
      'workbuddy',
      'flowit-bridge-worker',
      'SKILL.md',
    ),
    'utf8',
  )
  assert.match(skill, /request executor.*not a scheduler or queue poller/is)
  assert.match(skill, /Do not attach it to a recurring WorkBuddy Automation/)
  assert.match(skill, /FLOWIT_BRIDGE_EMPTY/)
  assert.match(skill, /never convert the Pipeline into a current-chat “blueprint”/)
  assert.match(skill, /never start parallel researchers or replacement WorkBuddy tasks/)
  assert.doesNotMatch(
    skill,
    /For unattended desktop operation, bind this Skill to a WorkBuddy native Automation/i,
  )
})
'''), encoding='utf-8')
