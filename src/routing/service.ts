import { createHash } from 'node:crypto'
import type { FlowitOrchestrationCore } from '../core/runtime.js'
import { normalizeExecutionRequirement } from '../core/domain.js'
import type {
  AgentAdapterCapabilities,
  AgentExecutionPreflightRequest,
  AgentExecutionPreflightResult,
  AgentExecutionRequirement,
  AgentSessionDescriptor,
  AgentSessionPlan,
  ProvisionedAgentSession,
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

  const target = bindingTarget(proposal.binding)
  const currentBinding = await resolveWorkflowBinding(core, target, signal)
  if (currentBinding.fingerprint !== proposal.binding.fingerprint) {
    throw new Error(
      'adaptive Workflow execution binding changed after preparation; re-run workflow_assess and workflow_prepare',
    )
  }

  const definitionId = `adaptive-run-once:${proposal.proposalHash}`
  const triggerKey = `adaptive:${proposal.proposalHash}`

  const previous = await existingExecutableSnapshot(core, definitionId, triggerKey)
  if (previous) {
    const admitted = await core.runOncePipelines.startRunOnce(
      { definitionId, triggerKey, snapshot: previous },
      signal,
    )
    return commitResult(proposal, admitted, {
      action: 'reused',
      sessionId: previous.nodes[0]?.target.sessionId,
    })
  }

  let provisioned: ProvisionedAgentSession | undefined
  try {
    let sessionId = proposal.binding.sessionId
    let executionEvidence = proposal.binding.preflight?.evidence
    if (proposal.binding.sessionPlan.kind === 'dedicated') {
      const adapter = await core.adapters.requireStarted(proposal.binding.adapterId, signal)
      if (!adapter.provisionSession) {
        throw new Error(
          `Adapter ${proposal.binding.adapterId} cannot provision the dedicated Session confirmed by the user`,
        )
      }
      provisioned = await adapter.provisionSession(
        preflightRequest(
          proposal.binding.adapterId,
          proposal.binding.sessionPlan,
          proposal.binding.execution,
          proposal.binding.skills,
        ),
        signal,
      )
      assertSessionUsable(provisioned.session, adapter.capabilities)
      sessionId = requiredString(provisioned.session.sessionId, 'provisioned Session id')
      executionEvidence = provisioned.evidence
    }

    const snapshot = materializeSnapshot(proposal, sessionId)
    const admitted = await core.runOncePipelines.startRunOnce(
      { definitionId, triggerKey, snapshot },
      signal,
    )
    return commitResult(proposal, admitted, {
      action: admitted.created ? 'accepted' : 'reused',
      sessionId,
      executionEvidence,
    })
  } catch (error) {
    if (provisioned?.managed) {
      const adapter = core.adapters.get(proposal.binding.adapterId)
      await adapter?.releaseSession?.(provisioned, signal).catch(() => undefined)
    }
    throw error
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
  const sessionId = optionalString(target.sessionId)
  const dedicatedCwd = optionalString(target.dedicatedCwd)
  if (Boolean(sessionId) === Boolean(dedicatedCwd)) {
    throw new Error('target must specify exactly one of sessionId or dedicatedCwd')
  }
  const skills = normalizeStrings(target.skills ?? [])
  const execution = target.execution
    ? normalizeExecutionRequirement(target.execution)
    : undefined
  const adapter = await core.adapters.requireStarted(adapterId, signal)
  const capabilities = cloneCapabilities(adapter.capabilities)

  if (dedicatedCwd) {
    if (!adapter.preflightExecution || !adapter.provisionSession) {
      throw new Error(
        `Adapter ${adapterId} does not support preflighted dedicated Session provisioning`,
      )
    }
    if (
      adapter.capabilities.sessionProvisioning !== 'dedicated' &&
      adapter.capabilities.sessionProvisioning !== 'pool'
    ) {
      throw new Error(`Adapter ${adapterId} does not advertise dedicated Session provisioning`)
    }
    const sessionPlan: AgentSessionPlan = { kind: 'dedicated', cwd: dedicatedCwd }
    const preflight = await adapter.preflightExecution(
      preflightRequest(adapterId, sessionPlan, execution, skills),
      signal,
    )
    assertPreflightReady(adapterId, preflight)
    const placeholder = dedicatedPlaceholder(adapterId, sessionPlan, execution, skills, preflight)
    const session: AgentSessionDescriptor = {
      adapterId,
      sessionId: placeholder,
      cwd: dedicatedCwd,
      status: 'idle',
      name: 'Flowit dedicated Session (created after confirmation)',
    }
    const common = {
      adapterId,
      sessionId: placeholder,
      sessionPlan,
      session,
      capabilities,
      skills,
      ...(execution ? { execution } : {}),
      preflight: structuredClone(preflight),
    }
    return { ...common, fingerprint: digest(common) }
  }

  const exactSessionId = requiredString(sessionId, 'target.sessionId')
  const sessions = await adapter.listSessions(exactSessionId, signal)
  signal?.throwIfAborted()
  const exact = sessions.filter(candidate =>
    candidate.adapterId === adapterId && candidate.sessionId === exactSessionId,
  )
  if (exact.length !== 1) {
    throw new Error(
      exact.length === 0
        ? `adaptive routing could not resolve exact Session ${adapterId}:${exactSessionId}`
        : `adaptive routing found ambiguous duplicate Session ${adapterId}:${exactSessionId}`,
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
    await adapter.validateSkillBindings(exactSessionId, skills, signal)
    signal?.throwIfAborted()
  }

  const sessionPlan: AgentSessionPlan = { kind: 'existing', sessionId: exactSessionId }
  let preflight: AgentExecutionPreflightResult | undefined
  if (adapter.preflightExecution) {
    preflight = await adapter.preflightExecution(
      preflightRequest(adapterId, sessionPlan, execution, skills),
      signal,
    )
    assertPreflightReady(adapterId, preflight)
  } else if (requiresVerifiedPreflight(execution)) {
    throw new Error(
      `Adapter ${adapterId} has no execution-preflight contract for the requested runtime or capabilities`,
    )
  }

  const common = {
    adapterId,
    sessionId: exactSessionId,
    sessionPlan,
    session: structuredClone(session),
    capabilities,
    skills,
    ...(execution ? { execution } : {}),
    ...(preflight ? { preflight: structuredClone(preflight) } : {}),
  }
  return { ...common, fingerprint: digest(common) }
}

function bindingTarget(binding: ResolvedWorkflowBinding): WorkflowTargetBinding {
  return {
    adapterId: binding.adapterId,
    ...(binding.sessionPlan.kind === 'existing'
      ? { sessionId: binding.sessionPlan.sessionId }
      : { dedicatedCwd: binding.sessionPlan.cwd }),
    ...(binding.execution ? { execution: structuredClone(binding.execution) } : {}),
    skills: [...binding.skills],
  }
}

function preflightRequest(
  adapterId: string,
  session: AgentSessionPlan,
  execution: AgentExecutionRequirement | undefined,
  skills: readonly string[],
): AgentExecutionPreflightRequest {
  const requirement = execution ? structuredClone(execution) : {}
  return {
    correlationId: `adaptive-preflight:${digest({ adapterId, session, requirement, skills })}`,
    session: structuredClone(session),
    requirement,
    skills: [...skills],
  }
}

function assertPreflightReady(
  adapterId: string,
  result: AgentExecutionPreflightResult,
): void {
  if (result.status === 'ready' && result.blockers.length === 0) return
  const details = result.blockers.length
    ? result.blockers.map(item => `${item.code}: ${item.message}`).join('; ')
    : `status=${result.status}`
  throw new Error(`Adapter ${adapterId} execution preflight blocked: ${details}`)
}

function requiresVerifiedPreflight(execution: AgentExecutionRequirement | undefined): boolean {
  if (!execution) return false
  if ((execution.requiredCapabilities?.length ?? 0) > 0) return true
  return execution.runtime?.match === 'exact' || execution.runtime?.match === 'preferred'
}

function dedicatedPlaceholder(
  adapterId: string,
  session: AgentSessionPlan,
  execution: AgentExecutionRequirement | undefined,
  skills: readonly string[],
  preflight: AgentExecutionPreflightResult,
): string {
  return `flowit-dedicated:${digest({ adapterId, session, execution, skills, preflight }).slice(0, 32)}`
}

function materializeSnapshot(
  proposal: PreparedWorkflowProposal,
  sessionId: string,
): RunOncePipelineSnapshot {
  return {
    version: 1,
    name: proposal.pipeline.name,
    nodes: proposal.pipeline.nodes.map(node => ({
      ...structuredClone(node),
      target: {
        ...structuredClone(node.target),
        sessionId,
      },
    })),
    edges: structuredClone(proposal.pipeline.edges),
  }
}

async function existingExecutableSnapshot(
  core: FlowitOrchestrationCore,
  definitionId: string,
  triggerKey: string,
): Promise<RunOncePipelineSnapshot | undefined> {
  const state = await core.store.snapshot()
  const run = state.runs.findLast(candidate =>
    candidate.kind === 'pipeline' &&
    candidate.definitionId === definitionId &&
    candidate.triggerKey === triggerKey,
  )
  if (run?.pipelineSnapshot) return structuredClone(run.pipelineSnapshot)
  const receipt = state.terminalReceipts.find(candidate =>
    candidate.kind === 'pipeline' &&
    candidate.definitionId === definitionId &&
    candidate.triggerKey === triggerKey,
  )
  if (!receipt) return undefined
  return {
    version: 1,
    name: definitionId,
    nodes: [],
    edges: [],
  }
}

function commitResult(
  proposal: PreparedWorkflowProposal,
  admitted: {
    runId?: string
    status: 'accepted' | 'running' | 'completed' | 'dead-letter'
    created: boolean
    error?: string
  },
  extras: {
    action: 'accepted' | 'reused'
    sessionId?: string
    executionEvidence?: CommitPreparedWorkflowResult['executionEvidence']
  },
): CommitPreparedWorkflowResult {
  return {
    kind: 'adaptive-workflow-commit-result',
    version: 2,
    proposalHash: proposal.proposalHash,
    action: extras.action,
    definitionId: `adaptive-run-once:${proposal.proposalHash}`,
    pipelineName: proposal.pipeline.name,
    ...(admitted.runId ? { runId: admitted.runId } : {}),
    runStatus: admitted.status === 'dead-letter'
      ? 'dead-letter'
      : admitted.status === 'completed'
        ? 'completed'
        : 'running',
    ...(extras.sessionId ? { sessionId: extras.sessionId } : {}),
    ...(extras.executionEvidence
      ? { executionEvidence: structuredClone(extras.executionEvidence) }
      : {}),
    ...(admitted.error ? { error: admitted.error } : {}),
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
  if (!isRecord(value.sessionPlan)) throw new Error('proposal.binding.sessionPlan must be an object')
  if (value.sessionPlan.kind === 'existing') {
    requiredString(value.sessionPlan.sessionId, 'proposal.binding.sessionPlan.sessionId')
  } else if (value.sessionPlan.kind === 'dedicated') {
    requiredString(value.sessionPlan.cwd, 'proposal.binding.sessionPlan.cwd')
  } else {
    throw new Error('proposal.binding.sessionPlan.kind must be existing or dedicated')
  }
  if (!isRecord(value.session)) throw new Error('proposal.binding.session must be an object')
  if (!isRecord(value.capabilities)) throw new Error('proposal.binding.capabilities must be an object')
  if (!Array.isArray(value.skills) || value.skills.some(skill => typeof skill !== 'string')) {
    throw new Error('proposal.binding.skills must be an array of strings')
  }
  if (value.execution !== undefined && !isRecord(value.execution)) {
    throw new Error('proposal.binding.execution must be an object')
  }
  if (value.preflight !== undefined && !isRecord(value.preflight)) {
    throw new Error('proposal.binding.preflight must be an object')
  }
}

function cloneCapabilities(value: AgentAdapterCapabilities): AgentAdapterCapabilities {
  return {
    coldResume: value.coldResume,
    liveDispatch: value.liveDispatch,
    skillBinding: value.skillBinding,
    contextReference: value.contextReference,
    eventSubscription: value.eventSubscription,
    ...(value.executionPreflight === undefined
      ? {}
      : { executionPreflight: value.executionPreflight }),
    ...(value.sessionProvisioning === undefined
      ? {}
      : { sessionProvisioning: value.sessionProvisioning }),
    ...(value.runtimeSelection === undefined
      ? {}
      : { runtimeSelection: value.runtimeSelection }),
    ...(value.runtimeIntrospection === undefined
      ? {}
      : { runtimeIntrospection: value.runtimeIntrospection }),
    ...(value.lockInspection === undefined
      ? {}
      : { lockInspection: value.lockInspection }),
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
