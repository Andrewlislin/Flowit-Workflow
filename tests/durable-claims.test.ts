import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JsonWorkflowStore } from '../src/core/store.js'

const TEST_RETENTION_MS = 100 * 365 * 24 * 60 * 60 * 1_000

async function withStores(run: (a: JsonWorkflowStore, b: JsonWorkflowStore) => Promise<void>, maxRunHistory = 500): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-claims-')); const file = path.join(root, 'workflow.json')
  try { await run(new JsonWorkflowStore(file, maxRunHistory, [], 100_000, TEST_RETENTION_MS), new JsonWorkflowStore(file, maxRunHistory, [], 100_000, TEST_RETENTION_MS)) } finally { await rm(root, { recursive: true, force: true }) }
}

test('only one process can claim the same trigger lease', async () => withStores(async (a, b) => {
  const input = { kind: 'pipeline' as const, definitionId: 'p1', triggerKey: 'event:1', leaseDurationMs: 30_000, maxAttempts: 3, permanentDedupe: true, now: new Date('2026-08-26T00:00:00Z') }
  const [first, second] = await Promise.all([a.claimRun({ ...input, owner: 'worker-a' }), b.claimRun({ ...input, owner: 'worker-b' })])
  assert.equal([first.kind, second.kind].filter(kind => kind === 'claimed').length, 1)
  assert.equal([first.kind, second.kind].filter(kind => kind === 'busy').length, 1)
}))

test('failed trigger retries and completed is the terminal dedupe state while retained', async () => withStores(async (a, b) => {
  const base = { kind: 'pipeline' as const, definitionId: 'p1', triggerKey: 'event:2', leaseDurationMs: 1000, maxAttempts: 3, permanentDedupe: true }
  const first = await a.claimRun({ ...base, owner: 'worker-a', now: new Date('2026-08-26T00:00:00Z') }); assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') return
  await a.failRun(first.run.id, 'worker-a', 'temporary', { retryDelayMs: 0, deadLetter: false }, new Date('2026-08-26T00:00:01Z'))
  const retry = await b.claimRun({ ...base, owner: 'worker-b', now: new Date('2026-08-26T00:00:02Z') }); assert.equal(retry.kind, 'claimed'); if (retry.kind !== 'claimed') return; assert.equal(retry.run.attempt, 2)
  await b.completeRun(retry.run.id, 'worker-b', new Date('2026-08-26T00:00:03Z'))
  const duplicate = await a.claimRun({ ...base, owner: 'worker-a', now: new Date('2026-08-26T00:00:04Z') }); assert.equal(duplicate.kind, 'completed')
}))

test('stale lease can be recovered with completed node checkpoints', async () => withStores(async (a, b) => {
  const base = { kind: 'pipeline' as const, definitionId: 'p2', triggerKey: 'event:3', leaseDurationMs: 1000, maxAttempts: 3, permanentDedupe: true }
  const first = await a.claimRun({ ...base, owner: 'worker-a', now: new Date('2026-08-26T00:00:00Z') }); assert.equal(first.kind, 'claimed'); if (first.kind !== 'claimed') return
  await a.checkpointRun(first.run.id, 'worker-a', { nodeId: 'n1', adapterId: 'test', sessionId: 's1', loadedSkills: [], referencedSessions: [] }, 1000, new Date('2026-08-26T00:00:00.500Z'))
  const retry = await b.claimRun({ ...base, owner: 'worker-b', now: new Date('2026-08-26T00:00:02Z') }); assert.equal(retry.kind, 'claimed'); if (retry.kind !== 'claimed') return
  assert.equal(retry.run.attempt, 2); assert.deepEqual(retry.run.nodeResults?.map(row => row.nodeId), ['n1'])
}))

test('completed event dedupe survives bounded run-history pruning while its receipt is retained', async () => withStores(async (a) => {
  const base = { kind: 'pipeline' as const, definitionId: 'p3', triggerKey: 'event:retained', leaseDurationMs: 1000, maxAttempts: 3, permanentDedupe: true }
  const claimed = await a.claimRun({ ...base, owner: 'worker-a', now: new Date('2026-08-26T00:00:00Z') }); assert.equal(claimed.kind, 'claimed'); if (claimed.kind !== 'claimed') return
  await a.completeRun(claimed.run.id, 'worker-a', new Date('2026-08-26T00:00:01Z'))
  for (let index = 0; index < 5; index += 1) {
    const other = await a.claimRun({ kind: 'schedule', definitionId: `s${index}`, triggerKey: `s:${index}`, owner: 'worker-a', leaseDurationMs: 1000, maxAttempts: 1, now: new Date(`2026-08-26T00:00:0${index + 2}Z`) })
    if (other.kind === 'claimed') await a.completeRun(other.run.id, 'worker-a', new Date(`2026-08-26T00:00:1${index}Z`))
  }
  const snapshot = await a.snapshot(); assert.equal(snapshot.runs.some(run => run.triggerKey === 'event:retained'), false); assert.equal(snapshot.terminalReceipts.some(receipt => receipt.triggerKey === 'event:retained' && receipt.status === 'completed'), true)
  const duplicate = await a.claimRun({ ...base, owner: 'worker-b', now: new Date('2026-08-26T00:01:00Z') }); assert.equal(duplicate.kind, 'completed')
}, 2))

test('terminal receipts obey a bounded retention cap instead of growing without limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-receipt-retention-')); const file = path.join(root, 'workflow.json')
  const store = new JsonWorkflowStore(file, 1, [], 2, TEST_RETENTION_MS)
  try {
    for (let index = 0; index < 3; index += 1) {
      const claim = await store.claimRun({ kind: 'pipeline', definitionId: 'p', triggerKey: `event:${index}`, owner: 'worker', leaseDurationMs: 1_000, maxAttempts: 1, permanentDedupe: true, now: new Date(`2026-08-26T00:00:0${index}Z`) })
      assert.equal(claim.kind, 'claimed')
      if (claim.kind === 'claimed') await store.completeRun(claim.run.id, 'worker', new Date(`2026-08-26T00:00:1${index}Z`))
    }
    const snapshot = await store.snapshot()
    assert.equal(snapshot.terminalReceipts.length, 2)
    assert.equal(snapshot.terminalReceipts.some(receipt => receipt.triggerKey === 'event:0'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('audit pruning never removes an active lease or the latest automatic retry state', async () => withStores(async (a) => {
  const baseMs = Date.now()
  const createdAt = new Date(baseMs - 5_000).toISOString()
  await a.putPipeline({ id: 'retry', name: 'retry', trigger: { kind: 'manual' }, nodes: [], edges: [], status: 'active', createdAt, updatedAt: createdAt })

  const active = await a.claimRun({ kind: 'pipeline', definitionId: 'active', triggerKey: 'event:active', owner: 'worker-a', leaseDurationMs: 60_000, maxAttempts: 3, permanentDedupe: true, now: new Date(baseMs) })
  assert.equal(active.kind, 'claimed'); if (active.kind !== 'claimed') return

  const failed = await a.claimRun({ kind: 'pipeline', definitionId: 'retry', triggerKey: 'event:retry', owner: 'worker-a', leaseDurationMs: 1000, maxAttempts: 3, permanentDedupe: true, now: new Date(baseMs - 3_000) })
  assert.equal(failed.kind, 'claimed'); if (failed.kind !== 'claimed') return
  await a.failRun(failed.run.id, 'worker-a', 'temporary', { retryDelayMs: 60_000, deadLetter: false }, new Date(baseMs - 2_000))

  for (let index = 0; index < 4; index += 1) {
    const other = await a.claimRun({ kind: 'schedule', definitionId: `audit-${index}`, triggerKey: `audit:${index}`, owner: 'worker-a', leaseDurationMs: 1000, maxAttempts: 1, now: new Date(baseMs - 1_000 + index) })
    if (other.kind === 'claimed') await a.completeRun(other.run.id, 'worker-a')
  }

  const snapshot = await a.snapshot()
  assert.equal(snapshot.runs.some(run => run.id === active.run.id && run.status === 'running'), true)
  assert.equal(snapshot.runs.some(run => run.id === failed.run.id && run.status === 'failed'), true)
  assert.ok(snapshot.runs.length >= 2, 'recoverable rows may exceed the soft history cap')
}, 1))
