import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FileBridgeAgentAdapter, type BridgeDispatchEnvelope } from '../src/adapters/file-bridge.js'
import { acquireBridgeExecutionLease, type BridgeExecutionLeaseMetadata } from '../src/bridge/execution-lease.js'
import { publishCompletedBridgeReceipt, readCompletedBridgeReceipt } from '../src/bridge/receipt.js'
import { bridgeStatePaths } from '../src/bridge/state.js'
import type { AgentDispatchResult } from '../src/core/types.js'

async function waitForInbox(dir: string, count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const files = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.json')).sort()
    if (files.length >= count) return files
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${count} bridge requests`)
}

async function waitForReceipt(file: string, idempotencyKey: string): Promise<AgentDispatchResult> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await readCompletedBridgeReceipt(file, idempotencyKey)
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for bridge receipt')
}

async function ownerOf(claimDir: string): Promise<BridgeExecutionLeaseMetadata> { return JSON.parse(await readFile(path.join(claimDir, 'owner.json'), 'utf8')) as BridgeExecutionLeaseMetadata }

test('two requestIds with one idempotencyKey can execute the side effect only once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-idem-'))
  const adapter = new FileBridgeAgentAdapter({ adapterId: 'bridge-test', root, pollIntervalMs: 10, dispatchTimeoutMs: 3_000, executionLeaseMs: 1_000 })
  const paths = bridgeStatePaths('bridge-test', root)
  let sideEffects = 0
  try {
    const request = { correlationId: 'same-logical-node', sessionId: 'target', prompt: 'send one side effect', skills: [], contextRefs: [] }
    const first = adapter.dispatch(request)
    const second = adapter.dispatch(request)
    const files = await waitForInbox(paths.inboxDir, 2)

    const worker = async (file: string, owner: string): Promise<void> => {
      await mkdir(paths.processingDir, { recursive: true })
      const source = path.join(paths.inboxDir, file)
      const processing = path.join(paths.processingDir, file)
      await rename(source, processing)
      const envelope = JSON.parse(await readFile(processing, 'utf8')) as BridgeDispatchEnvelope
      const claim = await acquireBridgeExecutionLease(paths, envelope.idempotencyKey, owner, envelope.executionLeaseMs)
      let result: AgentDispatchResult
      if (claim.kind === 'acquired') {
        sideEffects += 1
        await new Promise(resolve => setTimeout(resolve, 80))
        result = { sessionId: envelope.request.sessionId, loadedSkills: envelope.request.skills, referencedSessions: envelope.request.contextRefs.map(ref => ref.sessionId), outputSummary: 'done once' }
        result = await publishCompletedBridgeReceipt(envelope.receiptPath, envelope.idempotencyKey, result)
        await claim.lease.release()
      } else {
        result = await waitForReceipt(envelope.receiptPath, envelope.idempotencyKey)
      }
      await mkdir(paths.outboxDir, { recursive: true })
      await writeFile(path.join(paths.outboxDir, `${envelope.requestId}.json`), `${JSON.stringify(result)}\n`, 'utf8')
    }

    await Promise.all([worker(files[0]!, 'worker-a'), worker(files[1]!, 'worker-b')])
    const [a, b] = await Promise.all([first, second])
    assert.equal(sideEffects, 1)
    assert.equal(a.outputSummary, 'done once')
    assert.equal(b.outputSummary, 'done once')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('expired takeover and old-owner renew cannot both retain ownership', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-renew-race-')); const paths = bridgeStatePaths('bridge-test', root)
  try {
    const t0 = new Date('2026-08-26T00:00:00.000Z')
    const first = await acquireBridgeExecutionLease(paths, 'logical', 'worker-a', 1_000, t0)
    assert.equal(first.kind, 'acquired'); if (first.kind !== 'acquired') return
    const expiredAt = new Date(t0.getTime() + 1_001)
    const [renewed, takeover] = await Promise.all([
      first.lease.renew(1_000, expiredAt),
      acquireBridgeExecutionLease(paths, 'logical', 'worker-b', 1_000, expiredAt),
    ])
    assert.equal(renewed, false)
    assert.equal(takeover.kind, 'acquired'); if (takeover.kind !== 'acquired') return
    assert.equal((await ownerOf(takeover.lease.claimDir)).ownerToken, takeover.lease.metadata.ownerToken)
    await takeover.lease.release()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('takeover and old-owner release cannot move or delete the replacement generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-release-race-')); const paths = bridgeStatePaths('bridge-test', root)
  try {
    const t0 = new Date('2026-08-26T00:00:00.000Z')
    const first = await acquireBridgeExecutionLease(paths, 'logical', 'worker-a', 1_000, t0)
    assert.equal(first.kind, 'acquired'); if (first.kind !== 'acquired') return
    const expiredAt = new Date(t0.getTime() + 1_001)
    const [released, takeover] = await Promise.all([
      first.lease.release(),
      acquireBridgeExecutionLease(paths, 'logical', 'worker-b', 1_000, expiredAt),
    ])
    assert.equal(takeover.kind, 'acquired'); if (takeover.kind !== 'acquired') return
    assert.ok(released === true || released === false)
    const owner = await ownerOf(takeover.lease.claimDir)
    assert.equal(owner.ownerToken, takeover.lease.metadata.ownerToken)
    await takeover.lease.release()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an old generation cannot write owner metadata after a new generation exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-old-owner-')); const paths = bridgeStatePaths('bridge-test', root)
  try {
    const t0 = new Date('2026-08-26T00:00:00.000Z')
    const first = await acquireBridgeExecutionLease(paths, 'logical', 'worker-a', 1_000, t0)
    assert.equal(first.kind, 'acquired'); if (first.kind !== 'acquired') return
    const expiredAt = new Date(t0.getTime() + 1_001)
    const takeover = await acquireBridgeExecutionLease(paths, 'logical', 'worker-b', 1_000, expiredAt)
    assert.equal(takeover.kind, 'acquired'); if (takeover.kind !== 'acquired') return
    assert.equal(await first.lease.renew(1_000, new Date(expiredAt.getTime() + 1)), false)
    assert.equal(await first.lease.release(), false)
    const owner = await ownerOf(takeover.lease.claimDir)
    assert.equal(owner.ownerToken, takeover.lease.metadata.ownerToken)
    await takeover.lease.release()
  } finally { await rm(root, { recursive: true, force: true }) }
})
