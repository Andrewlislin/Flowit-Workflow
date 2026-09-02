import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {
  AgentAdapter,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentExecutionPreflightRequest,
  AgentExecutionPreflightResult,
  AgentSessionDescriptor,
  ProvisionedAgentSession,
  SessionProvisioningIntent,
} from '../src/core/types.js'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import {
  planExplicitRunOnce,
  startExplicitRunOnce,
  type ExplicitRunOnceInput,
} from '../src/explicit-run-once.js'

class CwdDriftAdapter implements AgentAdapter {
  readonly id = 'codex'
  readonly capabilities = {
    coldResume: true,
    liveDispatch: false,
    skillBinding: true,
    contextReference: 'summary' as const,
    eventSubscription: false,
    executionPreflight: true,
    sessionProvisioning: 'dedicated' as const,
    runtimeSelection: 'turn' as const,
    runtimeIntrospection: true,
    lockInspection: true,
  }
  releaseCount = 0
  dispatchCount = 0

  constructor(private readonly returnedCwd: string) {}

  async listSessions(): Promise<AgentSessionDescriptor[]> {
    return []
  }

  async preflightExecution(
    request: AgentExecutionPreflightRequest,
  ): Promise<AgentExecutionPreflightResult> {
    return {
      status: 'ready',
      evidence: {
        host: { executable: 'cwd-drift-adapter' },
        runtime: { verified: false },
        session: {
          strategy: request.session.kind,
          exclusive: request.session.kind === 'dedicated',
        },
      },
      blockers: [],
    }
  }

  async provisionSession(
    request: AgentExecutionPreflightRequest,
  ): Promise<ProvisionedAgentSession> {
    if (request.session.kind !== 'dedicated') {
      throw new Error('expected dedicated Session plan')
    }
    return {
      session: {
        adapterId: this.id,
        sessionId: 'cwd-drift-session',
        cwd: this.returnedCwd,
        status: 'idle',
      },
      managed: true,
      evidence: {
        host: { executable: 'cwd-drift-adapter' },
        runtime: { verified: false },
        session: {
          strategy: 'dedicated',
          sessionId: 'cwd-drift-session',
          exclusive: true,
        },
      },
    }
  }

  async releaseSession(): Promise<void> {
    this.releaseCount += 1
  }

  async dispatch(_request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.dispatchCount += 1
    throw new Error('cwd drift must be rejected before dispatch')
  }
}

function input(cwd: string, requestId: string): ExplicitRunOnceInput {
  return {
    requestId,
    name: 'Dedicated cwd contract',
    goal: 'Run only in the user-approved dedicated working directory.',
    target: {
      adapterId: 'codex',
      dedicatedCwd: cwd,
    },
    steps: [
      { id: 'work', prompt: 'perform bounded work' },
      { id: 'review', prompt: 'review bounded work' },
    ],
  }
}

async function coreWith(
  root: string,
  adapter: CwdDriftAdapter,
): Promise<FlowitOrchestrationCore> {
  const core = new FlowitOrchestrationCore(
    {
      storageFile: path.join(root, 'workflow.json'),
      defaultAdapterId: adapter.id,
      activeWorkers: false,
      retryDelayMs: 5,
    },
    [adapter],
  )
  await core.ready
  return core
}

test('fresh dedicated Session cwd drift is released before run admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-explicit-cwd-fresh-'))
  const approved = path.join(root, 'approved')
  const adapter = new CwdDriftAdapter(path.join(root, 'different'))
  const core = await coreWith(root, adapter)
  try {
    await assert.rejects(
      startExplicitRunOnce(core, input(approved, 'fresh-cwd-drift')),
      /working directory.*differs|dedicatedCwd/i,
    )
    const state = await core.store.snapshot()
    assert.equal(adapter.releaseCount, 1)
    assert.equal(adapter.dispatchCount, 0)
    assert.equal(state.runs.length, 0)
    assert.equal(state.provisioningIntents.length, 0)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('journaled provisioned Session cwd drift cannot be admitted after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-explicit-cwd-recovery-'))
  const approved = path.join(root, 'approved')
  const adapter = new CwdDriftAdapter(approved)
  const core = await coreWith(root, adapter)
  try {
    const request = input(approved, 'journaled-cwd-drift')
    const plan = planExplicitRunOnce(request)
    const now = new Date().toISOString()
    const intent: SessionProvisioningIntent = {
      id: plan.intentId,
      definitionId: plan.definitionId,
      triggerKey: plan.triggerKey,
      adapterId: 'codex',
      sessionPlan: structuredClone(plan.preflight.session) as Extract<
        AgentExecutionPreflightRequest['session'],
        { kind: 'dedicated' }
      >,
      requirement: structuredClone(plan.preflight.requirement),
      skills: [...plan.preflight.skills],
      pipelineSnapshot: structuredClone(plan.snapshot),
      status: 'provisioned',
      createdAt: now,
      updatedAt: now,
      provisioned: {
        session: {
          adapterId: 'codex',
          sessionId: 'journaled-cwd-drift-session',
          cwd: path.join(root, 'different'),
          status: 'idle',
        },
        managed: true,
        evidence: {
          host: { executable: 'cwd-drift-adapter' },
          runtime: { verified: false },
          session: {
            strategy: 'dedicated',
            sessionId: 'journaled-cwd-drift-session',
            exclusive: true,
          },
        },
      },
    }
    assert.equal((await core.store.reserveProvisioningIntent(intent)).created, true)

    await assert.rejects(
      startExplicitRunOnce(core, request),
      /working directory.*differs|dedicatedCwd/i,
    )
    const state = await core.store.snapshot()
    assert.equal(adapter.dispatchCount, 0)
    assert.equal(state.runs.length, 0)
    assert.equal(state.provisioningIntents.length, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
