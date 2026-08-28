import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import { assertNoAutonomousSessionCycle } from '../src/core/domain.js'
import type {
  AgentAdapter,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentEvent,
  PipelineDefinition,
} from '../src/core/types.js'

class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly capabilities = {
    coldResume: true,
    liveDispatch: true,
    skillBinding: true,
    contextReference: 'summary' as const,
    eventSubscription: true,
  }
  readonly requests: AgentDispatchRequest[] = []
  private listener: ((event: AgentEvent) => Promise<void> | void) | undefined
  async listSessions() {
    return [{ adapterId: this.id, sessionId: 'a', status: 'idle' as const }]
  }
  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.requests.push(request)
    return {
      sessionId: request.sessionId,
      loadedSkills: request.skills,
      referencedSessions: request.contextRefs.map(ref => ref.sessionId),
      outputSummary: `done:${request.sessionId}`,
    }
  }
  subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }
  async emit(event: AgentEvent): Promise<void> {
    await this.listener?.(event)
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition timed out')
}

test('core dispatches through an adapter and binds normalized context/skills', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-core-'))
  const adapter = new FakeAdapter()
  const core = new FlowitOrchestrationCore(
    { storageFile: path.join(dir, 'state.json'), defaultAdapterId: 'fake', activeWorkers: false },
    [adapter],
  )
  try {
    const result = await core.dispatcher.dispatch({
      sessionId: 'target',
      prompt: 'work',
      skills: ['review', 'review'],
      contextRefs: [{ sessionId: 'source' }],
    })
    assert.equal(result.adapterId, 'fake')
    assert.deepEqual(adapter.requests[0]?.skills, ['review'])
    assert.deepEqual(
      adapter.requests[0]?.contextRefs.map(ref => [ref.adapterId, ref.sessionId]),
      [['fake', 'source']],
    )
  } finally {
    await core.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('event pipelines are durable and dedupe a replayed event id', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-event-'))
  const adapter = new FakeAdapter()
  const core = new FlowitOrchestrationCore(
    { storageFile: path.join(dir, 'state.json'), defaultAdapterId: 'fake' },
    [adapter],
  )
  try {
    const pipeline = await core.pipelines.create({
      name: 'handoff',
      trigger: {
        kind: 'agent_event',
        adapterId: 'fake',
        sessionId: 'source',
        event: 'turn_completed',
      },
      nodes: [
        {
          id: 'review',
          target: {
            adapterId: 'fake',
            sessionId: 'review',
            prompt: 'review it',
            skills: [],
            contextRefs: [],
          },
          inheritUpstreamContext: true,
        },
      ],
      edges: [],
    })
    await core.ready
    const event = {
      adapterId: 'fake',
      sessionId: 'source',
      kind: 'turn_completed' as const,
      eventId: 'event-1',
      at: new Date().toISOString(),
    }
    await adapter.emit(event)
    await adapter.emit(event)
    await waitUntil(async () => {
      const runs = (await core.store.snapshot()).runs.filter(
        run => run.definitionId === pipeline.id,
      )
      return adapter.requests.length > 0 && runs.length > 0
    })
    assert.equal(adapter.requests.length, 1)
    assert.equal(
      (await core.store.snapshot()).runs.filter(run => run.definitionId === pipeline.id).length,
      1,
    )
  } finally {
    await core.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('global autonomous cycle detection includes adapter identity', () => {
  const base = (
    id: string,
    triggerSession: string,
    targetSession: string,
  ): PipelineDefinition => ({
    id,
    name: id,
    trigger: {
      kind: 'agent_event',
      adapterId: 'fake',
      sessionId: triggerSession,
      event: 'turn_completed',
    },
    nodes: [
      {
        id: `${id}-node`,
        target: {
          adapterId: 'fake',
          sessionId: targetSession,
          prompt: 'x',
          skills: [],
          contextRefs: [],
        },
        inheritUpstreamContext: true,
      },
    ],
    edges: [],
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  assert.throws(
    () => assertNoAutonomousSessionCycle([base('a', 'A', 'B'), base('b', 'B', 'A')], 'fake'),
    /cycle/,
  )
  assert.doesNotThrow(() =>
    assertNoAutonomousSessionCycle(
      [
        base('a', 'A', 'B'),
        {
          ...base('b', 'B', 'A'),
          trigger: {
            kind: 'agent_event',
            adapterId: 'other',
            sessionId: 'B',
            event: 'turn_completed',
          },
        },
      ],
      'fake',
    ),
  )
})
