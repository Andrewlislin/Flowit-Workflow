import type {
  AgentAdapterCapabilities,
  AgentExecutionEvidence,
  AgentExecutionPreflightResult,
  AgentExecutionRequirement,
  AgentSessionDescriptor,
  AgentSessionPlan,
  CreatePipelineInput,
} from '../core/types.js'

export type RoutingMode = 'manual' | 'suggest' | 'auto-safe'
export type RoutingExplicitIntent =
  | 'unspecified'
  | 'force-flowit'
  | 'force-direct'
  | 'preview'
export type RoutingDecisionKind = 'direct' | 'ask' | 'pipeline'
export type RoutingConfirmationChoice = 'pipeline'
export type RoutingWorkflowToolName =
  | 'workflow_assess'
  | 'workflow_prepare'
  | 'workflow_commit'
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

export interface RoutingAuthorityContext {
  readonly hostId: string
  readonly hostSessionId: string
  readonly turnNonce: string
}

export interface RoutingCallerContext {
  readonly hostId: string
  readonly hostSessionId: string
  readonly toolUseId: string
}

export interface TaskAssessmentRequest {
  readonly task: string
  readonly signals?: TaskAssessmentSignals
  readonly authorityToken?: string
}

export interface TrustedTaskAssessmentInput {
  readonly task: string
  readonly mode: RoutingMode
  readonly explicitIntent: RoutingExplicitIntent
  readonly trustedAuthority: boolean
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
  readonly policyVersion: 'adaptive-routing-mvp-v2'
  readonly task: string
  readonly mode: RoutingMode
  readonly explicitIntent: RoutingExplicitIntent
  readonly authorityTrusted: boolean
  readonly authorityContext?: RoutingAuthorityContext
  readonly decision: RoutingDecisionKind
  readonly score: number
  readonly confidence: number
  readonly signals: ResolvedTaskAssessmentSignals
  readonly reasons: readonly string[]
  readonly autoExecuteAllowed: boolean
  readonly question?: RoutingQuestion
}

export interface SignedTaskAssessment extends TaskAssessmentResult {
  readonly expiresAt: string
  readonly assessmentToken: string
}

export interface WorkflowTargetBinding {
  readonly adapterId: string
  readonly sessionId?: string
  readonly dedicatedCwd?: string
  readonly execution?: AgentExecutionRequirement
  readonly skills?: readonly string[]
}

export interface PrepareWorkflowInput {
  readonly assessmentToken: string
  readonly target: WorkflowTargetBinding
  readonly maxNodes?: number
  readonly pipelineName?: string
}

export interface ResolvedWorkflowBinding {
  readonly adapterId: string
  readonly sessionId: string
  readonly sessionPlan: AgentSessionPlan
  readonly session: AgentSessionDescriptor
  readonly capabilities: AgentAdapterCapabilities
  readonly skills: readonly string[]
  readonly execution?: AgentExecutionRequirement
  readonly preflight?: AgentExecutionPreflightResult
  readonly fingerprint: string
}

export interface PreparedWorkflowProposal {
  readonly kind: 'adaptive-workflow-proposal'
  readonly version: 2
  readonly policyVersion: 'adaptive-routing-mvp-v2'
  readonly createdAt: string
  readonly expiresAt: string
  readonly task: string
  readonly assessment: TaskAssessmentResult
  readonly assessmentToken: string
  readonly binding: ResolvedWorkflowBinding
  readonly pipeline: CreatePipelineInput
  readonly proposalHash: string
  readonly confirmationRequired: boolean
  readonly confirmationCode?: string
  readonly warnings: readonly string[]
}

export interface CommitPreparedWorkflowOptions {
  readonly confirmationToken?: string
  readonly callerContext?: RoutingCallerContext
}

export interface CommitPreparedWorkflowResult {
  readonly kind: 'adaptive-workflow-commit-result'
  readonly version: 2
  readonly proposalHash: string
  readonly action: 'accepted' | 'reused'
  readonly definitionId: string
  readonly pipelineName: string
  readonly runId?: string
  readonly runStatus: 'running' | 'completed' | 'dead-letter'
  readonly sessionId?: string
  readonly executionEvidence?: AgentExecutionEvidence
  readonly error?: string
}
