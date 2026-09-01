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
  getExplicitRunOnce,
  planExplicitRunOnce,
  startExplicitRunOnce,
  type ExplicitRunOnceInput,
} from '../src/explicit-run-once.js'

class DedicatedTestAdapter implements AgentAdapter {
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
  readonly dispatchSessions: string[] = []
  readonly dispatchPrompts: string[] = []
  listCount = 0
  preflightCount = 0
  provisionCount = 0
  releaseCount = 0

  async listSessions(): Promise<AgentSessionDescriptor[]> {
    this.listCount += 1
    return []
  }

  async preflightExecution(
    request: AgentExecutionPreflightRequest,
  ): Promise<AgentExecutionPreflightResult> {
    this.preflightCount += 1
    const requested = request.requirement.runtime
    const evidence = {
      host: { executable: 'codex-test', version: 'codex-test/1' },
      runtime: {
        ...(requested?.model ? { requestedModel: requested.model } : {}),
        ...(requested?.reasoningEffort
          ? { requestedReasoningEffort: requested.reasoningEffort }
          : {}),
        ...(requested?.model && requested.model !== 'unsupported-model'
          ? { actualModel: requested.model }
          : {}),
        ...(requested?.reasoningEffort
          ? { actualReasoningEffort: requested.reasoningEffort }
          : {}),
        verified: Boolean(requested?.model || requested?.reasoningEffort),
      },
      session: {
        strategy: request.session.kind,
        ...(request.session.kind === 'existing'
          ? { sessionId: request.session.sessionId }
          : {}),
        exclusive: request.session.kind === 'dedicated',
      },
    }
    if (requested?.model === 'unsupported-model') {
      return {
        status: 'blocked',
        evidence,
        blockers: [{
          code: 'MODEL_UNAVAILABLE',
          message: 'requested model is unavailable',
          retryable: false,
        }],
      }
    }
    return { status: 'ready', evidence, blockers: [] }
  }

  async provisionSession(
    request: AgentExecutionPreflightRequest,
  ): Promise<ProvisionedAgentSession> {
    assert.equal(request.session.kind, 'dedicated')
    this.provisionCount += 1
    const sessionId = `dedicated-${this.provisionCount}`
    return {
      session: {
        adapterId: this.id,
        sessionId,
        cwd: request.session.kind === 'dedicated' ? request.session.cwd : undefined,
        status: 'idle',
        name: 'Dedicated test Session',
      },
      managed: true,
      evidence: {
        host: { executable: 'codex-test', version: 'codex-test/1' },
        runtime: {
          ...(request.requirement.runtime?.model
            ? {
                requestedModel: request.requirement.runtime.model,
                actualModel: request.requirement.runtime.model,
              }
            : {}),
          ...(request.requirement.runtime?.reasoningEffort
            ? {
                requestedReasoningEffort: request.requirement.runtime.reasoningEffort,
                actualReasoningEffort: request.requirement.runtime.reasoningEffort,
              }
            : {}),
          verified: Boolean(request.requirement.runtime),
        },
        session: {
          strategy: 'dedicated',
          sessionId,
          exclusive: true,
        },
      },
    }
  }

  async releaseSession(): Promise<void> {
    this.releaseCount += 1
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.dispatchSessions.push(request.sessionId)
    this.dispatchPrompts.push(request.prompt)
    return {
      sessionId: request.sessionId,
      loadedSkills: [...request.skills],
      referencedSessions: request.contextRefs.map(ref => ref.sessionId),
      runId: `turn-${this.dispatchSessions.length}`,
      outputSummary: `stage-output-${this.dispatchSessions.length}`,
      executionEvidence: {
        host: { executable: 'codex-test', version: 'codex-test/1' },
        runtime: {
          ...(request.execution?.runtime?.model
            ? {
                requestedModel: request.execution.runtime.model,
                actualModel: request.execution.runtime.model,
              }
            : {}),
          ...(request.execution?.runtime?.reasoningEffort
            ? {
                requestedReasoningEffort: request.execution.runtime.reasoningEffort,
                actualReasoningEffort: request.execution.runtime.reasoningEffort,
              }
            : {}),
          verified: Boolean(request.execution?.runtime),
        },
        session: {
          strategy: 'existing',
          sessionId: request.sessionId,
          exclusive: true,
        },
      },
    }
  }
}

function input(root: string, requestId = 'dexterous-hand-report'): ExplicitRunOnceInput {
  return {
    requestId,
    name: '机器人灵巧手一级市场分析',
    goal: '形成一份高质量、可追溯、面向一级市场投资决策的机器人灵巧手行业分析。',
    target: {
      adapterId: 'codex',
      dedicatedCwd: root,
      skills: ['deep-research'],
      execution: {
        runtime: {
          model: 'model-ok',
          reasoningEffort: 'high',
          match: 'exact',
        },
      },
    },
    steps: [
      { id: 'scope', prompt: '界定行业边界、研究范围与证据标准。' },
      { id: 'evidence', prompt: '完成市场、技术、产业链与融资证据研究。' },
      { id: 'review', prompt: '综合投资判断并独立审核所有关键结论。' },
    ],
  }
}

async function coreWith(
  root: string,
  adapter: DedicatedTestAdapter,
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

async function waitForCompleted(
  core: FlowitOrchestrationCore,
  runId: string,
): Promise<Awaited<ReturnType<typeof getExplicitRunOnce>>> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const status = await getExplicitRunOnce(core, runId)
    if (status.status === 'completed') return status
    if (status.status === 'dead-letter') {
      throw new Error(status.error ?? 'run dead-lettered')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('explicit run-once completion timed out')
}

test('explicit run-once provisions one clean Session, reuses requestId, and rejects rebinding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-explicit-run-'))
  const adapter = new DedicatedTestAdapter()
  const core = await coreWith(root, adapter)
  try {
    const request = input(root)
    const started = await startExplicitRunOnce(core, request)
    assert.equal(started.action, 'accepted')
    assert.equal(started.status, 'running')
    assert.equal(started.sessionId, 'dedicated-1')
    assert.equal(typeof started.runId, 'string')

    const replay = await startExplicitRunOnce(core, request)
    assert.equal(replay.action, 'reused')
    assert.equal(replay.runId, started.runId)
    assert.equal(adapter.provisionCount, 1)
    assert.equal(adapter.listCount, 0)

    await assert.rejects(
      startExplicitRunOnce(core, {
        ...request,
        goal: `${request.goal} changed`,
      }),
      /already bound to different normalized input/,
    )
    assert.equal(adapter.provisionCount, 1)

    const completed = await waitForCompleted(core, started.runId!)
    assert.equal(completed.sessionId, 'dedicated-1')
    assert.equal(completed.nodeResults.length, 3)
    assert.deepEqual(
      adapter.dispatchSessions,
      ['dedicated-1', 'dedicated-1', 'dedicated-1'],
    )
    assert.equal(adapter.dispatchPrompts.every(prompt => prompt.includes(request.goal)), true)
    assert.equal(adapter.releaseCount, 0)
    assert.equal((await core.store.snapshot()).provisioningIntents.length, 0)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('capability approval completes before any preflight, intent, or Session mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-explicit-approval-'))
  const adapter = new DedicatedTestAdapter()
  const core = await coreWith(root, adapter)
  try {
    const base = input(root, 'network-approved')
    const request: ExplicitRunOnceInput = {
      ...base,
      target: {
        ...base.target,
        execution: {
          ...base.target.execution,
          requiredCapabilities: ['network'],
        },
      },
    }
    let releaseApproval: (() => void) | undefined
    let approvalCalls = 0
    const approvalGate = new Promise<void>(resolve => {
      releaseApproval = resolve
    })
    const pending = startExplicitRunOnce(
      core,
      request,
      {
        approvalProvider: async plan => {
          approvalCalls += 1
          assert.deepEqual(
            plan.preflight.requirement.requiredCapabilities,
            ['network', 'workspace-read'],
          )
          await approvalGate
        },
      },
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(approvalCalls, 1)
    assert.equal(adapter.preflightCount, 0)
    assert.equal(adapter.provisionCount, 0)
    assert.equal((await core.store.snapshot()).provisioningIntents.length, 0)

    releaseApproval?.()
    const started = await pending
    assert.equal(started.sessionId, 'dedicated-1')
    assert.equal(adapter.preflightCount, 1)
    assert.equal(adapter.provisionCount, 1)

    let replayApprovalCalls = 0
    const replay = await startExplicitRunOnce(
      core,
      request,
      {
        approvalProvider: async () => {
          replayApprovalCalls += 1
        },
      },
    )
    assert.equal(replay.action, 'reused')
    assert.equal(replay.runId, started.runId)
    assert.equal(replayApprovalCalls, 0)
    assert.equal(adapter.provisionCount, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit run-once fails model preflight before provisioning and rejects unsupported capabilities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-explicit-preflight-'))
  const adapter = new DedicatedTestAdapter()
  const core = await coreWith(root, adapter)
  try {
    const unsupported = input(root, 'unsupported-model')
    await assert.rejects(
      startExplicitRunOnce(core, {
        ...unsupported,
        target: {
          ...unsupported.target,
          execution: {
            runtime: { model: 'unsupported-model', match: 'exact' },
          },
        },
      }),
      /MODEL_UNAVAILABLE/,
    )
    assert.equal(adapter.provisionCount, 0)
    assert.equal((await core.store.snapshot()).provisioningIntents.length, 0)

    let approvalCalls = 0
    const unsupportedCapability = input(root, 'unsupported-browser')
    const preflightBefore = adapter.preflightCount
    await assert.rejects(
      startExplicitRunOnce(
        core,
        {
          ...unsupportedCapability,
          target: {
            ...unsupportedCapability.target,
            execution: {
              requiredCapabilities: ['browser'],
            },
          },
        },
        {
          approvalProvider: async () => {
            approvalCalls += 1
          },
        },
      ),
      /supports only workspace-read, workspace-write, and network/,
    )
    assert.equal(approvalCalls, 0)
    assert.equal(adapter.preflightCount, preflightBefore)
    assert.equal(adapter.provisionCount, 0)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('journaled provisioned Session is admitted after restart without provisioning twice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-explicit-recover-'))
  const adapter = new DedicatedTestAdapter()
  const core = await coreWith(root, adapter)
  try {
    const request = input(root, 'recover-provisioned')
    const plan = planExplicitRunOnce(request)
    assert.equal(plan.preflight.session.kind, 'dedicated')
    const sessionId = 'journaled-dedicated-1'
    const provisioned: ProvisionedAgentSession = {
      session: {
        adapterId: 'codex',
        sessionId,
        cwd: root,
        status: 'idle',
      },
      managed: true,
      evidence: {
        host: { executable: 'codex-test', version: 'codex-test/1' },
        runtime: {
          requestedModel: 'model-ok',
          requestedReasoningEffort: 'high',
          actualModel: 'model-ok',
          actualReasoningEffort: 'high',
          verified: true,
        },
        session: {
          strategy: 'dedicated',
          sessionId,
          exclusive: true,
        },
      },
    }
    const now = new Date().toISOString()
    const intent: SessionProvisioningIntent = {
      id: plan.intentId,
      definitionId: plan.definitionId,
      triggerKey: plan.triggerKey,
      adapterId: 'codex',
      sessionPlan: {
        kind: 'dedicated',
        cwd: root,
      },
      requirement: structuredClone(plan.preflight.requirement),
      skills: [...plan.preflight.skills],
      pipelineSnapshot: structuredClone(plan.snapshot),
      status: 'provisioned',
      createdAt: now,
      updatedAt: now,
      provisioned,
    }
    assert.equal((await core.store.reserveProvisioningIntent(intent)).created, true)

    const resumed = await startExplicitRunOnce(core, request)
    assert.equal(resumed.action, 'reused')
    assert.equal(resumed.sessionId, sessionId)
    assert.equal(adapter.provisionCount, 0)
    assert.equal(typeof resumed.runId, 'string')

    const completed = await waitForCompleted(core, resumed.runId!)
    assert.equal(completed.sessionId, sessionId)
    assert.deepEqual(
      adapter.dispatchSessions,
      [sessionId, sessionId, sessionId],
    )
    assert.equal((await core.store.snapshot()).provisioningIntents.length, 0)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
