import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import type { AgentAdapter, AgentDispatchRequest, AgentDispatchResult, AgentEvent } from '../src/core/types.js'

class RetryAdapter implements AgentAdapter {
  readonly id = 'retry'
  readonly capabilities = { coldResume: true, liveDispatch: true, skillBinding: true, contextReference: 'summary' as const, eventSubscription: true }
  requests: AgentDispatchRequest[] = []
  failuresRemaining = 0
  failSessions = new Set<string>()
  blockFirst = false
  private listener?: (event: AgentEvent) => Promise<void> | void
  async listSessions() { return [{ adapterId: this.id, sessionId: 's', status: 'idle' as const }] }
  async dispatch(request: AgentDispatchRequest, signal?: AbortSignal): Promise<AgentDispatchResult> {
    this.requests.push(request)
    if (this.blockFirst && this.requests.length === 1) await waitForAbort(signal)
    if (this.failSessions.has(request.sessionId)) throw new Error(`failed:${request.sessionId}`)
    if (this.failuresRemaining-- > 0) throw new Error('temporary')
    return { sessionId: request.sessionId, loadedSkills: request.skills, referencedSessions: request.contextRefs.map(ref => ref.sessionId), outputSummary: `done:${request.sessionId}` }
  }
  subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void { this.listener = listener; return () => { this.listener = undefined } }
  async emit(event: AgentEvent): Promise<void> { await this.listener?.(event) }
}

async function waitForAbort(signal?: AbortSignal): Promise<never> {
  if (!signal) return new Promise<never>(() => undefined)
  signal.throwIfAborted()
  return new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')), { once: true }))
}
async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error('condition timed out') }

test('failed event pipeline retries the same trigger and eventually completes without rejecting the event listener', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-pipeline-retry-')); const adapter = new RetryAdapter(); adapter.failuresRemaining = 1
  const core = new FlowitOrchestrationCore({ storageFile: path.join(dir, 'state.json'), defaultAdapterId: 'retry', retryDelayMs: 25, leaseDurationMs: 1_000, maxPipelineAttempts: 3 }, [adapter])
  try {
    const pipeline = await core.pipelines.create({ name: 'retry', trigger: { kind: 'agent_event', adapterId: 'retry', sessionId: 'source', event: 'turn_completed' }, nodes: [{ id: 'n1', target: { adapterId: 'retry', sessionId: 'target', prompt: 'work', skills: [], contextRefs: [] }, inheritUpstreamContext: false }], edges: [] })
    await core.ready
    const event = { adapterId: 'retry', sessionId: 'source', kind: 'turn_completed' as const, eventId: 'evt-retry', at: new Date().toISOString() }
    await adapter.emit(event)
    await waitUntil(async () => (await core.store.snapshot()).runs.some(run => run.definitionId === pipeline.id && run.status === 'completed'))
    const runs = (await core.store.snapshot()).runs.filter(run => run.definitionId === pipeline.id)
    assert.deepEqual(runs.map(run => [run.attempt, run.status]), [[1, 'failed'], [2, 'completed']])
    assert.equal(adapter.requests.length, 2)
    assert.equal(adapter.requests[0]?.correlationId, adapter.requests[1]?.correlationId)
  } finally { await core.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('one failing pipeline cannot prevent sibling pipelines or later events from running', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-pipeline-fanout-')); const adapter = new RetryAdapter(); adapter.failSessions.add('bad')
  const core = new FlowitOrchestrationCore({ storageFile: path.join(dir, 'state.json'), defaultAdapterId: 'retry', leaseDurationMs: 1_000, maxPipelineAttempts: 1 }, [adapter])
  try {
    const trigger = { kind: 'agent_event' as const, adapterId: 'retry', sessionId: 'source', event: 'turn_completed' as const }
    const bad = await core.pipelines.create({ name: 'bad', trigger, nodes: [{ id: 'bad-node', target: { adapterId: 'retry', sessionId: 'bad', prompt: 'fail', skills: [], contextRefs: [] }, inheritUpstreamContext: false }], edges: [] })
    const good = await core.pipelines.create({ name: 'good', trigger, nodes: [{ id: 'good-node', target: { adapterId: 'retry', sessionId: 'good', prompt: 'work', skills: [], contextRefs: [] }, inheritUpstreamContext: false }], edges: [] })
    await core.ready

    await adapter.emit({ adapterId: 'retry', sessionId: 'source', kind: 'turn_completed', eventId: 'evt-1', at: new Date().toISOString() })
    await waitUntil(async () => { const runs = (await core.store.snapshot()).runs; return runs.some(run => run.definitionId === bad.id && run.status === 'dead_letter') && runs.some(run => run.definitionId === good.id && run.status === 'completed') })

    await adapter.emit({ adapterId: 'retry', sessionId: 'source', kind: 'turn_completed', eventId: 'evt-2', at: new Date().toISOString() })
    await waitUntil(async () => (await core.store.snapshot()).runs.filter(run => run.definitionId === good.id && run.status === 'completed').length === 2)
    assert.equal(adapter.requests.filter(request => request.sessionId === 'good').length, 2)
  } finally { await core.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('a host event queued behind a running pipeline is durably admitted and survives restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-event-inbox-')); const file = path.join(dir, 'state.json')
  const firstAdapter = new RetryAdapter(); firstAdapter.blockFirst = true
  const first = new FlowitOrchestrationCore({ storageFile: file, defaultAdapterId: 'retry', leaseDurationMs: 1_000, retryDelayMs: 10 }, [firstAdapter])
  let pipelineId = ''
  try {
    const pipeline = await first.pipelines.create({ name: 'durable inbox', trigger: { kind: 'agent_event', adapterId: 'retry', sessionId: 'source', event: 'turn_completed' }, nodes: [{ id: 'work', target: { adapterId: 'retry', sessionId: 'target', prompt: 'work', skills: [], contextRefs: [] }, inheritUpstreamContext: false }], edges: [] })
    pipelineId = pipeline.id
    await first.ready
    await firstAdapter.emit({ adapterId: 'retry', sessionId: 'source', kind: 'turn_completed', eventId: 'evt-a', at: new Date().toISOString() })
    await waitUntil(() => firstAdapter.requests.length === 1)
    await firstAdapter.emit({ adapterId: 'retry', sessionId: 'source', kind: 'turn_completed', eventId: 'evt-b', at: new Date().toISOString() })
    const beforeCrash = await first.store.snapshot()
    assert.ok(beforeCrash.eventInbox.some(row => row.pipelineId === pipeline.id && row.eventId === 'evt-b'))
  } finally { await first.dispose() }

  const secondAdapter = new RetryAdapter()
  const second = new FlowitOrchestrationCore({ storageFile: file, defaultAdapterId: 'retry', leaseDurationMs: 1_000, retryDelayMs: 10 }, [secondAdapter])
  try {
    await second.ready
    await waitUntil(async () => (await second.store.snapshot()).runs.some(run => run.definitionId === pipelineId && run.triggerKey.includes('evt-b') && run.status === 'completed'))
    assert.ok(secondAdapter.requests.length >= 1)
  } finally { await second.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('two workers observing one scheduled occurrence dispatch it only once', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-schedule-claim-')); const file = path.join(dir, 'state.json'); const controlAdapter = new RetryAdapter()
  const control = new FlowitOrchestrationCore({ storageFile: file, defaultAdapterId: 'retry', activeWorkers: false }, [controlAdapter])
  const at = new Date(Date.now() + 250).toISOString()
  const task = await control.scheduler.create({ name: 'once', timing: { kind: 'at', at }, target: { adapterId: 'retry', sessionId: 'target', prompt: 'once', skills: [], contextRefs: [] } }); await control.dispose()

  const firstAdapter = new RetryAdapter(); const secondAdapter = new RetryAdapter()
  const first = new FlowitOrchestrationCore({ storageFile: file, defaultAdapterId: 'retry', workerId: 'worker-a', leaseDurationMs: 1_000 }, [firstAdapter])
  const second = new FlowitOrchestrationCore({ storageFile: file, defaultAdapterId: 'retry', workerId: 'worker-b', leaseDurationMs: 1_000 }, [secondAdapter])
  try {
    await Promise.all([first.ready, second.ready])
    await waitUntil(async () => (await first.store.snapshot()).schedules.find(item => item.id === task.id)?.status === 'completed')
    assert.equal(firstAdapter.requests.length + secondAdapter.requests.length, 1)
    const runs = (await first.store.snapshot()).runs.filter(run => run.kind === 'schedule' && run.definitionId === task.id)
    assert.equal(runs.filter(run => run.status === 'completed').length, 1)
  } finally { await Promise.all([first.dispose(), second.dispose()]); await rm(dir, { recursive: true, force: true }) }
})
