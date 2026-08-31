import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JsonWorkflowStore } from '../src/core/store.js'
import { BUILT_IN_ADAPTER_IDS, resolveConfiguredRuntime } from '../src/runtime-factory.js'
import type { WorkflowState } from '../src/core/types.js'

const EMPTY: WorkflowState = { version: 1, schedules: [], pipelines: [], eventInbox: [], runs: [], terminalReceipts: [], provisioningIntents: [] }

function legacyState(name: string): WorkflowState {
  const now = new Date('2026-08-26T00:00:00.000Z').toISOString()
  return {
    version: 1,
    schedules: [{ id: 'legacy-schedule', name, target: { adapterId: 'claude-code', sessionId: 's1', prompt: 'work', skills: [], contextRefs: [] }, timing: { kind: 'every', everySeconds: 3600 }, status: 'active', nextRunAt: '2026-08-27T00:00:00.000Z', createdAt: now, updatedAt: now }],
    pipelines: [], eventInbox: [], runs: [], terminalReceipts: [], provisioningIntents: [],
  }
}

async function writeState(file: string, state: WorkflowState): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8') }

test('default v0.4 configuration scans every built-in v0.3 adapter path, not only the current default', () => {
  const resolved = resolveConfiguredRuntime({ defaultAdapterId: 'claude-code', instanceId: 'default' })
  for (const adapterId of BUILT_IN_ADAPTER_IDS) assert.ok(resolved.legacyStorageFiles.some(file => file.endsWith(path.join('.flowit-workflow', adapterId, 'workflow.json'))), adapterId)
})

test('v0.4 empty default database is replaced by non-empty v0.3 legacy state and legacy file is archived', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-migrate-'))
  const legacy = path.join(root, 'codex', 'workflow.json')
  const target = path.join(root, 'instances', 'default', 'workflow.json')
  try {
    await writeState(legacy, legacyState('legacy task'))
    await writeState(target, EMPTY)
    const store = new JsonWorkflowStore(target, 500, [legacy])
    const state = await store.snapshot()
    assert.equal(state.version, 2)
    assert.equal(JSON.parse(await readFile(target, 'utf8')).version, 2)
    assert.equal(state.schedules[0]?.name, 'legacy task')
    await assert.rejects(readFile(legacy, 'utf8'), error => (error as NodeJS.ErrnoException).code === 'ENOENT')
    const archived = (await readdir(path.dirname(legacy))).filter(name => name.startsWith('workflow.json.migrated-v0.4-'))
    assert.equal(archived.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('multiple identical non-empty legacy stores migrate once and all are archived', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-migrate-identical-'))
  const first = path.join(root, 'codex', 'workflow.json')
  const second = path.join(root, 'claude-code', 'workflow.json')
  const target = path.join(root, 'instances', 'default', 'workflow.json')
  try {
    await writeState(first, legacyState('same task'))
    const reordered = legacyState('same task') as any
    await mkdir(path.dirname(second), { recursive: true })
    await writeFile(second, `${JSON.stringify({ terminalReceipts: reordered.terminalReceipts, runs: reordered.runs, eventInbox: reordered.eventInbox, pipelines: reordered.pipelines, schedules: reordered.schedules, version: reordered.version }, null, 2)}\n`, 'utf8')
    const state = await new JsonWorkflowStore(target, 500, [first, second]).snapshot()
    assert.equal(state.schedules[0]?.name, 'same task')
    await assert.rejects(readFile(first, 'utf8'), error => (error as NodeJS.ErrnoException).code === 'ENOENT')
    await assert.rejects(readFile(second, 'utf8'), error => (error as NodeJS.ErrnoException).code === 'ENOENT')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('different non-empty legacy databases fail closed rather than selecting by current default adapter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-migrate-multi-conflict-'))
  const first = path.join(root, 'codex', 'workflow.json')
  const second = path.join(root, 'claude-code', 'workflow.json')
  const target = path.join(root, 'instances', 'default', 'workflow.json')
  try {
    await writeState(first, legacyState('codex task'))
    await writeState(second, legacyState('claude task'))
    const store = new JsonWorkflowStore(target, 500, [first, second])
    await assert.rejects(store.snapshot(), /multiple legacy databases contain different/)
    assert.match(await readFile(first, 'utf8'), /codex task/)
    assert.match(await readFile(second, 'utf8'), /claude task/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('different non-empty new and legacy databases fail closed instead of silently selecting one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-migrate-conflict-'))
  const legacy = path.join(root, 'claude-code', 'workflow.json')
  const target = path.join(root, 'instances', 'default', 'workflow.json')
  try {
    await writeState(legacy, legacyState('legacy task'))
    await writeState(target, legacyState('new task'))
    const originalTarget = await readFile(target, 'utf8')
    const store = new JsonWorkflowStore(target, 500, [legacy])
    await assert.rejects(store.snapshot(), /workflow storage migration conflict/)
    assert.equal(await readFile(target, 'utf8'), originalTarget)
    assert.match(await readFile(legacy, 'utf8'), /legacy task/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('migration refuses to archive state while the v0.3 daemon pid is still alive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-migrate-live-'))
  const legacy = path.join(root, 'claude-code', 'workflow.json')
  const target = path.join(root, 'instances', 'default', 'workflow.json')
  try {
    await writeState(legacy, legacyState('legacy task'))
    await writeFile(path.join(path.dirname(legacy), 'daemon.pid'), `${process.pid}\n`, 'utf8')
    const store = new JsonWorkflowStore(target, 500, [legacy])
    await assert.rejects(store.snapshot(), /legacy Flowit Workflow daemon is still running/)
    assert.match(await readFile(legacy, 'utf8'), /legacy task/)
    await assert.rejects(readFile(target, 'utf8'), error => (error as NodeJS.ErrnoException).code === 'ENOENT')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('migration never deletes an incomplete legacy pid file after initialization grace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-migrate-incomplete-pid-'))
  const legacy = path.join(root, 'codex', 'workflow.json')
  const target = path.join(root, 'instances', 'default', 'workflow.json')
  const pidFile = path.join(path.dirname(legacy), 'daemon.pid')
  try {
    await writeState(legacy, legacyState('legacy task'))
    await writeFile(pidFile, '', 'utf8')
    const old = new Date(Date.now() - 10_000)
    await import('node:fs/promises').then(fs => fs.utimes(pidFile, old, old))
    const store = new JsonWorkflowStore(target, 500, [legacy])
    await assert.rejects(store.snapshot(), /occupied but does not contain a valid PID/)
    assert.equal(await readFile(pidFile, 'utf8'), '')
    assert.match(await readFile(legacy, 'utf8'), /legacy task/)
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('version 2 execution state is a fail-closed fence for version 1 workers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-mixed-version-fence-'))
  const target = path.join(root, 'workflow.json')
  try {
    await writeState(target, EMPTY)
    const store = new JsonWorkflowStore(target)
    assert.equal((await store.snapshot()).version, 2)
    const persisted = JSON.parse(await readFile(target, 'utf8')) as { version: number }
    assert.throws(() => {
      if (persisted.version !== 1) throw new Error('unsupported Flowit Workflow state')
    }, /unsupported Flowit Workflow state/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
