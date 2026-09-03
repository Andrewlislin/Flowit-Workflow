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


test('public WorkBuddy guidance rejects recurring model polling', async () => {
  const [readme, readmeEn, setup] = await Promise.all([
    readFile(path.join(process.cwd(), 'README.md'), 'utf8'),
    readFile(path.join(process.cwd(), 'README.en.md'), 'utf8'),
    readFile(path.join(process.cwd(), 'docs', 'setup.md'), 'utf8'),
  ])
  for (const document of [readme, readmeEn, setup]) {
    assert.doesNotMatch(
      document,
      /enable one WorkBuddy native Automation that periodically invokes/i,
    )
  }
  assert.match(readme, /禁止模型定时空轮询/)
  assert.match(readmeEn, /not model-powered polling/)
  assert.match(setup, /Desktop Bridge execution is therefore \*\*on-demand only\*\*/)
  assert.match(setup, /workbuddy-desktop-bridge\.md/)
})
