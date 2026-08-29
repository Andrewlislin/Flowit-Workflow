import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ClaudeCodeSetupProvider,
  createDefaultHostSetupRegistry,
  type HostSetupContext,
  type SetupRequestOptions,
} from '../src/setup/index.js'

interface Fixture {
  root: string
  home: string
  project: string
  packageRoot: string
  bin: string
  context: HostSetupContext
  userOptions: SetupRequestOptions
}

async function fixture(withClaude = true): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-claude-setup-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  const bin = path.join(root, 'bin')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(path.join(packageRoot, '.claude-plugin'), { recursive: true }),
    mkdir(path.join(packageRoot, 'skills', 'run-bound'), { recursive: true }),
    mkdir(path.join(packageRoot, 'skills', 'orchestrate'), { recursive: true }),
    mkdir(path.join(packageRoot, 'dist'), { recursive: true }),
    mkdir(bin, { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@coaseedge/flowit-workflow', version: '0.4.0' }), 'utf8'),
    writeFile(path.join(packageRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'flowit-workflow', version: '0.2.0', description: 'fixture' }), 'utf8'),
    writeFile(path.join(packageRoot, 'skills', 'run-bound', 'SKILL.md'), '---\nname: run-bound\n---\nrun bound\n', 'utf8'),
    writeFile(path.join(packageRoot, 'skills', 'orchestrate', 'SKILL.md'), '---\nname: orchestrate\n---\norchestrate\n', 'utf8'),
    writeFile(path.join(packageRoot, 'dist', 'mcp-server.js'), 'export {}\n', 'utf8'),
    writeFile(path.join(packageRoot, 'dist', 'cli.js'), 'export {}\n', 'utf8'),
  ])
  if (withClaude) await writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', 'utf8')
  const context: HostSetupContext = {
    cwd: project,
    homeDir: home,
    packageRoot,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: '22.20.0',
    env: { PATH: bin },
  }
  return {
    root,
    home,
    project,
    packageRoot,
    bin,
    context,
    userOptions: { scope: 'user', projectDir: project },
  }
}

async function json(file: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, any>
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function userPluginRoot(fx: Fixture): string {
  return path.join(fx.home, '.claude', 'skills', 'flowit-workflow')
}

async function applyUserSetup(fx: Fixture, provider = new ClaudeCodeSetupProvider()) {
  const plan = await provider.planSetup(fx.context, fx.userOptions)
  const result = await provider.applySetup(fx.context, plan, { ...fx.userOptions, assumeYes: true })
  return { provider, plan, result }
}

test('default setup registry includes Claude Code provider', () => {
  const registry = createDefaultHostSetupRegistry()
  assert.equal(registry.require('claude-code').displayName, 'Claude Code')
})

test('Claude Code user setup installs a self-contained skills-directory plugin facade', async () => {
  const fx = await fixture()
  try {
    const provider = new ClaudeCodeSetupProvider()
    const plan = await provider.planSetup(fx.context, fx.userOptions)
    assert.equal(plan.actions[0]?.id, 'write-manifest')
    assert.equal(plan.actions.some(action => action.id === 'write:.mcp.json'), true)
    assert.equal(plan.actions.some(action => action.id === 'write:hooks/hooks.json'), true)
    assert.equal(plan.actions.every(action => action.requiresConfirmation), true)

    const result = await provider.applySetup(fx.context, plan, { ...fx.userOptions, assumeYes: true })
    assert.equal(result.status, 'complete')
    assert.equal(result.doctor?.status, 'healthy')

    const pluginRoot = userPluginRoot(fx)
    const plugin = await json(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))
    assert.equal(plugin.name, 'flowit-workflow')
    assert.equal(plugin.version, '0.4.0')

    const mcp = await json(path.join(pluginRoot, '.mcp.json'))
    const orchestration = mcp.mcpServers.orchestration
    assert.equal(orchestration.command, process.execPath)
    assert.deepEqual(orchestration.args, [path.join(fx.packageRoot, 'dist', 'mcp-server.js')])
    assert.equal(orchestration.env.FLOWIT_WORKFLOW_ADAPTER, 'claude-code')
    assert.equal(orchestration.env.FLOWIT_WORKFLOW_PLUGIN_ROOT, pluginRoot)
    assert.equal(orchestration.env.FLOWIT_WORKFLOW_CLAUDE_MUTATIONS, '1')

    const hooks = await json(path.join(pluginRoot, 'hooks', 'hooks.json'))
    assert.deepEqual(
      hooks.hooks.SessionStart[0].hooks[0].args,
      [path.join(fx.packageRoot, 'dist', 'cli.js'), 'claude-hook'],
    )
    assert.equal(await readFile(path.join(pluginRoot, 'skills', 'run-bound', 'SKILL.md'), 'utf8'), '---\nname: run-bound\n---\nrun bound\n')
    assert.equal(await readFile(path.join(pluginRoot, 'skills', 'orchestrate', 'SKILL.md'), 'utf8'), '---\nname: orchestrate\n---\norchestrate\n')
    assert.equal(await exists(path.join(fx.home, '.flowit-workflow', 'claude')), true)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Claude Code setup is idempotent after a successful user install', async () => {
  const fx = await fixture()
  try {
    const { provider } = await applyUserSetup(fx)
    const second = await provider.planSetup(fx.context, fx.userOptions)
    assert.deepEqual(second.actions, [])
    const doctor = await provider.doctor(fx.context, fx.userOptions)
    assert.equal(doctor.status, 'healthy')
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Claude Code project setup uses project skills scope and preserves host trust gates', async () => {
  const fx = await fixture()
  try {
    const provider = new ClaudeCodeSetupProvider()
    const options: SetupRequestOptions = { scope: 'project', projectDir: fx.project }
    const plan = await provider.planSetup(fx.context, options)
    assert.match(plan.warnings.join('\n'), /not portable|team-portable|current Flowit installation path/i)
    const result = await provider.applySetup(fx.context, plan, { ...options, assumeYes: true })
    assert.equal(result.status, 'manual-action-required')
    assert.match(result.manualSteps.join('\n'), /workspace-trust/i)
    assert.equal(
      await exists(path.join(fx.project, '.claude', 'skills', 'flowit-workflow', '.claude-plugin', 'plugin.json')),
      true,
    )
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Claude Code setup refuses to adopt an unowned existing plugin root', async () => {
  const fx = await fixture()
  try {
    const pluginRoot = userPluginRoot(fx)
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(path.join(pluginRoot, 'README.md'), 'user plugin\n', 'utf8')
    const provider = new ClaudeCodeSetupProvider()
    const plan = await provider.planSetup(fx.context, fx.userOptions)
    assert.deepEqual(plan.actions, [])
    assert.match(plan.warnings.join('\n'), /without a Flowit ownership manifest/i)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Claude Code apply rejects a stale plan when a target changes after planning', async () => {
  const fx = await fixture()
  try {
    const provider = new ClaudeCodeSetupProvider()
    const plan = await provider.planSetup(fx.context, fx.userOptions)
    const target = path.join(userPluginRoot(fx), 'skills', 'run-bound', 'SKILL.md')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'foreign\n', 'utf8')
    await assert.rejects(
      provider.applySetup(fx.context, plan, { ...fx.userOptions, assumeYes: true }),
      /changed after planning|ownership changed/i,
    )
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Claude Code repair restores a missing installer-owned Skill', async () => {
  const fx = await fixture()
  try {
    const { provider } = await applyUserSetup(fx)
    const skill = path.join(userPluginRoot(fx), 'skills', 'run-bound', 'SKILL.md')
    await rm(skill)
    const report = await provider.doctor(fx.context, fx.userOptions)
    assert.equal(report.status, 'unhealthy')
    const plan = await provider.planRepair(fx.context, report, fx.userOptions)
    assert.equal(plan.actions.some(action => action.id === 'write:skills/run-bound/SKILL.md'), true)
    const result = await provider.applyRepair(fx.context, plan, { ...fx.userOptions, assumeYes: true })
    assert.equal(result.status, 'complete')
    assert.equal(await exists(skill), true)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Claude Code clean uninstall removes managed plugin files and retains durable state', async () => {
  const fx = await fixture()
  try {
    const { provider } = await applyUserSetup(fx)
    const plan = await provider.planUninstall(fx.context, fx.userOptions)
    const result = await provider.applyUninstall(fx.context, plan, { ...fx.userOptions, assumeYes: true })
    assert.equal(result.status, 'complete')
    assert.equal(await exists(userPluginRoot(fx)), false)
    assert.equal(await exists(path.join(fx.home, '.flowit-workflow', 'claude')), true)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Claude Code uninstall preserves a user-modified managed file', async () => {
  const fx = await fixture()
  try {
    const { provider } = await applyUserSetup(fx)
    const modified = path.join(userPluginRoot(fx), 'skills', 'orchestrate', 'SKILL.md')
    await writeFile(modified, 'user modified\n', 'utf8')
    const plan = await provider.planUninstall(fx.context, fx.userOptions)
    assert.match(plan.warnings.join('\n'), /modified after setup/i)
    const result = await provider.applyUninstall(fx.context, plan, { ...fx.userOptions, assumeYes: true })
    assert.equal(result.status, 'partial')
    assert.equal(await readFile(modified, 'utf8'), 'user modified\n')
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Claude Code setup can stage the plugin before the host executable is installed', async () => {
  const fx = await fixture(false)
  try {
    const { result } = await applyUserSetup(fx)
    assert.equal(result.status, 'manual-action-required')
    assert.match(result.manualSteps.join('\n'), /Install\/authenticate Claude Code/i)
    assert.equal(await exists(path.join(userPluginRoot(fx), '.claude-plugin', 'plugin.json')), true)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})
