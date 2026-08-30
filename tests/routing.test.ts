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
  AgentSessionDescriptor,
} from '../src/core/types.js'
import {
  RoutingAuthorityService,
  commitPreparedWorkflow,
  getAdaptiveWorkflowRun,
  parsePreparedWorkflowProposal,
  prepareWorkflow,
  proposalHashFor,
} from '../src/routing/index.js'

const SECRET = 'routing-test-secret-that-is-at-least-32-bytes-long'
const TASK = 'Inspect the repository, define acceptance criteria, research affected modules, implement the change, run tests, and perform an independent review.'
const SIGNALS = {
  taskKind: 'coding' as const,
  distinctStages: 5,
  decomposability: 3 as const,
  durabilityNeed: 2 as const,
  reviewNeed: 3 as const,
  requiresResearch: true,
  ambiguity: 0 as const,
  sideEffectRisk: 'reversible' as const,
}

class RecordingAdapter implements AgentAdapter {
  readonly id = 'test'
  readonly capabilities = {
    coldResume: true,
    liveDispatch: false,
    skillBinding: true,
    contextReference: 'summary' as const,
    eventSubscription: false,
  }
  sessions: AgentSessionDescriptor[] = [
    { adapterId: 'test', sessionId: 'worker', status: 'idle' },
  ]
  readonly requests: AgentDispatchRequest[] = []
  delayMs = 0

  async listSessions(): Promise<AgentSessionDescriptor[]> {
    return structuredClone(this.sessions)
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.requests.push(structuredClone(request))
    if (this.delayMs) await delay(this.delayMs)
    return {
      sessionId: request.sessionId,
      loadedSkills: [...request.skills],
      referencedSessions: request.contextRefs.map(ref => ref.sessionId),
      outputSummary: `completed ${request.correlationId}`,
    }
  }
}

class SkillAdapter extends RecordingAdapter {
  readonly validated: string[][] = []
  async validateSkillBindings(_sessionId: string, skills: readonly string[]): Promise<void> {
    this.validated.push([...skills])
    if (skills.includes('missing')) throw new Error('missing Skill')
  }
}

async function fixture(adapter: AgentAdapter = new RecordingAdapter()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-routing-'))
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: false,
    leaseDurationMs: 1_000,
    retryDelayMs: 20,
  }, [adapter])
  await core.ready
  const authority = new RoutingAuthorityService({
    mode: 'suggest',
    secret: SECRET,
    stateFile: path.join(root, 'authority.json'),
  })
  return { root, core, authority, adapter }
}

function trustedAssessment(authority: RoutingAuthorityService, explicitIntent: 'force-flowit' | 'preview' = 'force-flowit') {
  const authorityToken = authority.issueHostAuthority({
    task: TASK,
    explicitIntent,
    hostId: 'claude-code',
    hostSessionId: 'host-session',
    turnNonce: 'turn-1',
  })
  return authority.assess({ task: TASK, authorityToken, signals: SIGNALS })
}

function confirmationToken(authority: RoutingAuthorityService): string {
  const output = handleClaudeRoutingHook({
    session_id: 'host-session',
    hook_event_name: 'UserPromptSubmit',
    prompt: '确认执行',
  }, authority)
  const context = output.hookSpecificOutput?.additionalContext
  assert.ok(context)
  const value = JSON.parse(context.split('\n').at(-1)!) as Record<string, string>
  assert.equal(value.kind, 'flowit-proposal-confirmation')
  return value.confirmationToken
}

test('prepare is Workflow-store read-only and fingerprints one exact Session', async () => {
  const fx = await fixture()
  try {
    const assessment = trustedAssessment(fx.authority)
    const before = await fx.core.store.snapshot()
    const proposal = await prepareWorkflow(fx.core, fx.authority, {
      assessmentToken: assessment.assessmentToken,
      target: { adapterId: 'test', sessionId: 'worker' },
    })
    assert.equal(proposal.pipeline.nodes.length >= 2, true)
    assert.equal(proposal.pipeline.nodes.length <= 6, true)
    assert.equal(proposal.binding.session.status, 'idle')
    assert.equal(proposal.binding.fingerprint.length, 64)
    assert.deepEqual(await fx.core.store.snapshot(), before)
  } finally {
    await fx.core.dispose()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('prepare refuses an unresolved ask before a Host-issued user choice', async () => {
  const fx = await fixture()
  try {
    const task = 'Review this migration and provide a recommendation with validation.'
    const token = fx.authority.issueHostAuthority({
      task,
      explicitIntent: 'unspecified',
      hostId: 'claude-code',
      hostSessionId: 'host-session',
    })
    const assessment = fx.authority.assess({
      task,
      authorityToken: token,
      signals: { distinctStages: 3, decomposability: 2, ambiguity: 0 },
    })
    assert.equal(assessment.decision, 'ask')
    await assert.rejects(
      prepareWorkflow(fx.core, fx.authority, {
        assessmentToken: assessment.assessmentToken,
        target: { adapterId: 'test', sessionId: 'worker' },
      }),
      /trusted user choice/,
    )
    assert.equal((await fx.core.store.snapshot()).runs.length, 0)
  } finally {
    await fx.core.dispose()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('binding preflight rejects missing, unknown, live-unresumable, and unverifiable Skills', async () => {
  const adapter = new RecordingAdapter()
  const fx = await fixture(adapter)
  try {
    const assessment = trustedAssessment(fx.authority)
    const prepare = (sessionId: string, skills?: string[]) => prepareWorkflow(
      fx.core,
      fx.authority,
      {
        assessmentToken: assessment.assessmentToken,
        target: { adapterId: 'test', sessionId, ...(skills ? { skills } : {}) },
      },
    )
    await assert.rejects(prepare('missing'), /could not resolve exact Session/)
    adapter.sessions = [{ adapterId: 'test', sessionId: 'worker', status: 'unknown' }]
    await assert.rejects(prepare('worker'), /cannot prove.*executable/)
    adapter.sessions = [{ adapterId: 'test', sessionId: 'worker', status: 'live' }]
    await assert.rejects(prepare('worker'), /live.*forbids live dispatch/)
    adapter.sessions = [{ adapterId: 'test', sessionId: 'worker', status: 'idle' }]
    await assert.rejects(prepare('worker', ['web-search']), /no preflight Skill-binding contract/)
    assert.equal((await fx.core.store.snapshot()).runs.length, 0)
  } finally {
    await fx.core.dispose()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Adapters with explicit Skill preflight may bind verified Skills', async () => {
  const adapter = new SkillAdapter()
  const fx = await fixture(adapter)
  try {
    const assessment = trustedAssessment(fx.authority)
    const proposal = await prepareWorkflow(fx.core, fx.authority, {
      assessmentToken: assessment.assessmentToken,
      target: { adapterId: 'test', sessionId: 'worker', skills: ['repo-read'] },
    })
    assert.deepEqual(proposal.binding.skills, ['repo-read'])
    assert.deepEqual(adapter.validated, [['repo-read']])
  } finally {
    await fx.core.dispose()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('proposal hash, signed assessment, expiry, and binding are revalidated before mutation', async () => {
  const adapter = new RecordingAdapter()
  const fx = await fixture(adapter)
  try {
    const assessment = trustedAssessment(fx.authority)
    const proposal = await prepareWorkflow(fx.core, fx.authority, {
      assessmentToken: assessment.assessmentToken,
      target: { adapterId: 'test', sessionId: 'worker' },
    })
    const changed = structuredClone(proposal)
    changed.pipeline.nodes[0]!.target.prompt = 'Deploy to production.'
    assert.throws(() => parsePreparedWorkflowProposal(changed, fx.authority), /hash/)

    const changedAssessment = structuredClone(proposal)
    changedAssessment.assessment.signals.sideEffectRisk = 'none'
    changedAssessment.proposalHash = proposalHashFor(changedAssessment)
    assert.throws(
      () => parsePreparedWorkflowProposal(changedAssessment, fx.authority),
      /assessment differs from its signed authority/,
    )

    adapter.sessions = [{ adapterId: 'test', sessionId: 'worker', status: 'live' }]
    await assert.rejects(
      commitPreparedWorkflow(
        fx.core,
        fx.authority,
        proposal,
        proposal.proposalHash,
        { confirmationToken: confirmationToken(fx.authority) },
      ),
      /live.*forbids live dispatch/,
    )
    assert.equal((await fx.core.store.snapshot()).runs.length, 0)
  } finally {
    await fx.core.dispose()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('plain confirmed=true cannot commit; Host confirmation binds the exact proposal hash', async () => {
  const fx = await fixture()
  try {
    const assessment = trustedAssessment(fx.authority)
    const proposal = await prepareWorkflow(fx.core, fx.authority, {
      assessmentToken: assessment.assessmentToken,
      target: { adapterId: 'test', sessionId: 'worker' },
    })
    await assert.rejects(
      commitPreparedWorkflow(
        fx.core,
        fx.authority,
        proposal,
        proposal.proposalHash,
        { confirmed: true } as any,
      ),
      /confirmationToken/,
    )
    const token = confirmationToken(fx.authority)
    const wrong = structuredClone(proposal)
    wrong.pipeline.name += ' changed'
    wrong.proposalHash = proposalHashFor(wrong)
    await assert.rejects(
      commitPreparedWorkflow(
        fx.core,
        fx.authority,
        wrong,
        wrong.proposalHash,
        { confirmationToken: token },
      ),
      /does not match the reviewed proposal/,
    )
    assert.equal((await fx.core.store.snapshot()).runs.length, 0)
  } finally {
    await fx.core.dispose()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('preview-only proposal cannot be committed', async () => {
  const fx = await fixture()
  try {
    const proposal = await prepareWorkflow(fx.core, fx.authority, {
      assessmentToken: trustedAssessment(fx.authority, 'preview').assessmentToken,
      target: { adapterId: 'test', sessionId: 'worker' },
    })
    await assert.rejects(
      commitPreparedWorkflow(fx.core, fx.authority, proposal, proposal.proposalHash),
      /preview-only proposal cannot be committed/,
    )
  } finally {
    await fx.core.dispose()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('commit returns a nonblocking durable run, never creates pipelines, and dedupes replay', async () => {
  const adapter = new RecordingAdapter()
  adapter.delayMs = 20
  const fx = await fixture(adapter)
  try {
    const assessment = trustedAssessment(fx.authority)
    const proposal = await prepareWorkflow(fx.core, fx.authority, {
      assessmentToken: assessment.assessmentToken,
      target: { adapterId: 'test', sessionId: 'worker' },
    })
    const token = confirmationToken(fx.authority)
    const committed = await commitPreparedWorkflow(
      fx.core,
      fx.authority,
      proposal,
      proposal.proposalHash,
      { confirmationToken: token },
    )
    assert.equal(committed.action, 'accepted')
    assert.equal(committed.runStatus, 'running')
    assert.ok(committed.runId)
    const admitted = await fx.core.store.snapshot()
    assert.equal(admitted.pipelines.length, 0)
    assert.equal(admitted.runs[0]?.pipelineSnapshot?.name, proposal.pipeline.name)

    await waitFor(async () => {
      const status = await getAdaptiveWorkflowRun(fx.core, committed.runId!) as { status: string }
      return status.status === 'completed' ? status : undefined
    })
    const replay = await commitPreparedWorkflow(
      fx.core,
      fx.authority,
      proposal,
      proposal.proposalHash,
      { confirmationToken: token },
    )
    assert.equal(replay.action, 'reused')
    assert.equal(replay.runStatus, 'completed')
    assert.equal(adapter.requests.length, proposal.pipeline.nodes.length)
    assert.equal((await fx.core.store.snapshot()).pipelines.length, 0)
  } finally {
    await fx.core.dispose()
    await rm(fx.root, { recursive: true, force: true })
  }
})

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error('timed out waiting for adaptive run state')
    await delay(10)
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}
