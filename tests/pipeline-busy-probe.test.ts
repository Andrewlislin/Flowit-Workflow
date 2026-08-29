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
} from '../src/core/types.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve
  })
  return { promise, resolve: () => resolvePromise?.() }
}

class ProbeAdapter implements AgentAdapter {
  readonly id = 'busy-probe'
  readonly capabilities = {
    coldResume: true,
    liveDispatch: true,
    skillBinding: true,
    contextReference: 'summary' as const,
    eventSubscription: false,
  }
  readonly requests: AgentDispatchRequest[] = []

  constructor(private readonly gate?: Promise<void>) {}

  async listSessions() {
    return [{ adapterId: this.id, sessionId: 'target', status: 'idle' as const }]
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.requests.push(request)
    await this.gate
    return {
      sessionId: request.sessionId,
      loadedSkills: request.skills,
      referencedSessions: request.contextRefs.map(ref => ref.sessionId),
      outputSummary: 'done',
    }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition timed out')
}

test('busy external trigger rechecks are read-only until the owner releases the trigger', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-pipeline-busy-probe-'))
  const storageFile = path.join(dir, 'workflow.json')
  const control = new FlowitOrchestrationCore(
    { storageFile, defaultAdapterId: 'busy-probe', activeWorkers: false },
  )
  const pipeline = await control.pipelines.create({
    name: 'busy probe',
    trigger: { kind: 'manual' },
    nodes: [{
      id: 'work',
      target: {
        adapterId: 'busy-probe',
        sessionId: 'target',
        prompt: 'work',
        skills: [],
        contextRefs: [],
      },
      inheritUpstreamContext: false,
    }],
    edges: [],
  })
  await control.dispose()

  const gate = deferred()
  const firstAdapter = new ProbeAdapter(gate.promise)
  const secondAdapter = new ProbeAdapter()
  const first = new FlowitOrchestrationCore(
    {
      storageFile,
      defaultAdapterId: firstAdapter.id,
      activeWorkers: false,
      workerId: 'busy-owner',
      leaseDurationMs: 1_000,
    },
    [firstAdapter],
  )
  const second = new FlowitOrchestrationCore(
    {
      storageFile,
      defaultAdapterId: secondAdapter.id,
      activeWorkers: false,
      workerId: 'busy-waiter',
      leaseDurationMs: 1_000,
    },
    [secondAdapter],
  )

  try {
    await Promise.all([first.ready, second.ready])
    const triggerKey = 'schedule:busy-probe:occurrence'
    const firstRun = first.pipelines.runWithTrigger(pipeline.id, triggerKey)
    await waitUntil(() => firstAdapter.requests.length === 1)

    const originalClaim = second.store.claimPipelineTrigger.bind(second.store)
    let claimCalls = 0
    second.store.claimPipelineTrigger = async input => {
      claimCalls += 1
      return originalClaim(input)
    }

    const secondRun = second.pipelines.runWithTrigger(pipeline.id, triggerKey)
    await waitUntil(() => claimCalls === 1)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(claimCalls, 1, 'busy waiting must not repeatedly rewrite the durable store')

    gate.resolve()
    await Promise.all([firstRun, secondRun])
    assert.equal(firstAdapter.requests.length, 1)
    assert.equal(secondAdapter.requests.length, 0)
  } finally {
    gate.resolve()
    await Promise.all([first.dispose(), second.dispose()])
    await rm(dir, { recursive: true, force: true })
  }
})
