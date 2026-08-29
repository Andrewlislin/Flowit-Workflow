import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { nextCalendarOccurrence } from '../src/core/domain.js'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import type { AgentAdapter, AgentDispatchRequest, AgentDispatchResult } from '../src/core/types.js'

class ScheduledPipelineAdapter implements AgentAdapter {
  readonly id = 'scheduled-test'
  readonly capabilities = {
    coldResume: true,
    liveDispatch: true,
    skillBinding: true,
    contextReference: 'summary' as const,
    eventSubscription: false,
  }
  readonly requests: AgentDispatchRequest[] = []
  async listSessions() { return [{ adapterId: this.id, sessionId: 'target', status: 'idle' as const }] }
  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.requests.push(request)
    return completedDispatch(request)
  }
}

class AbortAwareScheduledPipelineAdapter extends ScheduledPipelineAdapter {
  async dispatch(request: AgentDispatchRequest, signal?: AbortSignal): Promise<AgentDispatchResult> {
    this.requests.push(request)
    if (this.requests.length > 1) return completedDispatch(request)
    await new Promise<void>((_resolve, reject) => {
      const cleanup = (): void => signal?.removeEventListener('abort', abort)
      const abort = (): void => {
        cleanup()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    return completedDispatch(request)
  }
}

function completedDispatch(request: AgentDispatchRequest): AgentDispatchResult {
  return {
    sessionId: request.sessionId,
    loadedSkills: request.skills,
    referencedSessions: request.contextRefs.map(ref => ref.sessionId),
    outputSummary: 'done',
  }
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition timed out')
}

test('calendar schedules resolve daily and weekday occurrences in their IANA time zone', () => {
  assert.equal(
    nextCalendarOccurrence(
      { kind: 'calendar', timeZone: 'UTC', hour: 8, minute: 0 },
      new Date('2026-08-28T07:30:00.000Z'),
    ),
    '2026-08-28T08:00:00.000Z',
  )
  assert.equal(
    nextCalendarOccurrence(
      { kind: 'calendar', timeZone: 'UTC', hour: 9, minute: 0, daysOfWeek: [1, 2, 3, 4, 5] },
      new Date('2026-08-28T09:01:00.000Z'),
    ),
    '2026-08-31T09:00:00.000Z',
  )
})

test('calendar schedules skip a nonexistent local DST clock time instead of guessing', () => {
  assert.equal(
    nextCalendarOccurrence(
      { kind: 'calendar', timeZone: 'America/Los_Angeles', hour: 2, minute: 30 },
      new Date('2026-03-08T08:00:00.000Z'),
    ),
    '2026-03-09T09:30:00.000Z',
  )
})

test('two workers observing one scheduled pipeline occurrence execute its node only once', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-scheduled-pipeline-'))
  const file = path.join(dir, 'state.json')
  const controlAdapter = new ScheduledPipelineAdapter()
  const control = new FlowitOrchestrationCore(
    { storageFile: file, defaultAdapterId: controlAdapter.id, activeWorkers: false },
    [controlAdapter],
  )
  const at = new Date(Date.now() + 300).toISOString()
  const pipeline = await control.pipelines.create({
    name: 'scheduled pipeline',
    trigger: { kind: 'manual' },
    nodes: [{
      id: 'work',
      target: {
        adapterId: controlAdapter.id,
        sessionId: 'target',
        prompt: 'scheduled work',
        skills: [],
        contextRefs: [],
      },
      inheritUpstreamContext: false,
    }],
    edges: [],
  })
  const schedule = await control.scheduler.create({
    name: 'scheduled pipeline occurrence',
    pipelineId: pipeline.id,
    timing: { kind: 'at', at },
  })
  await control.dispose()

  const firstAdapter = new ScheduledPipelineAdapter()
  const secondAdapter = new ScheduledPipelineAdapter()
  const first = new FlowitOrchestrationCore(
    { storageFile: file, defaultAdapterId: firstAdapter.id, workerId: 'pipeline-worker-a', leaseDurationMs: 1_000 },
    [firstAdapter],
  )
  const second = new FlowitOrchestrationCore(
    { storageFile: file, defaultAdapterId: secondAdapter.id, workerId: 'pipeline-worker-b', leaseDurationMs: 1_000 },
    [secondAdapter],
  )
  try {
    await Promise.all([first.ready, second.ready])
    await waitUntil(async () => (
      await first.store.snapshot()
    ).schedules.find(item => item.id === schedule.id)?.status === 'completed')

    assert.equal(firstAdapter.requests.length + secondAdapter.requests.length, 1)
    const state = await first.store.snapshot()
    const scheduleRuns = state.runs.filter(run => run.kind === 'schedule' && run.definitionId === schedule.id)
    const pipelineRuns = state.runs.filter(run => run.kind === 'pipeline' && run.definitionId === pipeline.id)
    assert.equal(scheduleRuns.filter(run => run.status === 'completed').length, 1)
    assert.equal(pipelineRuns.filter(run => run.status === 'completed').length, 1)
    assert.equal(pipelineRuns[0]?.triggerKey, `schedule:${schedule.id}:${at}`)
  } finally {
    await Promise.all([first.dispose(), second.dispose()])
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancelling a scheduled pipeline does not let generic pipeline recovery revive it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-scheduled-cancel-'))
  const file = path.join(dir, 'state.json')
  const adapter = new AbortAwareScheduledPipelineAdapter()
  const core = new FlowitOrchestrationCore(
    {
      storageFile: file,
      defaultAdapterId: adapter.id,
      retryDelayMs: 100,
      maxPipelineAttempts: 3,
      maxScheduleAttempts: 3,
    },
    [adapter],
  )
  try {
    const pipeline = await core.pipelines.create({
      name: 'cancelled scheduled pipeline',
      trigger: { kind: 'manual' },
      nodes: [{
        id: 'work',
        target: {
          adapterId: adapter.id,
          sessionId: 'target',
          prompt: 'scheduled work',
          skills: [],
          contextRefs: [],
        },
        inheritUpstreamContext: false,
      }],
      edges: [],
    })
    const schedule = await core.scheduler.create({
      name: 'cancelled occurrence',
      pipelineId: pipeline.id,
      timing: { kind: 'at', at: new Date(Date.now() + 200).toISOString() },
    })
    await core.ready
    await waitUntil(() => adapter.requests.length === 1)
    await core.scheduler.cancel(schedule.id)
    await waitUntil(async () => (
      await core.store.snapshot()
    ).runs.some(run => run.kind === 'pipeline' && run.definitionId === pipeline.id && run.status === 'failed'))

    await new Promise(resolve => setTimeout(resolve, 1_300))
    assert.equal(adapter.requests.length, 1)
    const state = await core.store.snapshot()
    assert.equal(state.schedules.find(item => item.id === schedule.id)?.status, 'cancelled')
    assert.equal(
      state.runs.filter(run => run.kind === 'pipeline' && run.definitionId === pipeline.id).length,
      1,
    )
  } finally {
    await core.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
