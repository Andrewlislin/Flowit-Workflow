import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  HostSetupRegistry,
  WorkBuddySetupProvider,
  applySetupMutation,
  createDefaultHostSetupRegistry,
  prepareSetupMutation,
  type HostSetupContext,
} from '../src/setup/index.js'

async function fixture(env: NodeJS.ProcessEnv = {}): Promise<{
  root: string
  home: string
  project: string
  packageRoot: string
  context: HostSetupContext
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-workbuddy-setup-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  await mkdir(path.join(packageRoot, 'dist'), { recursive: true })
  await mkdir(
    path.join(packageRoot, 'integrations', 'workbuddy', 'flowit-bridge-worker'),
    { recursive: true },
  )
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  await writeFile(path.join(packageRoot, 'dist', 'mcp-server.js'), '// mcp\n', 'utf8')
  await writeFile(path.join(packageRoot, 'dist', 'cli.js'), '// cli\n', 'utf8')
  await writeFile(
    path.join(packageRoot, 'integrations', 'workbuddy', 'flowit-bridge-worker', 'SKILL.md'),
    '---\nname: Flowit Workflow Bridge Worker\ndescription: test\n---\nworker\n',
    'utf8',
  )
  return {
    root,
    home,
    project,
    packageRoot,
    context: {
      cwd: project,
      homeDir: home,
      packageRoot,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: '22.20.0',
      env,
    },
  }
}

function registry(): HostSetupRegistry {
  return new HostSetupRegistry([new WorkBuddySetupProvider()])
}

async function readJson(file: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, any>
}

test('default setup registry includes the WorkBuddy provider', () => {
  assert.equal(createDefaultHostSetupRegistry().get('workbuddy')?.displayName, 'WorkBuddy')
})

test('WorkBuddy setup plans MCP, Skill, Hooks, Bridge directories, and ownership manifest', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareSetupMutation('setup', f.context, registry(), {
      target: 'workbuddy',
      scope: 'user',
      projectDir: f.project,
    })
    assert.deepEqual(prepared.plans[0]?.actions.map(row => row.id), [
      'merge-mcp',
      'install-skill',
      'merge-hooks',
      'ensure-bridge-directories',
      'write-manifest',
    ])
    assert.equal(prepared.plans[0]?.actions.every(row => row.requiresConfirmation), true)
    assert.match(prepared.plans[0]?.manualSteps.join('\n') ?? '', /Automation/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('WorkBuddy setup preserves unrelated MCP servers and Hooks and is idempotent', async () => {
  const f = await fixture()
  try {
    const mcpFile = path.join(f.home, '.workbuddy', 'mcp.json')
    const settingsFile = path.join(f.home, '.codebuddy', 'settings.json')
    await mkdir(path.dirname(mcpFile), { recursive: true })
    await mkdir(path.dirname(settingsFile), { recursive: true })
    await writeFile(
      mcpFile,
      `${JSON.stringify({ mcpServers: { github: { command: 'github-mcp' } }, custom: true }, null, 2)}\n`,
    )
    await writeFile(
      settingsFile,
      `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] }, model: 'test' }, null, 2)}\n`,
    )

    const r = registry()
    const options = { target: 'workbuddy', scope: 'user' as const, projectDir: f.project }
    const prepared = await prepareSetupMutation('setup', f.context, r, options)
    const applied = await applySetupMutation(prepared, f.context, r, true)
    assert.equal(applied.results[0]?.status, 'manual-action-required')

    const mcp = await readJson(mcpFile)
    assert.equal(mcp.custom, true)
    assert.equal(mcp.mcpServers.github.command, 'github-mcp')
    assert.equal(mcp.mcpServers['flowit-workflow'].env.FLOWIT_WORKFLOW_ADAPTER, 'workbuddy')
    assert.equal(mcp.mcpServers['flowit-workflow'].env.FLOWIT_WORKFLOW_MUTATIONS, '1')

    const settings = await readJson(settingsFile)
    assert.equal(settings.model, 'test')
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo existing')
    assert.equal(settings.hooks.SessionStart.length, 2)
    assert.equal(settings.hooks.Stop.length, 1)
    assert.equal(settings.hooks.SessionEnd.length, 1)

    const skillFile = path.join(
      f.home,
      '.codebuddy',
      'skills',
      'flowit-workflow-bridge-worker',
      'SKILL.md',
    )
    assert.match(await readFile(skillFile, 'utf8'), /Flowit Workflow Bridge Worker/)
    for (const dir of [
      'inbox', 'processing', 'outbox', 'cancellations',
      'cancelled', 'dead-letter', 'receipts', 'claims',
    ]) {
      assert.equal(
        (await stat(path.join(f.home, '.flowit-workflow', 'bridges', 'workbuddy', dir))).isDirectory(),
        true,
      )
    }

    const second = await prepareSetupMutation('setup', f.context, r, options)
    assert.deepEqual(second.plans[0]?.actions, [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('managed WorkBuddy driver removes the Desktop Automation blocker', async () => {
  const f = await fixture({ FLOWIT_WORKFLOW_WORKBUDDY_DRIVER: '["workbuddy-driver"]' })
  try {
    const r = registry()
    const options = { target: 'workbuddy', scope: 'user' as const, projectDir: f.project }
    const prepared = await prepareSetupMutation('setup', f.context, r, options)
    const applied = await applySetupMutation(prepared, f.context, r, true)
    assert.equal(applied.results[0]?.status, 'complete')
    assert.equal(applied.results[0]?.doctor?.status, 'healthy')
    assert.doesNotMatch(applied.results[0]?.manualSteps.join('\n') ?? '', /Automation/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('project-scoped WorkBuddy setup writes only project configuration and shared bridge state', async () => {
  const f = await fixture()
  try {
    const r = registry()
    const options = { target: 'workbuddy', scope: 'project' as const, projectDir: f.project }
    const prepared = await prepareSetupMutation('setup', f.context, r, options)
    await applySetupMutation(prepared, f.context, r, true)
    const projectMcp = await readJson(path.join(f.project, '.workbuddy', 'mcp.json'))
    assert.equal(projectMcp.mcpServers['flowit-workflow'].env.FLOWIT_WORKFLOW_ADAPTER, 'workbuddy')
    assert.match(
      await readFile(
        path.join(
          f.project,
          '.codebuddy',
          'skills',
          'flowit-workflow-bridge-worker',
          'SKILL.md',
        ),
        'utf8',
      ),
      /worker/,
    )
    await assert.rejects(readFile(path.join(f.home, '.workbuddy', 'mcp.json'), 'utf8'), /ENOENT/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('WorkBuddy setup fails closed on an existing unowned Flowit MCP entry', async () => {
  const f = await fixture()
  try {
    const mcpFile = path.join(f.home, '.workbuddy', 'mcp.json')
    await mkdir(path.dirname(mcpFile), { recursive: true })
    await writeFile(
      mcpFile,
      `${JSON.stringify({ mcpServers: { 'flowit-workflow': { command: 'custom-wrapper' } } }, null, 2)}\n`,
    )
    const r = registry()
    const options = { target: 'workbuddy', scope: 'user' as const, projectDir: f.project }
    const prepared = await prepareSetupMutation('setup', f.context, r, options)
    assert.deepEqual(prepared.plans[0]?.actions, [])
    assert.match(prepared.plans[0]?.warnings.join('\n') ?? '', /not owned/)
    const applied = await applySetupMutation(prepared, f.context, r, true)
    assert.equal(applied.results[0]?.status, 'failed')
    assert.equal((await readJson(mcpFile)).mcpServers['flowit-workflow'].command, 'custom-wrapper')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('WorkBuddy setup detects configuration changes between plan and apply', async () => {
  const f = await fixture()
  try {
    const r = registry()
    const options = { target: 'workbuddy', scope: 'user' as const, projectDir: f.project }
    const prepared = await prepareSetupMutation('setup', f.context, r, options)
    const mcpFile = path.join(f.home, '.workbuddy', 'mcp.json')
    await mkdir(path.dirname(mcpFile), { recursive: true })
    await writeFile(mcpFile, '{"mcpServers":{"other":{"command":"changed"}}}\n', 'utf8')
    await assert.rejects(
      applySetupMutation(prepared, f.context, r, true),
      /changed after planning/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('WorkBuddy repair restores installer-owned files after accidental deletion', async () => {
  const f = await fixture({ FLOWIT_WORKFLOW_WORKBUDDY_DRIVER: 'driver' })
  try {
    const r = registry()
    const options = { target: 'workbuddy', scope: 'user' as const, projectDir: f.project }
    await applySetupMutation(
      await prepareSetupMutation('setup', f.context, r, options),
      f.context,
      r,
      true,
    )
    const skillFile = path.join(
      f.home,
      '.codebuddy',
      'skills',
      'flowit-workflow-bridge-worker',
      'SKILL.md',
    )
    await rm(skillFile)
    const repair = await prepareSetupMutation('repair', f.context, r, options)
    assert.equal(repair.plans[0]?.actions.some(row => row.id === 'install-skill'), true)
    const result = await applySetupMutation(repair, f.context, r, true)
    assert.equal(result.results[0]?.status, 'complete')
    assert.match(await readFile(skillFile, 'utf8'), /worker/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('WorkBuddy uninstall removes only installer-owned config and retains bridge state', async () => {
  const f = await fixture({ FLOWIT_WORKFLOW_WORKBUDDY_DRIVER: 'driver' })
  try {
    const r = registry()
    const options = { target: 'workbuddy', scope: 'user' as const, projectDir: f.project }
    await applySetupMutation(
      await prepareSetupMutation('setup', f.context, r, options),
      f.context,
      r,
      true,
    )

    const mcpFile = path.join(f.home, '.workbuddy', 'mcp.json')
    const mcp = await readJson(mcpFile)
    mcp.mcpServers.other = { command: 'other' }
    await writeFile(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8')
    const settingsFile = path.join(f.home, '.codebuddy', 'settings.json')
    const settings = await readJson(settingsFile)
    settings.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'echo keep' }] })
    await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    const bridgeData = path.join(
      f.home,
      '.flowit-workflow',
      'bridges',
      'workbuddy',
      'outbox',
      'keep.json',
    )
    await writeFile(bridgeData, '{}\n', 'utf8')

    const uninstall = await prepareSetupMutation('uninstall', f.context, r, options)
    const applied = await applySetupMutation(uninstall, f.context, r, true)
    assert.equal(applied.results[0]?.status, 'complete')
    const afterMcp = await readJson(mcpFile)
    assert.equal(afterMcp.mcpServers['flowit-workflow'], undefined)
    assert.equal(afterMcp.mcpServers.other.command, 'other')
    const afterSettings = await readJson(settingsFile)
    assert.equal(afterSettings.hooks.SessionStart.length, 1)
    assert.equal(afterSettings.hooks.SessionStart[0].hooks[0].command, 'echo keep')
    await assert.rejects(
      readFile(
        path.join(
          f.home,
          '.codebuddy',
          'skills',
          'flowit-workflow-bridge-worker',
          'SKILL.md',
        ),
        'utf8',
      ),
      /ENOENT/,
    )
    assert.equal(await readFile(bridgeData, 'utf8'), '{}\n')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('WorkBuddy setup refuses malformed existing JSON instead of overwriting it', async () => {
  const f = await fixture()
  try {
    const mcpFile = path.join(f.home, '.workbuddy', 'mcp.json')
    await mkdir(path.dirname(mcpFile), { recursive: true })
    await writeFile(mcpFile, '{ invalid json\n', 'utf8')
    await assert.rejects(
      prepareSetupMutation('setup', f.context, registry(), {
        target: 'workbuddy',
        scope: 'user',
        projectDir: f.project,
      }),
      /cannot safely merge invalid JSON/,
    )
    assert.equal(await readFile(mcpFile, 'utf8'), '{ invalid json\n')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
