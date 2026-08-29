import type { FlowitOrchestrationCore } from '../core/runtime.js'
import type {
  CreatePipelineInput,
  PipelineDefinition,
  WorkflowState,
} from '../core/types.js'
import { canonicalJson, proposalHashFor } from './planner.js'
import { assessTask } from './policy.js'
import type {
  CommitPreparedWorkflowOptions,
  CommitPreparedWorkflowResult,
  PreparedWorkflowProposal,
} from './types.js'

export async function commitPreparedWorkflow(
  core: FlowitOrchestrationCore,
  value: unknown,
  expectedHash: string,
  options: CommitPreparedWorkflowOptions = {},
): Promise<CommitPreparedWorkflowResult> {
  const proposal = parsePreparedWorkflowProposal(value)
  const normalizedExpectedHash = requiredHash(expectedHash, 'expectedHash')
  if (proposal.proposalHash !== normalizedExpectedHash) {
    throw new Error('expectedHash does not match proposal.proposalHash')
  }
  if (proposal.confirmationRequired && options.confirmed !== true) {
    throw new Error('this adaptive workflow proposal requires explicit user confirmation before commit')
  }

  await core.ready
  const sameName = (await core.pipelines.list()).filter(
    pipeline => pipeline.name === proposal.pipeline.name,
  )
  const exact = sameName.filter(pipeline => pipelineEquivalent(pipeline, proposal.pipeline))
  if (sameName.length > 0 && exact.length !== 1) {
    throw new Error(
      `adaptive Pipeline name ${JSON.stringify(proposal.pipeline.name)} is already used by a different or ambiguous definition`,
    )
  }

  const pipeline = exact[0] ?? await core.pipelines.create(proposal.pipeline)
  const action = exact.length === 1 ? 'reused' as const : 'created' as const
  if (options.runNow !== true) {
    return result(proposal, action, pipeline, 'not-started', false)
  }

  const triggerKey = `adaptive:${proposal.proposalHash}`
  const before = terminalState(await core.store.snapshot(), pipeline.id, triggerKey)
  if (before) {
    const paused = await pauseIfActive(core, pipeline)
    return result(
      proposal,
      action,
      paused,
      before.status,
      false,
      before.error,
    )
  }
  if (pipeline.status !== 'active') {
    throw new Error(`adaptive Pipeline ${pipeline.id} is ${pipeline.status} before its one-shot run`)
  }

  try {
    await core.pipelines.runWithTrigger(pipeline.id, triggerKey)
  } catch (error: unknown) {
    const afterFailure = terminalState(await core.store.snapshot(), pipeline.id, triggerKey)
    if (!afterFailure) throw error
    const paused = await pauseIfActive(core, pipeline)
    return result(
      proposal,
      action,
      paused,
      afterFailure.status,
      true,
      afterFailure.error ?? (error instanceof Error ? error.message : String(error)),
    )
  }

  const after = terminalState(await core.store.snapshot(), pipeline.id, triggerKey)
  if (!after || after.status !== 'completed') {
    throw new Error(`adaptive Pipeline ${pipeline.id} returned without a completed terminal record`)
  }
  const paused = await pauseIfActive(core, pipeline)
  return result(proposal, action, paused, 'completed', true)
}

export function parsePreparedWorkflowProposal(value: unknown): PreparedWorkflowProposal {
  if (!isRecord(value)) throw new Error('proposal must be an object')
  if (value.kind !== 'adaptive-workflow-proposal' || value.version !== 1) {
    throw new Error('proposal must be an adaptive-workflow-proposal version 1')
  }
  if (value.policyVersion !== 'adaptive-routing-mvp-v1') {
    throw new Error('unsupported adaptive routing proposal policy version')
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('proposal.createdAt must be a valid ISO timestamp')
  }
  if (typeof value.task !== 'string' || !value.task.trim()) {
    throw new Error('proposal.task must be a non-empty string')
  }
  if (!isRecord(value.assessment) || value.assessment.task !== value.task) {
    throw new Error('proposal.assessment must match proposal.task')
  }
  if (!isRecord(value.pipeline)) throw new Error('proposal.pipeline must be an object')
  if (typeof value.confirmationRequired !== 'boolean') {
    throw new Error('proposal.confirmationRequired must be a boolean')
  }
  if (!Array.isArray(value.warnings) || value.warnings.some(item => typeof item !== 'string')) {
    throw new Error('proposal.warnings must be an array of strings')
  }
  const proposalHash = requiredHash(value.proposalHash, 'proposal.proposalHash')
  const proposal = value as unknown as PreparedWorkflowProposal
  const recomputedAssessment = assessTask({
    task: proposal.task,
    mode: proposal.assessment.mode,
    explicitIntent: proposal.assessment.explicitIntent,
    confidence: proposal.assessment.confidence,
    signals: proposal.assessment.signals,
  })
  if (canonicalJson(recomputedAssessment) !== canonicalJson(proposal.assessment)) {
    throw new Error('proposal.assessment does not match the adaptive routing policy')
  }
  if (proposal.assessment.decision === 'direct') {
    throw new Error('adaptive workflow proposal cannot commit a direct-execution assessment')
  }
  if (
    proposal.assessment.signals.crossSessionNeed ||
    proposal.assessment.signals.crossAdapterNeed ||
    proposal.assessment.signals.sideEffectRisk === 'irreversible'
  ) {
    throw new Error('adaptive workflow proposal exceeds the MVP topology or side-effect boundary')
  }
  const expectedConfirmation =
    proposal.assessment.explicitIntent === 'preview' ||
    (
      proposal.assessment.explicitIntent !== 'force-flowit' &&
      !proposal.assessment.autoExecuteAllowed
    )
  if (proposal.confirmationRequired !== expectedConfirmation) {
    throw new Error('proposal.confirmationRequired does not match the adaptive routing policy')
  }
  validateMvpPipeline(proposal.pipeline)
  const actualHash = proposalHashFor(proposal)
  if (proposalHash !== actualHash) {
    throw new Error('proposalHash verification failed; the prepared Pipeline or assessment changed')
  }
  return proposal
}

function validateMvpPipeline(pipeline: CreatePipelineInput): void {
  if (typeof pipeline.name !== 'string' || !pipeline.name.trim()) {
    throw new Error('proposal.pipeline.name must be non-empty')
  }
  if (!pipeline.name.includes('[auto:')) {
    throw new Error('proposal.pipeline.name is missing its adaptive identity marker')
  }
  if (!isRecord(pipeline.trigger) || pipeline.trigger.kind !== 'manual') {
    throw new Error('adaptive routing MVP only supports a manual Pipeline trigger')
  }
  if (!Array.isArray(pipeline.nodes) || pipeline.nodes.length < 2 || pipeline.nodes.length > 6) {
    throw new Error('adaptive routing MVP requires 2 through 6 Pipeline nodes')
  }
  if (!Array.isArray(pipeline.edges) || pipeline.edges.length !== pipeline.nodes.length - 1) {
    throw new Error('adaptive routing MVP requires one linear edge between each adjacent node')
  }

  const ids = new Set<string>()
  let adapterId: string | undefined
  let sessionId: string | undefined
  for (const [index, node] of pipeline.nodes.entries()) {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id.trim()) {
      throw new Error(`proposal.pipeline.nodes[${index}].id must be non-empty`)
    }
    if (ids.has(node.id)) throw new Error(`duplicate adaptive Pipeline node ${node.id}`)
    ids.add(node.id)
    if (!isRecord(node.target)) throw new Error(`proposal.pipeline.nodes[${index}].target must be an object`)
    const currentAdapterId = requiredString(node.target.adapterId, `nodes[${index}].target.adapterId`)
    const currentSessionId = requiredString(node.target.sessionId, `nodes[${index}].target.sessionId`)
    adapterId ??= currentAdapterId
    sessionId ??= currentSessionId
    if (currentAdapterId !== adapterId || currentSessionId !== sessionId) {
      throw new Error('adaptive routing MVP nodes must use one Adapter and one confirmed Session')
    }
    if (typeof node.target.prompt !== 'string' || !node.target.prompt.trim()) {
      throw new Error(`nodes[${index}].target.prompt must be non-empty`)
    }
    if (!Array.isArray(node.target.skills) || node.target.skills.some(item => typeof item !== 'string')) {
      throw new Error(`nodes[${index}].target.skills must be an array of strings`)
    }
    if (!Array.isArray(node.target.contextRefs) || node.target.contextRefs.length !== 0) {
      throw new Error('adaptive routing MVP does not accept explicit cross-Session context references')
    }
    if (node.inheritUpstreamContext !== (index > 0)) {
      throw new Error('adaptive routing MVP requires only downstream nodes to inherit upstream context')
    }
  }

  for (const [index, edge] of pipeline.edges.entries()) {
    if (!isRecord(edge)) throw new Error(`proposal.pipeline.edges[${index}] must be an object`)
    const expectedFrom = pipeline.nodes[index]!.id
    const expectedTo = pipeline.nodes[index + 1]!.id
    if (edge.from !== expectedFrom || edge.to !== expectedTo) {
      throw new Error('adaptive routing MVP only accepts a linear Pipeline in node order')
    }
  }
}

function pipelineEquivalent(
  existing: PipelineDefinition,
  requested: CreatePipelineInput,
): boolean {
  return canonicalJson({
    name: existing.name,
    trigger: existing.trigger,
    nodes: existing.nodes,
    edges: existing.edges,
  }) === canonicalJson(requested)
}

function terminalState(
  state: WorkflowState,
  pipelineId: string,
  triggerKey: string,
): { status: 'completed' | 'dead-letter'; error?: string } | undefined {
  const receipt = state.terminalReceipts.find(
    item =>
      item.kind === 'pipeline' &&
      item.definitionId === pipelineId &&
      item.triggerKey === triggerKey,
  )
  if (receipt) {
    return receipt.status === 'completed'
      ? { status: 'completed' }
      : { status: 'dead-letter' }
  }
  const run = state.runs.findLast(
    item =>
      item.kind === 'pipeline' &&
      item.definitionId === pipelineId &&
      item.triggerKey === triggerKey,
  )
  if (run?.status === 'completed') return { status: 'completed' }
  if (run?.status === 'dead_letter') {
    return { status: 'dead-letter', ...(run.error ? { error: run.error } : {}) }
  }
  return undefined
}

async function pauseIfActive(
  core: FlowitOrchestrationCore,
  pipeline: PipelineDefinition,
): Promise<PipelineDefinition> {
  const current = (await core.pipelines.list()).find(candidate => candidate.id === pipeline.id)
  if (!current) throw new Error(`adaptive Pipeline ${pipeline.id} disappeared after execution`)
  return current.status === 'active'
    ? core.pipelines.setStatus(current.id, 'paused')
    : current
}

function result(
  proposal: PreparedWorkflowProposal,
  action: 'created' | 'reused',
  pipeline: PipelineDefinition,
  runStatus: CommitPreparedWorkflowResult['runStatus'],
  ran: boolean,
  error?: string,
): CommitPreparedWorkflowResult {
  return {
    kind: 'adaptive-workflow-commit-result',
    version: 1,
    proposalHash: proposal.proposalHash,
    action,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    pipelineStatus: pipeline.status,
    runStatus,
    ran,
    ...(error ? { error } : {}),
  }
}

function requiredHash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hex digest`)
  }
  return value
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
