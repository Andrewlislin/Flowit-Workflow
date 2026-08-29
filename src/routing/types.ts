import type { CreatePipelineInput } from '../core/types.js'

export type RoutingMode = 'manual' | 'suggest' | 'auto-safe'
export type RoutingExplicitIntent =
  | 'unspecified'
  | 'force-flowit'
  | 'force-direct'
  | 'preview'
export type RoutingDecisionKind = 'direct' | 'ask' | 'pipeline'
export type TaskKind = 'general' | 'research' | 'coding' | 'content'
export type SideEffectRisk = 'none' | 'reversible' | 'irreversible'
export type SignalLevel = 0 | 1 | 2 | 3

export interface TaskAssessmentSignals {
  readonly taskKind?: TaskKind
  readonly distinctStages?: number
  readonly decomposability?: SignalLevel
  readonly coupling?: SignalLevel
  readonly durabilityNeed?: SignalLevel
  readonly reviewNeed?: SignalLevel
  readonly requiresResearch?: boolean
  readonly repeatable?: boolean
  readonly crossSessionNeed?: boolean
  readonly crossAdapterNeed?: boolean
  readonly sideEffectRisk?: SideEffectRisk
  readonly ambiguity?: SignalLevel
}

export interface ResolvedTaskAssessmentSignals {
  readonly taskKind: TaskKind
  readonly distinctStages: number
  readonly decomposability: SignalLevel
  readonly coupling: SignalLevel
  readonly durabilityNeed: SignalLevel
  readonly reviewNeed: SignalLevel
  readonly requiresResearch: boolean
  readonly repeatable: boolean
  readonly crossSessionNeed: boolean
  readonly crossAdapterNeed: boolean
  readonly sideEffectRisk: SideEffectRisk
  readonly ambiguity: SignalLevel
}

export interface TaskAssessmentInput {
  readonly task: string
  readonly mode?: RoutingMode
  readonly explicitIntent?: RoutingExplicitIntent
  readonly confidence?: number
  readonly signals?: TaskAssessmentSignals
}

export interface RoutingQuestionOption {
  readonly id: 'direct' | 'pipeline' | 'preview'
  readonly label: string
  readonly consequence: string
}

export interface RoutingQuestion {
  readonly prompt: string
  readonly options: readonly RoutingQuestionOption[]
}

export interface TaskAssessmentResult {
  readonly kind: 'task-assessment'
  readonly version: 1
  readonly policyVersion: 'adaptive-routing-mvp-v1'
  readonly task: string
  readonly mode: RoutingMode
  readonly explicitIntent: RoutingExplicitIntent
  readonly decision: RoutingDecisionKind
  readonly score: number
  readonly confidence: number
  readonly signals: ResolvedTaskAssessmentSignals
  readonly reasons: readonly string[]
  readonly autoExecuteAllowed: boolean
  readonly question?: RoutingQuestion
}

export interface WorkflowTargetBinding {
  readonly adapterId: string
  readonly sessionId: string
  readonly skills?: readonly string[]
}

export interface PrepareWorkflowInput extends TaskAssessmentInput {
  readonly target: WorkflowTargetBinding
  readonly maxNodes?: number
  readonly pipelineName?: string
}

export interface PreparedWorkflowProposal {
  readonly kind: 'adaptive-workflow-proposal'
  readonly version: 1
  readonly policyVersion: 'adaptive-routing-mvp-v1'
  readonly createdAt: string
  readonly task: string
  readonly assessment: TaskAssessmentResult
  readonly pipeline: CreatePipelineInput
  readonly proposalHash: string
  readonly confirmationRequired: boolean
  readonly warnings: readonly string[]
}

export interface CommitPreparedWorkflowOptions {
  readonly confirmed?: boolean
  readonly runNow?: boolean
}

export interface CommitPreparedWorkflowResult {
  readonly kind: 'adaptive-workflow-commit-result'
  readonly version: 1
  readonly proposalHash: string
  readonly action: 'created' | 'reused'
  readonly pipelineId: string
  readonly pipelineName: string
  readonly pipelineStatus: 'active' | 'paused'
  readonly runStatus: 'not-started' | 'completed' | 'dead-letter'
  readonly ran: boolean
  readonly error?: string
}
