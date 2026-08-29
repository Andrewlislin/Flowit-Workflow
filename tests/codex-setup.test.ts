import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CodexSetupProvider,
  createDefaultHostSetupRegistry,
  type HostSetupContext,
  type SetupApplyOptions,
  type SetupRequestOptions,
} from '../src/setup/index.js'
import { removeCodexManagedBlock } from '../src/setup/providers/codex-state.js'

interface Fixture {
  root: string
  home: string
  project: string
  packageRoot: string
  context: HostSetupContext
  provider: CodexSetupProvider
}

async function fixture(env: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-setup-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  const bin = path.join(root, 'bin')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(path.join(packageRoot, 'dist'), { recursive: true }),
    mkdir(bin, { recursive: true }),
  ])
  await writeFile(path.join(packageRoot, 'dist', 'mcp-server.js'), '// fixture\n', 'utf8')
  const codexName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  await writeFile(path.join(bin, codexName), '', 'utf8')
  const context: HostSetupContext = {
    cwd: project,
    homeDir: home,
    packageRoot,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    env: { PATH: bin, ...env },
  }
  return { root, home, project, packageRoot, context, provider: new CodexSetupProvider() }
}

const userOptions = (projectDir: string): SetupRequestOptions => ({
  scope: 'user',
  projectDir,
})
const userApply = (projectDir: string): SetupApplyOptions => ({
  scope: 'user',
  projectDir,
  assumeYes: true,
})
const projectOptions = (projectDir: string): SetupRequestOptions => ({
  scope: 'project',
  projectDir,
})
const projectApply = (projectDir: string): SetupApplyOptions => ({
  scope: 'project',
  projectDir,
  assumeYes: true,
})

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

test('default setup registry includes the Codex provider', () => {
  assert.equal(createDefaultHostSetupRegistry().get('codex') instanceof CodexSetupProvider, true)
})

test('Codex user setup preserves unrelated TOML and installs a managed stdio MCP block', async () => {
  const f = await fixture()
  const config = path.join(f.home, '.codex', 'config.toml')
  const original = '# keep this comment\nmodel = "gpt-5"\n'
  try {
    await mkdir(path.dirname(config), { recursive: true })
    await writeFile(config, original, 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions.map(row => row.id), ['write-manifest', 'upsert-mcp-block'])
    assert.equal(plan.actions.every(row => row.requiresConfirmation), true)

    const result = await f.provider.applySetup(f.context, plan, userApply(f.project))
    assert.equal(result.status, 'complete')
    const content = await readFile(config, 'utf8')
    assert.equal(content.startsWith(original), true)
    assert.match(content, /# >>> flowit-workflow setup codex v1/)
    assert.match(content, /\[mcp_servers\.flowit-workflow\]/)
    assert.match(content, /FLOWIT_WORKFLOW_ADAPTER = "codex"/)
    assert.match(content, /FLOWIT_WORKFLOW_MUTATIONS = "1"/)
    assert.match(content, /# <<< flowit-workflow setup codex v1/)

    const second = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(second.actions, [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Codex project setup writes project config and preserves Codex trust as a host gate', async () => {
  const f = await fixture()
  const config = path.join(f.project, '.codex', 'config.toml')
  try {
    const plan = await f.provider.planSetup(f.context, projectOptions(f.project))
    assert.equal(plan.manualSteps.some(step => /trust the project/i.test(step)), true)
    const result = await f.provider.applySetup(f.context, plan, projectApply(f.project))
    assert.equal(result.status, 'manual-action-required')
    assert.equal(await exists(config), true)
    assert.equal(await exists(path.join(f.home, '.codex', 'config.toml')), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Codex setup refuses an unmanaged same-name MCP table', async () => {
  const f = await fixture()
  const config = path.join(f.home, '.codex', 'config.toml')
  try {
    await mkdir(path.dirname(config), { recursive: true })
    await writeFile(
      config,
      '[mcp_servers.flowit-workflow]\ncommand = "custom"\nargs = []\n',
      'utf8',
    )
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions, [])
    assert.equal(plan.warnings.some(warning => /unmanaged/i.test(warning)), true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Codex setup rejects a stale plan when unrelated config changes after planning', async () => {
  const f = await fixture()
  const config = path.join(f.home, '.codex', 'config.toml')
  try {
    await mkdir(path.dirname(config), { recursive: true })
    await writeFile(config, 'model = "gpt-5"\n', 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    await writeFile(config, 'model = "gpt-5"\nsandbox_mode = "read-only"\n', 'utf8')
    await assert.rejects(
      f.provider.applySetup(f.context, plan, userApply(f.project)),
      /changed after planning|changed while setup was running/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Codex repair restores a missing installer-owned MCP block', async () => {
  const f = await fixture()
  const config = path.join(f.home, '.codex', 'config.toml')
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    const installed = await readFile(config, 'utf8')
    await writeFile(config, removeCodexManagedBlock(installed), 'utf8')

    const report = await f.provider.doctor(f.context, userOptions(f.project))
    assert.equal(report.status, 'unhealthy')
    const repair = await f.provider.planRepair(f.context, report, userOptions(f.project))
    assert.equal(repair.actions.some(row => row.id === 'upsert-mcp-block'), true)
    const repaired = await f.provider.applyRepair(f.context, repair, userApply(f.project))
    assert.equal(repaired.status, 'complete')
    assert.match(await readFile(config, 'utf8'), /\[mcp_servers\.flowit-workflow\]/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Codex uninstall removes only its block and preserves unrelated TOML byte-for-byte', async () => {
  const f = await fixture()
  const config = path.join(f.home, '.codex', 'config.toml')
  const original = '# user config\nmodel = "gpt-5"\n'
  try {
    await mkdir(path.dirname(config), { recursive: true })
    await writeFile(config, original, 'utf8')
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))

    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    const result = await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(result.status, 'complete')
    assert.equal(await readFile(config, 'utf8'), original)
    assert.equal(
      await exists(path.join(f.home, '.flowit-workflow', 'setup', 'codex-user.json')),
      false,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Codex uninstall removes a config file created solely by setup', async () => {
  const f = await fixture()
  const config = path.join(f.home, '.codex', 'config.toml')
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(await exists(config), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Codex uninstall preserves a user-modified managed block and reports partial cleanup', async () => {
  const f = await fixture()
  const config = path.join(f.home, '.codex', 'config.toml')
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    const installed = await readFile(config, 'utf8')
    await writeFile(
      config,
      installed.replace('FLOWIT_WORKFLOW_MUTATIONS = "1"', 'FLOWIT_WORKFLOW_MUTATIONS = "0"'),
      'utf8',
    )

    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    assert.equal(uninstall.actions.some(row => row.id === 'remove-mcp-block'), false)
    const result = await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(result.status, 'partial')
    assert.match(await readFile(config, 'utf8'), /FLOWIT_WORKFLOW_MUTATIONS = "0"/)
    assert.equal(
      await exists(path.join(f.home, '.flowit-workflow', 'setup', 'codex-user.json')),
      false,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Codex setup honors CODEX_HOME for user-scoped configuration', async () => {
  const custom = path.join(os.tmpdir(), `flowit-codex-home-${Date.now()}-${Math.random()}`)
  const f = await fixture({ CODEX_HOME: custom })
  try {
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, plan, userApply(f.project))
    assert.equal(await exists(path.join(custom, 'config.toml')), true)
    assert.equal(await exists(path.join(f.home, '.codex', 'config.toml')), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(custom, { recursive: true, force: true })
  }
})

test('Codex setup fails closed on malformed Flowit ownership markers', async () => {
  const f = await fixture()
  const config = path.join(f.home, '.codex', 'config.toml')
  try {
    await mkdir(path.dirname(config), { recursive: true })
    await writeFile(config, '# >>> flowit-workflow setup codex v1\n', 'utf8')
    await assert.rejects(
      f.provider.planSetup(f.context, userOptions(f.project)),
      /malformed or duplicate Flowit ownership markers/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
