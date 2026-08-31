import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentExecutionError } from '../src/core/index.js'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import type {
  AgentAdapter,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentExecutionPreflightRequest,
  AgentExecutionPreflightResult,
  AgentSessionDescriptor,
} from '../src/core/types.js'

class ContractAdapter implements AgentAdapter {
  readonly id: string
  readonly capabilities: AgentAdapter['capabilities']
  readonly dispatches: AgentDispatchRequest[] = []
  readonly preflights: AgentExecutionPreflightRequest[] = []
  dispatchError: Error | undefined
  preflightMode:
    | 'ready'
    | 'blocked'
    | 'unverified'
    | 'wrong-model'
    | 'missing-model' = 'ready'

  constructor(id: string, executionPreflight: boolean) {
    this.id = id
    this.capabilities = {
      coldResume: true,
      liveDispatch: false,
      skillBinding: true,
      contextReference: 'summary' as const,
      eventSubscription: false,
      ...(executionPreflight ? { executionPreflight: true } : {}),
    }
  }

  async listSessions(): Promise<AgentSessionDescriptor[]> {
    return [{ adapterId: this.id, sessionId: 'session-1', status: 'idle' }]
  }

  async preflightExecution(
    request: AgentExecutionPreflightRequest,
  ): Promise<AgentExecutionPreflightResult> {
    this.preflights.push(structuredClone(request))
    const verified = this.preflightMode !== 'unverified'
    const requestedModel = request.requirement.runtime?.model
    const actualModel = this.preflightMode === 'wrong-model'
      ? 'model-y'
      : this.preflightMode === 'missing-model'
        ? undefined
        : requestedModel
    return this.preflightMode === 'blocked'
      ? {
          status: 'blocked',
          blockers: [{ code: 'MODEL_UNAVAILABLE', message: 'missing', retryable: false }],
          evidence: {
            runtime: { verified: false },
            session: {
              strategy: request.session.kind,
              ...(request.session.kind === 'existing'
                ? { sessionId: request.session.sessionId }
                : {}),
            },
          },
        }
      : {
          status: 'ready',
          blockers: [],
          evidence: {
            runtime: {
              ...(requestedModel ? { requestedModel } : {}),
              ...(actualModel ? { actualModel } : {}),
              verified,
            },
            session: {
              strategy: request.session.kind,
              ...(request.session.kind === 'existing'
                ? { sessionId: request.session.sessionId }
                : {}),
            },
          },
        }
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.dispatches.push(structuredClone(request))
    if (this.dispatchError) throw this.dispatchError
    return {
      sessionId: request.sessionId,
      loadedSkills: [...request.skills],
      referencedSessions: request.contextRefs.map(ref => ref.sessionId),
    }
  }
}

function target(adapterId: string) {
  return {
    adapterId,
    sessionId: 'session-1',
    prompt: 'work',
    skills: [],
    contextRefs: [],
    execution: {
      runtime: { model: 'model-x', match: 'exact' as const },
    },
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition timed out')
}

test('Core dispatch fails closed when an Adapter cannot verify an execution contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-core-execution-legacy-'))
  const adapter = new ContractAdapter('legacy-execution-adapter', false)
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: false,
  }, [adapter])
  try {
    await core.ready
    await assert.rejects(
      core.dispatcher.dispatch(target(adapter.id)),
      /cannot verify the requested execution contract/,
    )
    assert.equal(adapter.dispatches.length, 0)

    await assert.rejects(
      core.dispatcher.dispatch({
        ...target(adapter.id),
        execution: {
          runtime: { model: 'model-x', match: 'inherit' },
        },
      }),
      /inherit runtime matching cannot specify/,
    )
    assert.equal(adapter.dispatches.length, 0)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Core re-preflights verified execution immediately before dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-core-execution-ready-'))
  const adapter = new ContractAdapter('verified-execution-adapter', true)
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: false,
  }, [adapter])
  try {
    await core.ready
    await core.dispatcher.dispatchWithCorrelation(target(adapter.id), [], 'dispatch-1', 2)
    assert.equal(adapter.preflights.length, 1)
    assert.equal(adapter.preflights[0]?.correlationId, 'dispatch-preflight:dispatch-1')
    assert.deepEqual(adapter.preflights[0]?.session, {
      kind: 'existing',
      sessionId: 'session-1',
    })
    assert.equal(adapter.dispatches.length, 1)
    assert.equal(adapter.dispatches[0]?.attempt, 2)

    adapter.preflightMode = 'unverified'
    await assert.rejects(
      core.dispatcher.dispatch(target(adapter.id)),
      /ready without verified runtime evidence/,
    )
    adapter.preflightMode = 'wrong-model'
    await assert.rejects(
      core.dispatcher.dispatch(target(adapter.id)),
      /reported actual model model-y instead of exact model model-x/,
    )
    adapter.preflightMode = 'missing-model'
    await assert.rejects(
      core.dispatcher.dispatch({
        ...target(adapter.id),
        execution: {
          runtime: { model: 'model-x', match: 'preferred' },
        },
      }),
      /did not report an actual model for preferred model model-x/,
    )
    assert.equal(adapter.dispatches.length, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('persistent Pipeline execution cannot bypass Core execution preflight', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-core-execution-pipeline-'))
  const adapter = new ContractAdapter('pipeline-contract-adapter', true)
  adapter.preflightMode = 'blocked'
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: false,
    leaseDurationMs: 1_000,
    maxPipelineAttempts: 3,
  }, [adapter])
  try {
    await core.ready
    const pipeline = await core.pipelines.create({
      name: 'contract pipeline',
      trigger: { kind: 'manual' },
      nodes: [{
        id: 'work',
        target: target(adapter.id),
        inheritUpstreamContext: false,
      }],
      edges: [],
    })
    await assert.rejects(core.pipelines.run(pipeline.id), /execution preflight blocked/)
    assert.equal(adapter.preflights.length, 1)
    assert.equal(adapter.dispatches.length, 0)
    const run = (await core.store.snapshot()).runs.find(
      candidate => candidate.definitionId === pipeline.id,
    )
    assert.equal(run?.status, 'dead_letter')
    assert.equal(run?.attempt, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('run-once execution-contract failures dead-letter on the first attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-core-execution-run-once-'))
  const adapter = new ContractAdapter('run-once-contract-adapter', true)
  adapter.dispatchError = new AgentExecutionError(
    'MODEL_UNAVAILABLE',
    'exact model rerouted',
    false,
  )
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: true,
    leaseDurationMs: 1_000,
    retryDelayMs: 10,
    maxPipelineAttempts: 3,
  }, [adapter])
  try {
    await core.ready
    const admitted = await core.runOncePipelines.startRunOnce({
      definitionId: 'execution-contract-run-once',
      triggerKey: 'execution-contract-trigger',
      snapshot: {
        version: 1,
        name: 'execution contract run-once',
        nodes: [{
          id: 'work',
          target: target(adapter.id),
          inheritUpstreamContext: false,
        }],
        edges: [],
      },
    })
    assert.equal(admitted.status, 'accepted')
    assert.ok(admitted.runId)
    await waitUntil(async () =>
      (await core.runOncePipelines.getRun(admitted.runId!))?.status === 'dead-letter',
    )
    const status = await core.runOncePipelines.getRun(admitted.runId!)
    assert.equal(status?.attempt, 1)
    assert.equal(adapter.dispatches.length, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('scheduled target execution cannot bypass Core execution preflight', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-core-execution-schedule-'))
  const adapter = new ContractAdapter('schedule-contract-adapter', true)
  adapter.preflightMode = 'blocked'
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: true,
    leaseDurationMs: 1_000,
    retryDelayMs: 10,
    maxScheduleAttempts: 3,
  }, [adapter])
  try {
    await core.ready
    const schedule = await core.scheduler.create({
      name: 'contract schedule',
      timing: { kind: 'at', at: new Date(Date.now() + 100).toISOString() },
      target: target(adapter.id),
    })
    await waitUntil(async () => {
      const current = (await core.scheduler.list()).find(item => item.id === schedule.id)
      return current?.status === 'failed'
    })
    assert.equal(adapter.preflights.length, 1)
    assert.equal(adapter.dispatches.length, 0)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
