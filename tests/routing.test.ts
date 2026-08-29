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
} from '../src/core/types.js'
import {
  assessTask,
  commitPreparedWorkflow,
  parsePreparedWorkflowProposal,
  prepareWorkflow,
  proposalHashFor,
} from '../src/routing/index.js'

class RecordingAdapter implements AgentAdapter {
  readonly id = 'test-adapter'
  readonly capabilities = {
    coldResume: true,
    liveDispatch: false,
    skillBinding: true,
    contextReference: 'summary' as const,
    eventSubscription: false,
  }
  readonly calls: AgentDispatchRequest[] = []

  async listSessions(): Promise<AgentSessionDescriptor[]> {
    return [{
      adapterId: this.id,
      sessionId: 'session-1',
      name: 'Adaptive worker',
      status: 'idle',
    }]
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.calls.push(structuredClone(request))
    return {
      sessionId: request.sessionId,
      loadedSkills: [...request.skills],
      referencedSessions: request.contextRefs.map(ref => ref.sessionId),
      outputSummary: `completed ${request.correlationId}`,
    }
  }
}

const complexResearchSignals = {
  taskKind: 'research' as const,
  distinctStages: 5,
  decomposability: 3 as const,
  coupling: 0 as const,
  durabilityNeed: 2 as const,
  reviewNeed: 3 as const,
  requiresResearch: true,
  repeatable: false,
  crossSessionNeed: false,
  crossAdapterNeed: false,
  sideEffectRisk: 'none' as const,
  ambiguity: 0 as const,
}

test('adaptive routing keeps a bounded, tightly coupled task in the current Agent', () => {
  const assessment = assessTask({
    task: 'Fix the null check in this one function.',
    confidence: 0.95,
    signals: {
      taskKind: 'coding',
      distinctStages: 1,
      decomposability: 0,
      coupling: 3,
      durabilityNeed: 0,
      reviewNeed: 1,
      requiresResearch: false,
      repeatable: false,
      crossSessionNeed: false,
      crossAdapterNeed: false,
      sideEffectRisk: 'reversible',
      ambiguity: 0,
    },
  })
  assert.equal(assessment.decision, 'direct')
  assert.equal(assessment.autoExecuteAllowed, false)
})

test('adaptive routing recommends a Pipeline for a high-confidence multi-stage research task', () => {
  const assessment = assessTask({
    task: 'Research the market, challenge the evidence, synthesize findings, and independently review the report.',
    confidence: 0.92,
    signals: complexResearchSignals,
  })
  assert.equal(assessment.decision, 'pipeline')
  assert.equal(assessment.score >= 6, true)
  assert.equal(assessment.question, undefined)
})

test('ambiguity, cross-Host intent, and irreversible side effects force a user choice', () => {
  const assessment = assessTask({
    task: 'Research the release, deploy it to production, and notify customers.',
    confidence: 0.9,
    signals: {
      ...complexResearchSignals,
      crossAdapterNeed: true,
      sideEffectRisk: 'irreversible',
      ambiguity: 2,
    },
  })
  assert.equal(assessment.decision, 'ask')
  assert.deepEqual(assessment.question?.options.map(option => option.id), [
    'direct',
    'pipeline',
    'preview',
  ])
})

test('current user intent overrides routing mode without overriding MVP validation', () => {
  assert.equal(assessTask({
    task: 'Create a reviewed implementation plan.',
    mode: 'manual',
    explicitIntent: 'force-flowit',
  }).decision, 'pipeline')
  assert.equal(assessTask({
    task: 'Create a reviewed implementation plan.',
    mode: 'auto-safe',
    explicitIntent: 'force-direct',
    confidence: 1,
    signals: complexResearchSignals,
  }).decision, 'direct')
})

test('workflow preparation creates a hashed, bounded, single-Session linear proposal', () => {
  const proposal = prepareWorkflow({
    task: 'Inspect the service, implement the change, run tests, and review the result.',
    explicitIntent: 'force-flowit',
    confidence: 0.95,
    signals: {
      taskKind: 'coding',
      distinctStages: 4,
      decomposability: 3,
      coupling: 0,
      durabilityNeed: 1,
      reviewNeed: 2,
      requiresResearch: false,
      repeatable: false,
      crossSessionNeed: false,
      crossAdapterNeed: false,
      sideEffectRisk: 'reversible',
      ambiguity: 0,
    },
    target: {
      adapterId: 'test-adapter',
      sessionId: 'session-1',
      skills: ['repo-tools', 'repo-tools', 'testing'],
    },
    maxNodes: 4,
  }, { now: new Date('2026-08-29T00:00:00.000Z') })

  assert.equal(proposal.confirmationRequired, false)
  assert.deepEqual(proposal.pipeline.nodes.map(node => node.id), [
    'plan',
    'implement',
    'test',
    'review',
  ])
  assert.deepEqual(proposal.pipeline.edges, [
    { from: 'plan', to: 'implement' },
    { from: 'implement', to: 'test' },
    { from: 'test', to: 'review' },
  ])
  assert.equal(
    proposal.pipeline.nodes.every(node =>
      node.target.adapterId === 'test-adapter' &&
      node.target.sessionId === 'session-1' &&
      node.target.contextRefs.length === 0),
    true,
  )
  assert.deepEqual(proposal.pipeline.nodes[0]?.target.skills, ['repo-tools', 'testing'])
  assert.equal(proposalHashFor(proposal), proposal.proposalHash)
  assert.equal(parsePreparedWorkflowProposal(proposal).proposalHash, proposal.proposalHash)
  const preparedAgain = prepareWorkflow({
    task: 'Inspect the service, implement the change, run tests, and review the result.',
    explicitIntent: 'force-flowit',
    confidence: 0.95,
    signals: {
      taskKind: 'coding', distinctStages: 4, decomposability: 3, coupling: 0,
      durabilityNeed: 1, reviewNeed: 2, requiresResearch: false, repeatable: false,
      crossSessionNeed: false, crossAdapterNeed: false, sideEffectRisk: 'reversible',
      ambiguity: 0,
    },
    target: { adapterId: 'test-adapter', sessionId: 'session-1', skills: ['repo-tools', 'testing'] },
    maxNodes: 4,
  }, { now: new Date('2026-08-30T00:00:00.000Z') })
  assert.equal(preparedAgain.proposalHash, proposal.proposalHash)
  assert.equal(preparedAgain.pipeline.name, proposal.pipeline.name)
})

test('workflow preparation refuses unsupported MVP topology and unconfirmed boundary decisions', () => {
  assert.throws(
    () => prepareWorkflow({
      task: 'Compare two Hosts and execute across both.',
      confidence: 0.9,
      signals: {
        ...complexResearchSignals,
        crossAdapterNeed: true,
      },
      target: { adapterId: 'test-adapter', sessionId: 'session-1' },
    }),
    /user choice|one confirmed Session|one Adapter/i,
  )
  assert.throws(
    () => prepareWorkflow({
      task: 'Deploy the release to production.',
      explicitIntent: 'force-flowit',
      confidence: 1,
      signals: {
        ...complexResearchSignals,
        sideEffectRisk: 'irreversible',
      },
      target: { adapterId: 'test-adapter', sessionId: 'session-1' },
    }),
    /irreversible external side effects/i,
  )
})

test('proposal hash verification rejects any post-prepare mutation', () => {
  const proposal = prepareWorkflow({
    task: 'Research and review this design.',
    explicitIntent: 'preview',
    confidence: 0.95,
    signals: complexResearchSignals,
    target: { adapterId: 'test-adapter', sessionId: 'session-1' },
  }, { now: new Date('2026-08-29T00:00:00.000Z') })
  const changed = structuredClone(proposal)
  changed.pipeline.nodes[0]!.target.prompt = 'Different prompt'
  assert.throws(
    () => parsePreparedWorkflowProposal(changed),
    /proposalHash verification failed/i,
  )
  const confirmationBypass = structuredClone(proposal) as any
  confirmationBypass.confirmationRequired = false
  confirmationBypass.proposalHash = proposalHashFor(confirmationBypass)
  assert.throws(
    () => parsePreparedWorkflowProposal(confirmationBypass),
    /confirmationRequired does not match/i,
  )
})

test('suggest-mode proposal requires confirmation before commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-routing-confirm-'))
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: 'test-adapter',
    activeWorkers: false,
  }, [new RecordingAdapter()])
  try {
    const proposal = prepareWorkflow({
      task: 'Research, challenge, synthesize, and review the migration options.',
      confidence: 0.95,
      signals: complexResearchSignals,
      target: { adapterId: 'test-adapter', sessionId: 'session-1' },
    })
    assert.equal(proposal.confirmationRequired, true)
    await assert.rejects(
      commitPreparedWorkflow(core, proposal, proposal.proposalHash, { runNow: false }),
      /requires explicit user confirmation/i,
    )
    assert.equal((await core.pipelines.list()).length, 0)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('committed one-shot proposal uses stable dedupe and pauses after completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-routing-run-'))
  const adapter = new RecordingAdapter()
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: false,
  }, [adapter])
  try {
    const proposal = prepareWorkflow({
      task: 'Plan the change, implement it, test it, and review the result.',
      explicitIntent: 'force-flowit',
      confidence: 0.95,
      signals: {
        taskKind: 'coding',
        distinctStages: 4,
        decomposability: 3,
        coupling: 0,
        durabilityNeed: 2,
        reviewNeed: 2,
        requiresResearch: false,
        repeatable: false,
        crossSessionNeed: false,
        crossAdapterNeed: false,
        sideEffectRisk: 'reversible',
        ambiguity: 0,
      },
      target: { adapterId: adapter.id, sessionId: 'session-1', skills: ['testing'] },
      maxNodes: 4,
    })

    const first = await commitPreparedWorkflow(core, proposal, proposal.proposalHash, {
      runNow: true,
    })
    assert.equal(first.action, 'created')
    assert.equal(first.runStatus, 'completed')
    assert.equal(first.pipelineStatus, 'paused')
    assert.equal(first.ran, true)
    assert.equal(adapter.calls.length, proposal.pipeline.nodes.length)

    const second = await commitPreparedWorkflow(core, proposal, proposal.proposalHash, {
      runNow: true,
    })
    assert.equal(second.action, 'reused')
    assert.equal(second.runStatus, 'completed')
    assert.equal(second.pipelineId, first.pipelineId)
    assert.equal(second.ran, false)
    assert.equal(adapter.calls.length, proposal.pipeline.nodes.length)

    const state = await core.store.snapshot()
    assert.equal(
      state.terminalReceipts.some(receipt =>
        receipt.kind === 'pipeline' &&
        receipt.definitionId === first.pipelineId &&
        receipt.triggerKey === `adaptive:${proposal.proposalHash}` &&
        receipt.status === 'completed'),
      true,
    )
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
