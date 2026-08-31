import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { handleClaudeRoutingHook } from '../src/claude-routing-hook.js'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import type {
  AgentAdapter,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentExecutionPreflightRequest,
  AgentExecutionPreflightResult,
  AgentSessionDescriptor,
  ProvisionedAgentSession,
} from '../src/core/types.js'
import {
  RoutingAuthorityService,
  commitPreparedWorkflow,
  prepareWorkflow,
  type PreparedWorkflowProposal,
  type RoutingCallerContext,
} from '../src/routing/index.js'

const SECRET = 'execution-preflight-test-secret-at-least-32-bytes'
const TASK = 'Implement a small HTML game, validate it, and independently review the result.'

class ProvisioningAdapter implements AgentAdapter {
  readonly id = 'provisioning-test'
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
  readonly preflights: AgentExecutionPreflightRequest[] = []
  readonly provisions: AgentExecutionPreflightRequest[] = []
  readonly dispatches: AgentDispatchRequest[] = []
  provisionFailure: Error | undefined

  async listSessions(): Promise<AgentSessionDescriptor[]> {
    return [{ adapterId: this.id, sessionId: 'existing', status: 'idle' }]
  }

  async preflightExecution(
    request: AgentExecutionPreflightRequest,
  ): Promise<AgentExecutionPreflightResult> {
    this.preflights.push(structuredClone(request))
    return {
      status: 'ready',
      blockers: [],
      evidence: {
        host: { executable: '/opt/test-agent', version: '1.2.3' },
        runtime: {
          requestedModel: request.requirement.runtime?.model,
          requestedReasoningEffort: request.requirement.runtime?.reasoningEffort,
          actualModel: request.requirement.runtime?.model,
          actualReasoningEffort: request.requirement.runtime?.reasoningEffort,
          verified: true,
        },
        session: {
          strategy: request.session.kind,
          exclusive: request.session.kind === 'dedicated',
          ...(request.session.kind === 'existing'
            ? { sessionId: request.session.sessionId }
            : {}),
        },
      },
    }
  }

  async provisionSession(
    request: AgentExecutionPreflightRequest,
  ): Promise<ProvisionedAgentSession> {
    this.provisions.push(structuredClone(request))
    if (this.provisionFailure) throw this.provisionFailure
    return {
      managed: true,
      session: {
        adapterId: this.id,
        sessionId: 'dedicated-1',
        cwd: request.session.kind === 'dedicated' ? request.session.cwd : undefined,
        status: 'idle',
      },
      evidence: {
        host: { executable: '/opt/test-agent', version: '1.2.3' },
        runtime: {
          requestedModel: request.requirement.runtime?.model,
          requestedReasoningEffort: request.requirement.runtime?.reasoningEffort,
          actualModel: request.requirement.runtime?.model,
          actualReasoningEffort: request.requirement.runtime?.reasoningEffort,
          verified: true,
        },
        session: {
          strategy: 'dedicated',
          sessionId: 'dedicated-1',
          exclusive: true,
        },
      },
    }
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.dispatches.push(structuredClone(request))
    return {
      sessionId: request.sessionId,
      loadedSkills: [...request.skills],
      referencedSessions: request.contextRefs.map(ref => ref.sessionId),
      outputSummary: `completed ${request.correlationId}`,
    }
  }
}

function caller(toolUseId: string): RoutingCallerContext {
  return {
    hostId: 'claude-code',
    hostSessionId: 'host-session',
    toolUseId,
  }
}

function confirmationToken(
  authority: RoutingAuthorityService,
  proposal: PreparedWorkflowProposal,
): string {
  assert.ok(proposal.confirmationCode)
  const output = handleClaudeRoutingHook({
    session_id: 'host-session',
    hook_event_name: 'UserPromptSubmit',
    prompt: `确认执行 ${proposal.confirmationCode}`,
  }, authority)
  const context = output.hookSpecificOutput?.additionalContext
  assert.ok(context)
  const envelope = JSON.parse(context.split('\n').at(-1)!) as Record<string, string>
  assert.equal(envelope.proposalHash, proposal.proposalHash)
  assert.ok(envelope.confirmationToken)
  return envelope.confirmationToken
}

async function waitForCompleted(core: FlowitOrchestrationCore, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = (await core.store.snapshot()).runs.find(item => item.id === runId)
    if (run?.status === 'completed') return
    if (run?.status === 'dead_letter') throw new Error(run.error ?? 'run dead-lettered')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`run ${runId} did not complete`)
}

test('prepare preflights without provisioning; commit provisions once and materializes the Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-execution-preflight-'))
  const adapter = new ProvisioningAdapter()
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: false,
    leaseDurationMs: 1_000,
    retryDelayMs: 10,
  }, [adapter])
  const authority = new RoutingAuthorityService({
    mode: 'suggest',
    secret: SECRET,
    stateFile: path.join(root, 'authority.json'),
    requireCallerAttestation: true,
  })
  try {
    await core.ready
    const authorityToken = authority.issueHostAuthority({
      task: TASK,
      explicitIntent: 'force-flowit',
      hostId: 'claude-code',
      hostSessionId: 'host-session',
      turnNonce: 'turn-1',
    })
    const assessment = authority.assess({
      task: TASK,
      authorityToken,
      signals: {
        taskKind: 'coding',
        distinctStages: 2,
        decomposability: 3,
        durabilityNeed: 2,
        reviewNeed: 2,
        ambiguity: 0,
        sideEffectRisk: 'reversible',
      },
    }, caller('assess'))
    const before = await core.store.snapshot()
    const proposal = await prepareWorkflow(
      core,
      authority,
      {
        assessmentToken: assessment.assessmentToken,
        maxNodes: 2,
        target: {
          adapterId: adapter.id,
          dedicatedCwd: root,
          execution: {
            runtime: {
              model: 'gpt-test-luna',
              reasoningEffort: 'high',
              match: 'exact',
            },
            requiredCapabilities: ['workspace-write', 'shell'],
          },
        },
      },
      { callerContext: caller('prepare') },
    )

    assert.equal(adapter.preflights.length, 1)
    assert.equal(adapter.provisions.length, 0)
    assert.deepEqual(await core.store.snapshot(), before)
    assert.equal(proposal.binding.sessionPlan.kind, 'dedicated')
    assert.match(proposal.binding.sessionId, /^flowit-dedicated:/)
    assert.deepEqual(
      proposal.pipeline.nodes.map(node => node.id),
      ['executor', 'reviewer'],
    )
    assert.equal(
      proposal.pipeline.nodes.every(node =>
        node.target.execution?.runtime?.model === 'gpt-test-luna' &&
        node.target.sessionId === proposal.binding.sessionId,
      ),
      true,
    )

    const token = confirmationToken(authority, proposal)
    const committed = await commitPreparedWorkflow(
      core,
      authority,
      proposal,
      proposal.proposalHash,
      {
        confirmationToken: token,
        callerContext: caller('commit'),
      },
    )
    assert.equal(committed.action, 'accepted')
    assert.equal(committed.sessionId, 'dedicated-1')
    assert.equal(committed.executionEvidence?.runtime?.actualModel, 'gpt-test-luna')
    assert.equal(adapter.provisions.length, 1)
    assert.ok(committed.runId)
    await waitForCompleted(core, committed.runId!)
    assert.equal(adapter.dispatches.length, 2)
    assert.equal(adapter.dispatches.every(request => request.sessionId === 'dedicated-1'), true)
    assert.equal(
      adapter.dispatches.every(request => request.execution?.runtime?.reasoningEffort === 'high'),
      true,
    )

    const replay = await commitPreparedWorkflow(
      core,
      authority,
      proposal,
      proposal.proposalHash,
      {
        confirmationToken: token,
        callerContext: caller('replay'),
      },
    )
    assert.equal(replay.action, 'reused')
    assert.equal(adapter.provisions.length, 1)

    await core.store.transact(state => {
      state.runs = []
    })
    const receiptOnlyReplay = await commitPreparedWorkflow(
      core,
      authority,
      proposal,
      proposal.proposalHash,
      { callerContext: caller('receipt-replay') },
    )
    assert.equal(receiptOnlyReplay.action, 'reused')
    assert.equal(receiptOnlyReplay.runStatus, 'completed')
    assert.equal(adapter.provisions.length, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})


test('a failed provisioning call leaves one durable uncertain intent and never provisions twice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-execution-uncertain-'))
  const adapter = new ProvisioningAdapter()
  adapter.provisionFailure = new Error('connection dropped after thread/start')
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: false,
  }, [adapter])
  const authority = new RoutingAuthorityService({
    mode: 'suggest',
    secret: SECRET,
    stateFile: path.join(root, 'authority.json'),
    requireCallerAttestation: true,
  })
  try {
    await core.ready
    const authorityToken = authority.issueHostAuthority({
      task: TASK,
      explicitIntent: 'force-flowit',
      hostId: 'claude-code',
      hostSessionId: 'host-session',
      turnNonce: 'turn-uncertain',
    })
    const assessment = authority.assess({
      task: TASK,
      authorityToken,
      signals: {
        taskKind: 'coding',
        distinctStages: 2,
        decomposability: 3,
        durabilityNeed: 2,
        reviewNeed: 2,
        ambiguity: 0,
        sideEffectRisk: 'reversible',
      },
    }, caller('assess-uncertain'))
    const proposal = await prepareWorkflow(core, authority, {
      assessmentToken: assessment.assessmentToken,
      maxNodes: 2,
      target: {
        adapterId: adapter.id,
        dedicatedCwd: root,
        execution: { runtime: { model: 'gpt-test-luna', match: 'exact' } },
      },
    }, { callerContext: caller('prepare-uncertain') })
    const token = confirmationToken(authority, proposal)
    await assert.rejects(
      commitPreparedWorkflow(core, authority, proposal, proposal.proposalHash, {
        confirmationToken: token,
        callerContext: caller('commit-uncertain'),
      }),
      /connection dropped/,
    )
    const state = await core.store.snapshot()
    assert.equal(state.provisioningIntents.length, 1)
    assert.equal(state.provisioningIntents[0]?.status, 'uncertain')
    assert.equal(adapter.provisions.length, 1)

    const replay = await commitPreparedWorkflow(
      core,
      authority,
      proposal,
      proposal.proposalHash,
      { callerContext: caller('replay-uncertain') },
    )
    assert.equal(replay.runStatus, 'provisioning')
    assert.match(replay.error ?? '', /reconciliation/)
    assert.equal(adapter.provisions.length, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
