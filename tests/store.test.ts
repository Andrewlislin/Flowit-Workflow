import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JsonWorkflowStore } from '../src/store.js'

test('JSON store is durable and bounds run history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-workflow-'))
  try {
    const file = path.join(dir, 'state.json')
    const store = new JsonWorkflowStore(file, 2)
    await store.putRun({ id: '1', kind: 'pipeline', definitionId: 'p', triggerKey: 'a', status: 'completed', startedAt: '1' })
    await store.putRun({ id: '2', kind: 'pipeline', definitionId: 'p', triggerKey: 'b', status: 'completed', startedAt: '2' })
    await store.putRun({ id: '3', kind: 'pipeline', definitionId: 'p', triggerKey: 'c', status: 'completed', startedAt: '3' })
    const reloaded = new JsonWorkflowStore(file, 2)
    assert.deepEqual((await reloaded.snapshot()).runs.map(run => run.id), ['2', '3'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
