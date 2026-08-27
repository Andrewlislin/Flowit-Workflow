import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JsonWorkflowStore } from '../src/core/store.js'
import type { ScheduledTask } from '../src/core/types.js'

function schedule(id: string, nextRunAt: string): ScheduledTask {
  const now = new Date().toISOString()
  return { id, name: id, target: { adapterId: 'fake', sessionId: 'target', prompt: 'work', skills: [], contextRefs: [] }, timing: { kind: 'every', everySeconds: 60 }, status: 'active', nextRunAt, createdAt: now, updatedAt: now }
}

test('cancellation after scheduler read but before claim cannot start an occurrence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-schedule-claim-'))
  const file = path.join(root, 'workflow.json')
  const schedulerStore = new JsonWorkflowStore(file)
  const controlStore = new JsonWorkflowStore(file)
  try {
    const scheduledAt = new Date(Date.now() - 1_000).toISOString()
    await schedulerStore.putSchedule(schedule('s1', scheduledAt))
    const observed = (await schedulerStore.snapshot()).schedules.find(item => item.id === 's1')
    assert.equal(observed?.status, 'active')
    assert.equal(observed?.nextRunAt, scheduledAt)

    let releaseClaim!: () => void
    const barrier = new Promise<void>(resolve => { releaseClaim = resolve })
    const claimPromise = (async () => {
      await barrier
      return schedulerStore.claimScheduleOccurrence({ scheduleId: 's1', expectedNextRunAt: scheduledAt, triggerKey: `schedule:s1:${scheduledAt}`, owner: 'worker-a', leaseDurationMs: 30_000, maxAttempts: 3 })
    })()

    await controlStore.transact(state => {
      const current = state.schedules.find(item => item.id === 's1')!
      current.status = 'cancelled'
      current.updatedAt = new Date().toISOString()
      delete current.nextRunAt
    })
    releaseClaim()

    const claim = await claimPromise
    assert.equal(claim.kind, 'not_current')
    assert.equal((await schedulerStore.snapshot()).runs.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a claim for an old nextRunAt cannot steal a newer occurrence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-schedule-next-'))
  const file = path.join(root, 'workflow.json')
  const first = new JsonWorkflowStore(file)
  const second = new JsonWorkflowStore(file)
  try {
    const oldAt = new Date(Date.now() - 2_000).toISOString()
    const newAt = new Date(Date.now() + 60_000).toISOString()
    await first.putSchedule(schedule('s2', oldAt))
    await second.transact(state => { const current = state.schedules.find(item => item.id === 's2')!; current.nextRunAt = newAt; current.updatedAt = new Date().toISOString() })
    const claim = await first.claimScheduleOccurrence({ scheduleId: 's2', expectedNextRunAt: oldAt, triggerKey: `schedule:s2:${oldAt}`, owner: 'worker-a', leaseDurationMs: 30_000, maxAttempts: 3 })
    assert.equal(claim.kind, 'not_current')
    assert.equal((await first.snapshot()).runs.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
