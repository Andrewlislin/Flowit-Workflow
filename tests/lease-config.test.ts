import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'

test('Core rejects leaseDurationMs shorter than the heartbeat safety floor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-lease-config-'))
  try {
    assert.throws(() => new FlowitOrchestrationCore({ storageFile: path.join(root, 'state.json'), defaultAdapterId: 'fake', activeWorkers: false, leaseDurationMs: 999 }), /leaseDurationMs must be an integer >= 1000/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
