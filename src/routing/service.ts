import { createHash } from 'node:crypto'
import type { FlowitOrchestrationCore } from '../core/runtime.js'
import type {
  AgentAdapterCapabilities,
  AgentSessionDescriptor,
  RunOncePipelineSnapshot,
} from '../core/types.js'
import type { RoutingAuthorityService } from './authority.js'
import { canonicalJson } from './canonical.js'
import {
  buildWorkflowProposal,
  proposalHashFor,
  validateMvpProposal,
  type WorkflowProposalRuntime,
} from './planner.js'
import type {
  CommitPreparedWorkflowOptions,
  CommitPreparedWorkflowResult,
  PrepareWorkflowInput,
  PreparedWorkflowProposal,
  ResolvedWorkflowBinding,
  RoutingCallerContext,
  TaskAssessmentResult,
  WorkflowTargetBinding,
} from './types.js'

export async function prepareWorkflow(
  core: FlowitOrchestrationCore,
  authority: RoutingAuthorityService,
  input: PrepareWorkflowInput,
  runtime: WorkflowProposalRuntime = {},
  signal?: AbortSignal,
): Promise<PreparedWorkflowProposal> {
  await core.ready
  signal?.throwIfAborted()
  const assessment = authority.verifyAssessmentToken(
    requiredString(input.assessmentToken, 'assessmentToken'),
    runtime.callerContext,
  )
  if (assessment.decision === 'direct') {
    throw new Error('direct tasks do not produce an adaptive Workflow proposal')
  }
  if (assessment.decision === 'ask') {
    throw new Error(
      'adaptive routing requires a trusted user choice before proposal preparation; reassess with the Host-issued choice authority token',
    )
  }
  const binding = await resolveWorkflowBinding(core, input.target, signal)
  const proposal = buildWorkflowProposal({ ...input, assessment, binding }, runtime)
  if (
    proposal.confirmationRequired &&
    proposal.assessment.explicitIntent !== 'preview'
  ) {
    const authorityContext = proposal.assessment.authorityContext
    if (!authorityContext) {
      throw new Error(
        'the selected Host did not provide a trusted confirmation channel for this adaptive Workflow proposal',
      )
    }
    const confirmationCode = requiredString(
      proposal.confirmationCode,
      'confirmationCode',
    )
    authority.registerProposalConfirmation({
      proposalHash: proposal.proposalHash,
      confirmationCode,
      expiresAt: proposal.expiresAt,
      authorityContext,
    })
  }
  return proposal
}

export async function commitPreparedWorkflow(
  core: FlowitOrchestrationCore,
  authority: RoutingAuthorityService,
  value: unknown,
  expectedHash: string,
  options: CommitPreparedWorkflowOptions = {},
  signal?: AbortSignal,
): Promise<CommitPreparedWorkflowResult> {
  await core.ready
  signal?.throwIfAborted()
  const proposal = parsePreparedWorkflowProposal(
    value,
    authority,
    new Date(),
    options.callerContext,
  )
  const expected = requiredHash(expectedHash, 'expectedHash')
  if (proposal.proposalHash !== expected) {
    throw new Error('adaptive Workflow proposal hash differs from the user-reviewed hash')
  }
  if (proposal.assessment.explicitIntent === 'preview') {
    throw new Error(
      'a preview-only proposal cannot be committed; the user must explicitly choose Flowit execution and reassess',
    )
  }
  if (proposal.confirmationRequired) {
    const authorityContext = proposal.assessment.authorityContext
    if (!authorityContext) {
      throw new Error('adaptive Workflow proposal has no trusted Host confirmation context')
    }
    authority.verifyProposalConfirmation(
      requiredString(options.confirmationToken, 'confirmationToken'),
      { proposalHash: proposal.proposalHash, authorityContext },
      options.callerContext,
    )
  }

  const currentBinding = await resolveWorkflowBinding(
    core,
    {
      adapterId: proposal.binding.adapterId,
      sessionId: proposal.binding.sessionId,
      skills: proposal.binding.skills,
    },
    signal,
  )
  if (currentBinding.fingerprint !== proposal.binding.fingerprint) {
    throw new Error(
      'adaptive Workflow binding changed after preparation; re-run workflow_assess and workflow_prepare',
    )
  }

  const definitionId = `adaptive-run-once:${proposal.proposalHash}`
  const triggerKey = `adaptive:${proposal.proposalHash}`
  const snapshot: RunOncePipelineSnapshot = {
    version: 1,
    name: proposal.pipeline.name,
    nodes: structuredClone(proposal.pipeline.nodes),
    edges: structuredClone(proposal.pipeline.edges),
  }
  const admitted = await core.runOncePipelines.startRunOnce(
    { definitionId, triggerKey, snapshot },
    signal,
  )
  return {
    kind: 'adaptive-workflow-commit-result',
    version: 2,
    proposalHash: proposal.proposalHash,
    action: admitted.created ? 'accepted' : 'reused',
    definitionId,
    pipelineName: proposal.pipeline.name,
    ...(admitted.runId ? { runId: admitted.runId } : {}),
    runStatus: admitted.status === 'dead-letter'
      ? 'dead-letter'
      : admitted.status === 'completed'
        ? 'completed'
        : 'running',
    ...(admitted.error ? { error: admitted.error } : {}),
  }
}

export async function getAdaptiveWorkflowRun(
  core: FlowitOrchestrationCore,
  runId: string,
): Promise<unknown> {
  await core.ready
  const status = await core.runOncePipelines.getRun(requiredString(runId, 'runId'))
  if (!status) throw new Error(`unknown adaptive run ${runId}`)
  return status
}

export function parsePreparedWorkflowProposal(
  value: unknown,
  authority: RoutingAuthorityService,
  now = new Date(),
  callerContext?: RoutingCallerContext,
): PreparedWorkflowProposal {
  if (!isRecord(value)) throw new Error('proposal must be an object')
  if (value.kind !== 'adaptive-workflow-proposal' || value.version !== 2) {
    throw new Error('proposal must be an adaptive Workflow proposal version 2')
  }
  if (typeof value.assessmentToken !== 'string') {
    throw new Error('proposal.assessmentToken must be a string')
  }
  const signedAssessment = authority.verifyAssessmentToken(
    value.assessmentToken,
    callerContext,
  )
  const proposal = structuredClone(value) as unknown as PreparedWorkflowProposal
  if (!Number.isFinite(Date.parse(proposal.expiresAt)) || Date.parse(proposal.expiresAt) <= now.getTime()) {
    throw new Error('adaptive Workflow proposal expired; reassess and prepare the current task again')
  }
  if (proposal.expiresAt !== signedAssessment.expiresAt) {
    throw new Error('adaptive Workflow proposal expiry differs from its signed assessment')
  }
  if (proposal.task !== signedAssessment.task) {
    throw new Error('adaptive Workflow proposal task differs from its signed assessment')
  }
  if (
    canonicalJson(proposal.assessment) !==
    canonicalJson(unsignedAssessment(signedAssessment))
  ) {
    throw new Error('adaptive Workflow proposal assessment differs from its signed authority')
  }
  validateBindingShape(proposal.binding)
  validateMvpProposal(proposal)
  if (proposal.proposalHash !== proposalHashFor(proposal)) {
    throw new Error('adaptive Workflow proposal hash verification failed')
  }
  return proposal
}

export async function resolveWorkflowBinding(
  core: FlowitOrchestrationCore,
  target: WorkflowTargetBinding,
  signal?: AbortSignal,
): Promise<ResolvedWorkflowBinding> {
  signal?.throwIfAborted()
  const adapterId = requiredString(target.adapterId, 'target.adapterId')
  const sessionId = requiredString(target.sessionId, 'target.sessionId')
  const skills = normalizeStrings(target.skills ?? [])
  const adapter = await core.adapters.requireStarted(adapterId, signal)
  const sessions = await adapter.listSessions(sessionId, signal)
  signal?.throwIfAborted()
  const exact = sessions.filter(candidate =>
    candidate.adapterId === adapterId && candidate.sessionId === sessionId,
  )
  if (exact.length !== 1) {
    throw new Error(
      exact.length === 0
        ? `adaptive routing could not resolve exact Session ${adapterId}:${sessionId}`
        : `adaptive routing found ambiguous duplicate Session ${adapterId}:${sessionId}`,
    )
  }
  const session = exact[0]!
  assertSessionUsable(session, adapter.capabilities)
  if (skills.length > 0) {
    if (!adapter.capabilities.skillBinding) {
      throw new Error(`Adapter ${adapterId} cannot establish requested Skill bindings`)
    }
    if (!adapter.validateSkillBindings) {
      throw new Error(
        `Adapter ${adapterId} has no preflight Skill-binding contract; adaptive routing MVP requires an empty Skills list`,
      )
    }
    await adapter.validateSkillBindings(sessionId, skills, signal)
    signal?.throwIfAborted()
  }
  const capabilities = cloneCapabilities(adapter.capabilities)
  const resolvedSession = structuredClone(session)
  const common = {
    adapterId,
    sessionId,
    session: resolvedSession,
    capabilities,
    skills,
  }
  return {
    ...common,
    fingerprint: digest(common),
  }
}

function assertSessionUsable(
  session: AgentSessionDescriptor,
  capabilities: AgentAdapterCapabilities,
): void {
  if (session.status === 'ended') {
    throw new Error(`adaptive routing target Session ${session.adapterId}:${session.sessionId} has ended`)
  }
  if (session.status === 'unknown') {
    throw new Error(
      `adaptive routing cannot prove target Session ${session.adapterId}:${session.sessionId} is executable`,
    )
  }
  if (session.status === 'live' && !capabilities.liveDispatch) {
    throw new Error(
      `adaptive routing target Session ${session.adapterId}:${session.sessionId} is live but the Adapter forbids live dispatch`,
    )
  }
  if (session.status === 'idle' && !capabilities.coldResume && !capabilities.liveDispatch) {
    throw new Error(
      `adaptive routing target Session ${session.adapterId}:${session.sessionId} cannot be resumed or dispatched`,
    )
  }
}

function validateBindingShape(value: unknown): asserts value is ResolvedWorkflowBinding {
  if (!isRecord(value)) throw new Error('proposal.binding must be an object')
  requiredString(value.adapterId, 'proposal.binding.adapterId')
  requiredString(value.sessionId, 'proposal.binding.sessionId')
  requiredHash(value.fingerprint, 'proposal.binding.fingerprint')
  if (!isRecord(value.session)) throw new Error('proposal.binding.session must be an object')
  if (!isRecord(value.capabilities)) throw new Error('proposal.binding.capabilities must be an object')
  if (!Array.isArray(value.skills) || value.skills.some(skill => typeof skill !== 'string')) {
    throw new Error('proposal.binding.skills must be an array of strings')
  }
}

function cloneCapabilities(value: AgentAdapterCapabilities): AgentAdapterCapabilities {
  return {
    coldResume: value.coldResume,
    liveDispatch: value.liveDispatch,
    skillBinding: value.skillBinding,
    contextReference: value.contextReference,
    eventSubscription: value.eventSubscription,
  }
}

function unsignedAssessment(
  value: { expiresAt: string; assessmentToken: string } & TaskAssessmentResult,
): TaskAssessmentResult {
  const { expiresAt: _expiresAt, assessmentToken: _assessmentToken, ...assessment } = value
  return structuredClone(assessment)
}

function normalizeStrings(values: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('target.skills must contain only strings')
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function requiredHash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hex digest`)
  }
  return value
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
