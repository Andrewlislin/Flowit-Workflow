import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import type {
  AgentAdapter,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentSessionDescriptor,
  RunOncePipelineSnapshot,
} from '../src/core/types.js'

class RecordingAdapter implements AgentAdapter {
  readonly id = 'test'
  readonly capabilities = {
    coldResume: true,
    liveDispatch: false,
    skillBinding: true,
    contextReference: 'summary' as const,
    eventSubscription: false,
  }
  readonly requests: AgentDispatchRequest[] = []
  delayMs = 0

  async listSessions(): Promise<AgentSessionDescriptor[]> {
    return [{ adapterId: 'test', sessionId: 'worker', status: 'idle' }]
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.requests.push(structuredClone(request))
    if (this.delayMs) await delay(this.delayMs)
    return {
      sessionId: request.sessionId,
      loadedSkills: [...request.skills],
      referencedSessions: [],
      outputSummary: `completed ${request.correlationId}`,
    }
  }
}

function snapshot(name = 'Recovered one-shot'): RunOncePipelineSnapshot {
  return {
    version: 1,
    name,
    nodes: [
      {
        id: 'plan',
        target: {
          adapterId: 'test',
          sessionId: 'worker',
          prompt: 'Plan.',
          skills: [],
          contextRefs: [],
        },
        inheritUpstreamContext: false,
      },
      {
        id: 'review',
        target: {
          adapterId: 'test',
          sessionId: 'worker',
          prompt: 'Review.',
          skills: [],
          contextRefs: [],
        },
        inheritUpstreamContext: true,
      },
    ],
    edges: [{ from: 'plan', to: 'review' }],
  }
}

test('snapshot-owned heartbeat renews a run without a permanent definition guard', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-run-once-heartbeat-'))
  const adapter = new RecordingAdapter()
  adapter.delayMs = 1_400
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: 'test',
    activeWorkers: false,
    leaseDurationMs: 1_000,
  }, [adapter])
  try {
    await core.ready
    const oneNode = snapshot('Heartbeat one-shot')
    oneNode.nodes = oneNode.nodes.slice(0, 1)
    oneNode.edges = []
    const admitted = await core.runOncePipelines.startRunOnce({
      definitionId: 'adaptive-run-once:heartbeat',
      triggerKey: 'adaptive:heartbeat',
      snapshot: oneNode,
    })
    assert.ok(admitted.runId)
    const initial = (await core.store.snapshot()).runs[0]!
    const initialExpiry = Date.parse(initial.leaseExpiresAt ?? '')
    await delay(750)
    const renewed = (await core.store.snapshot()).runs[0]!
    assert.equal(Date.parse(renewed.leaseExpiresAt ?? '') > initialExpiry, true)
    assert.equal((await core.store.snapshot()).pipelines.length, 0)
    await waitFor(async () => {
      const status = await core.runOncePipelines.getRun(admitted.runId!)
      return status?.status === 'completed' ? status : undefined
    })
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('a stale admitted run is recovered from its executable snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-run-once-recovery-'))
  const storageFile = path.join(root, 'workflow.json')
  const first = new FlowitOrchestrationCore({
    storageFile,
    defaultAdapterId: 'test',
    activeWorkers: false,
    workerId: 'worker:first',
    leaseDurationMs: 1_000,
    retryDelayMs: 20,
  }, [new RecordingAdapter()])
  try {
    await first.ready
    const admitted = await first.runOncePipelines.admit({
      definitionId: 'adaptive-run-once:recovery',
      triggerKey: 'adaptive:recovery',
      snapshot: snapshot(),
      now: new Date(Date.now() - 5_000),
    })
    assert.equal(admitted.status, 'accepted')
    await first.dispose()

    const recoveryAdapter = new RecordingAdapter()
    const second = new FlowitOrchestrationCore({
      storageFile,
      defaultAdapterId: 'test',
      activeWorkers: true,
      workerId: 'worker:second',
      leaseDurationMs: 1_000,
      retryDelayMs: 20,
    }, [recoveryAdapter])
    try {
      await second.ready
      await waitFor(async () => {
        const run = (await second.store.snapshot()).runs[0]
        return run?.status === 'completed' ? run : undefined
      })
      const state = await second.store.snapshot()
      assert.equal(state.pipelines.length, 0)
      assert.equal(state.runs[0]?.attempt, 2)
      assert.equal(recoveryAdapter.requests.length, 2)
      assert.equal(
        state.terminalReceipts.some(receipt =>
          receipt.definitionId === 'adaptive-run-once:recovery' &&
          receipt.triggerKey === 'adaptive:recovery' &&
          receipt.status === 'completed'),
        true,
      )
    } finally {
      await second.dispose()
    }
  } finally {
    await first.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error('timed out waiting for run-once state')
    await delay(10)
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}
