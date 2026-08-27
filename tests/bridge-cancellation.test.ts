import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkBuddyAgentAdapter } from '../src/adapters/workbuddy.js'
import { bridgeStatePaths } from '../src/bridge/state.js'

async function waitForInbox(dir: string, excluded = new Set<string>()): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const file = (await readdir(dir).catch(() => [] as string[])).find(
      name => name.endsWith('.json') && !excluded.has(name),
    )
    if (file) return file
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('bridge inbox request did not appear')
}

test('timed-out file bridge request leaves cancellation tombstone and is removed from normal inbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-cancel-'))
  const adapter = new WorkBuddyAgentAdapter({ root, pollIntervalMs: 5, dispatchTimeoutMs: 40 })
  const paths = bridgeStatePaths('workbuddy', root)
  try {
    await assert.rejects(
      adapter.dispatch({
        correlationId: 'idem-timeout',
        sessionId: 's1',
        prompt: 'work',
        skills: [],
        contextRefs: [],
      }),
      /timed out/,
    )
    assert.equal((await readdir(paths.inboxDir)).filter(name => name.endsWith('.json')).length, 0)
    assert.equal(
      (await readdir(paths.cancellationsDir)).filter(name => name.endsWith('.json')).length,
      1,
    )
    assert.equal(
      (await readdir(paths.cancelledDir)).filter(name => name.endsWith('.json')).length,
      1,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('existing completed bridge receipt restores the session summary before fast return', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-receipt-'))
  const adapter = new WorkBuddyAgentAdapter({ root })
  const paths = bridgeStatePaths('workbuddy', root)
  const correlationId = 'receipt-recovery'
  try {
    await mkdir(paths.receiptsDir, { recursive: true })
    const digest = createHash('sha256').update(correlationId).digest('hex')
    await writeFile(
      path.join(paths.receiptsDir, `${digest}.json`),
      `${JSON.stringify({ version: 1, idempotencyKey: correlationId, status: 'completed', completedAt: new Date().toISOString(), result: { sessionId: 'target', loadedSkills: [], referencedSessions: [], outputSummary: 'recovered summary' } })}\n`,
      'utf8',
    )
    const result = await adapter.dispatch({
      correlationId,
      sessionId: 'target',
      prompt: 'work',
      skills: [],
      contextRefs: [],
    })
    assert.equal(result.outputSummary, 'recovered summary')
    const sessions = JSON.parse(await readFile(paths.sessionsFile, 'utf8')) as Array<{
      sessionId: string
      lastAssistantMessage?: string
    }>
    assert.equal(
      sessions.find(session => session.sessionId === 'target')?.lastAssistantMessage,
      'recovered summary',
    )
    assert.equal((await readdir(paths.inboxDir)).filter(name => name.endsWith('.json')).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a malformed stable receipt fails closed without moving or re-executing it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-corrupt-'))
  const adapter = new WorkBuddyAgentAdapter({ root, pollIntervalMs: 5, dispatchTimeoutMs: 2_000 })
  const paths = bridgeStatePaths('workbuddy', root)
  const correlationId = 'corrupt-receipt'
  try {
    await mkdir(paths.receiptsDir, { recursive: true })
    const digest = createHash('sha256').update(correlationId).digest('hex')
    const receiptFile = path.join(paths.receiptsDir, `${digest}.json`)
    const corrupt = '{"version":1,"idempotencyKey":'
    await writeFile(receiptFile, corrupt, 'utf8')
    await assert.rejects(
      adapter.dispatch({
        correlationId,
        sessionId: 'target',
        prompt: 'work',
        skills: [],
        contextRefs: [],
      }),
      /malformed|quarantine is disabled/,
    )
    assert.equal(await readFile(receiptFile, 'utf8'), corrupt)
    assert.equal(
      (await readdir(paths.inboxDir).catch(() => [] as string[])).filter(name =>
        name.endsWith('.json'),
      ).length,
      0,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed bridge attempt does not poison the shared receipt and the same logical task can retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-retry-'))
  const adapter = new WorkBuddyAgentAdapter({ root, pollIntervalMs: 5, dispatchTimeoutMs: 2_000 })
  const paths = bridgeStatePaths('workbuddy', root)
  const correlationId = 'retryable-error'
  try {
    const first = adapter.dispatch({
      correlationId,
      sessionId: 'target',
      prompt: 'work',
      skills: [],
      contextRefs: [],
    })
    const firstInbox = await waitForInbox(paths.inboxDir)
    const firstEnvelope = JSON.parse(
      await readFile(path.join(paths.inboxDir, firstInbox), 'utf8'),
    ) as { requestId: string }
    await writeFile(
      path.join(paths.outboxDir, `${firstEnvelope.requestId}.json`),
      `${JSON.stringify({ error: 'temporary host failure', sessionId: 'target', loadedSkills: [], referencedSessions: [] })}\n`,
      'utf8',
    )
    await assert.rejects(first, /temporary host failure/)

    const digest = createHash('sha256').update(correlationId).digest('hex')
    await assert.rejects(
      readFile(path.join(paths.receiptsDir, `${digest}.json`), 'utf8'),
      error => (error as NodeJS.ErrnoException).code === 'ENOENT',
    )

    const second = adapter.dispatch({
      correlationId,
      sessionId: 'target',
      prompt: 'work',
      skills: [],
      contextRefs: [],
    })
    const secondInbox = await waitForInbox(paths.inboxDir, new Set([firstInbox]))
    const secondEnvelope = JSON.parse(
      await readFile(path.join(paths.inboxDir, secondInbox), 'utf8'),
    ) as { requestId: string }
    await writeFile(
      path.join(paths.outboxDir, `${secondEnvelope.requestId}.json`),
      `${JSON.stringify({ sessionId: 'target', loadedSkills: [], referencedSessions: [], outputSummary: 'success on retry' })}\n`,
      'utf8',
    )
    const result = await second
    assert.equal(result.outputSummary, 'success on retry')
    const receipt = JSON.parse(
      await readFile(path.join(paths.receiptsDir, `${digest}.json`), 'utf8'),
    ) as { status: string }
    assert.equal(receipt.status, 'completed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
