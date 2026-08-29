import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import {
  applyPresetInstall,
  createDefaultPresetRegistry,
  parsePresetCliArgs,
  preparePresetInstall,
} from '../src/preset/index.js'

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true } catch { return false }
}

test('default preset registry exposes the three product templates', () => {
  assert.deepEqual(
    createDefaultPresetRegistry().list().map(preset => preset.id),
    ['content-studio', 'research-lab', 'agent-team'],
  )
})

test('preset CLI parser supports the single-session novice path and role overrides', () => {
  const parsed = parsePresetCliArgs([
    'install', 'content-studio',
    '--adapter=workbuddy',
    '--session=all=session-main',
    '--session=writer=session-writer',
    '--role-adapter=writer=codex',
    '--skill=all=web-search',
    '--skill=writer=long-form-writing,fact-citations',
    '--input=AI infrastructure for enterprise readers',
    '--dry-run',
    '--json',
  ], '/tmp/project')
  assert.equal(parsed.command, 'install')
  assert.equal(parsed.install?.adapterId, 'workbuddy')
  assert.equal(parsed.install?.allSession, 'session-main')
  assert.equal(parsed.install?.sessions?.writer, 'session-writer')
  assert.equal(parsed.install?.roleAdapters?.writer, 'codex')
  assert.deepEqual(parsed.install?.allSkills, ['web-search'])
  assert.deepEqual(parsed.install?.skills?.writer, ['long-form-writing', 'fact-citations'])
  assert.equal(parsed.dryRun, true)
  assert.equal(parsed.json, true)
})

test('content-studio dry-run is useful before roles are bound', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-preset-plan-'))
  try {
    const plan = await preparePresetInstall({
      presetId: 'content-studio',
      projectDir: root,
      storageFile: path.join(root, 'workflow.json'),
    }, createDefaultPresetRegistry(), { cwd: root, homeDir: root, env: {} })
    assert.equal(plan.action, 'incomplete')
    assert.deepEqual(plan.missingRoles, ['radar', 'strategist', 'researcher', 'writer', 'fact-checker', 'editor'])
    assert.equal(plan.pipeline, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('content-studio installs one manual pipeline, creates workspace, and reuses an identical install', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-preset-install-'))
  const storage = path.join(root, 'workflow.json')
  const workspace = path.join(root, 'studio')
  const registry = createDefaultPresetRegistry()
  const options = {
    presetId: 'content-studio',
    adapterId: 'workbuddy',
    allSession: 'wb-session-1',
    input: 'AI engineering and enterprise automation',
    projectDir: root,
    workspace,
    storageFile: storage,
  } as const
  try {
    const plan = await preparePresetInstall(options, registry, { cwd: root, homeDir: root, env: {} })
    assert.equal(plan.action, 'create')
    assert.equal(plan.pipeline?.trigger.kind, 'manual')
    assert.equal(plan.pipeline?.nodes.length, 6)
    assert.equal(plan.pipeline?.nodes.every(node => node.target.sessionId === 'wb-session-1'), true)
    assert.equal(plan.pipeline?.nodes.every(node => node.target.adapterId === 'workbuddy'), true)
    assert.equal(plan.pipeline?.nodes[0]?.inheritUpstreamContext, false)
    assert.equal(plan.pipeline?.nodes.slice(1).every(node => node.inheritUpstreamContext), true)

    const installed = await applyPresetInstall(plan)
    assert.equal(installed.action, 'created')
    assert.equal(await exists(workspace), true)

    const second = await preparePresetInstall(options, registry, { cwd: root, homeDir: root, env: {} })
    assert.equal(second.action, 'reuse')
    assert.equal(second.existingPipelineId, installed.pipelineId)
    const reused = await applyPresetInstall(second)
    assert.equal(reused.action, 'reused')
    assert.equal(reused.pipelineId, installed.pipelineId)

    const core = new FlowitOrchestrationCore({ storageFile: storage, defaultAdapterId: 'workbuddy', activeWorkers: false })
    try {
      await core.ready
      const pipelines = await core.pipelines.list()
      assert.equal(pipelines.length, 1)
      assert.equal(pipelines[0]?.id, installed.pipelineId)
      assert.equal(pipelines[0]?.trigger.kind, 'manual')
      const state = JSON.parse(await readFile(storage, 'utf8')) as { runs: unknown[] }
      assert.equal(state.runs.length, 0, 'preset install must not execute the pipeline')
    } finally { await core.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('same pipeline name with a different preset definition fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-preset-conflict-'))
  const storage = path.join(root, 'workflow.json')
  const registry = createDefaultPresetRegistry()
  try {
    const first = await preparePresetInstall({
      presetId: 'content-studio', adapterId: 'workbuddy', allSession: 's1', input: 'AI',
      projectDir: root, storageFile: storage,
    }, registry, { cwd: root, homeDir: root, env: {} })
    await applyPresetInstall(first)
    await assert.rejects(
      preparePresetInstall({
        presetId: 'content-studio', adapterId: 'workbuddy', allSession: 's1', input: 'Climate technology',
        projectDir: root, storageFile: storage,
      }, registry, { cwd: root, homeDir: root, env: {} }),
      /already used by a different or ambiguous definition/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('research-lab requires an explicit research question', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-research-preset-'))
  try {
    const plan = await preparePresetInstall({
      presetId: 'research-lab', adapterId: 'claude-code', allSession: 'research-session',
      projectDir: root, storageFile: path.join(root, 'workflow.json'),
    }, createDefaultPresetRegistry(), { cwd: root, homeDir: root, env: {} })
    assert.equal(plan.action, 'incomplete')
    assert.equal(plan.missingRoles.length, 0)
    assert.equal(plan.warnings.some(warning => /requires .*研究问题/i.test(warning)), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('role adapter/session overrides render a real multi-host work graph', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-multihost-preset-'))
  try {
    const plan = await preparePresetInstall({
      presetId: 'agent-team',
      adapterId: 'workbuddy',
      allSession: 'main',
      sessions: { researcher: 'research', reviewer: 'review' },
      roleAdapters: { researcher: 'claude-code', reviewer: 'codex' },
      input: 'Produce a migration plan for a legacy service',
      projectDir: root,
      storageFile: path.join(root, 'workflow.json'),
    }, createDefaultPresetRegistry(), { cwd: root, homeDir: root, env: {} })
    assert.equal(plan.action, 'create')
    const adapters = Object.fromEntries(plan.pipeline!.nodes.map(node => [node.id, node.target.adapterId]))
    assert.deepEqual(adapters, {
      planner: 'workbuddy', researcher: 'claude-code', executor: 'workbuddy', reviewer: 'codex',
    })
    assert.deepEqual(plan.pipeline!.edges, [
      { from: 'planner', to: 'researcher' },
      { from: 'researcher', to: 'executor' },
      { from: 'executor', to: 'reviewer' },
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('DSH-only preset defaults to the Harness embedded workflow store', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-dsh-preset-'))
  try {
    const plan = await preparePresetInstall({
      presetId: 'agent-team', adapterId: 'dsh', allSession: 'dsh-session', input: 'Review a repository',
      projectDir: root,
    }, createDefaultPresetRegistry(), { cwd: root, homeDir: root, env: {} })
    assert.equal(plan.storageFile, path.join(root, '.flowit-workflow', 'dsh', 'workflow.json'))
    assert.equal(plan.instanceId, 'dsh')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('mixed DSH and root-daemon host bindings remain incomplete instead of pretending to be runnable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-dsh-mixed-preset-'))
  try {
    const plan = await preparePresetInstall({
      presetId: 'agent-team', adapterId: 'workbuddy', allSession: 'main',
      roleAdapters: { researcher: 'dsh' },
      input: 'Cross-host task', projectDir: root, storageFile: path.join(root, 'workflow.json'),
    }, createDefaultPresetRegistry(), { cwd: root, homeDir: root, env: {} })
    assert.equal(plan.action, 'incomplete')
    assert.equal(plan.warnings.some(warning => /cannot share a runnable root-daemon preset/i.test(warning)), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
