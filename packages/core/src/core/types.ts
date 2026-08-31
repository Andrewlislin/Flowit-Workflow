export type AdapterId = string
export type AgentEventKind =
  | 'session_started'
  | 'session_ended'
  | 'turn_completed'
  | 'turn_failed'
  | 'task_completed'
  | 'subagent_completed'

export interface AgentSessionRef {
  adapterId?: AdapterId
  sessionId: string
  label?: string
}
export interface AgentSessionDescriptor {
  adapterId: AdapterId
  sessionId: string
  name?: string
  cwd?: string
  status: 'live' | 'idle' | 'ended' | 'unknown'
  updatedAt?: string
}
export interface SessionContextRef extends AgentSessionRef {}

export type AgentRuntimeMatchPolicy = 'inherit' | 'exact' | 'preferred'
export interface AgentRuntimeRequirement {
  model?: string
  reasoningEffort?: string
  match: AgentRuntimeMatchPolicy
}
export type AgentExecutionCapability =
  | 'workspace-read'
  | 'workspace-write'
  | 'shell'
  | 'network'
  | 'browser'
export interface AgentExecutionRequirement {
  runtime?: AgentRuntimeRequirement
  requiredCapabilities?: AgentExecutionCapability[]
}
export type AgentSessionPlan =
  | { kind: 'existing'; sessionId: string }
  | { kind: 'dedicated'; cwd: string }
export interface AgentExecutionPreflightRequest {
  correlationId: string
  session: AgentSessionPlan
  requirement: AgentExecutionRequirement
  skills: readonly string[]
}
export type AgentExecutionBlockerCode =
  | 'EXECUTABLE_UNAVAILABLE'
  | 'HOST_VERSION_INCOMPATIBLE'
  | 'MODEL_UNAVAILABLE'
  | 'REASONING_EFFORT_UNAVAILABLE'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'SESSION_WRITER_LOCKED'
  | 'PERMISSION_UNAVAILABLE'
  | 'SKILL_UNAVAILABLE'
  | 'UNSUPPORTED'
export interface AgentExecutionBlocker {
  code: AgentExecutionBlockerCode
  message: string
  retryable: boolean
}
export interface AgentExecutionEvidence {
  host?: {
    executable?: string
    version?: string
    protocolVersion?: string
  }
  runtime?: {
    requestedModel?: string
    requestedReasoningEffort?: string
    actualModel?: string
    actualReasoningEffort?: string
    verified: boolean
  }
  session: {
    strategy: AgentSessionPlan['kind']
    sessionId?: string
    exclusive?: boolean
  }
}
export interface AgentExecutionPreflightResult {
  status: 'ready' | 'blocked' | 'unsupported'
  evidence: AgentExecutionEvidence
  blockers: AgentExecutionBlocker[]
}
export interface ProvisionedAgentSession {
  session: AgentSessionDescriptor
  managed: boolean
  evidence: AgentExecutionEvidence
}

export type SessionProvisioningIntentStatus = 'reserved' | 'provisioned' | 'uncertain'
export interface SessionProvisioningIntent {
  id: string
  definitionId: string
  triggerKey: string
  adapterId: AdapterId
  sessionPlan: Extract<AgentSessionPlan, { kind: 'dedicated' }>
  requirement: AgentExecutionRequirement
  skills: string[]
  pipelineSnapshot: RunOncePipelineSnapshot
  status: SessionProvisioningIntentStatus
  createdAt: string
  updatedAt: string
  provisioned?: ProvisionedAgentSession
  error?: string
}

export interface AutomationTarget {
  adapterId?: AdapterId
  sessionId: string
  prompt: string
  skills: string[]
  contextRefs: SessionContextRef[]
  execution?: AgentExecutionRequirement
}
export interface AdapterContextRef {
  adapterId: AdapterId
  sessionId: string
  label?: string
}
export interface AgentDispatchRequest {
  correlationId: string
  sessionId: string
  prompt: string
  skills: string[]
  contextRefs: AdapterContextRef[]
  attempt?: number
  execution?: AgentExecutionRequirement
}
export interface AgentDispatchResult {
  sessionId: string
  loadedSkills: string[]
  referencedSessions: string[]
  runId?: string
  outputSummary?: string
  executionEvidence?: AgentExecutionEvidence
}
export interface AgentEvent {
  adapterId: AdapterId
  sessionId: string
  kind: AgentEventKind
  eventId: string
  at: string
  metadata?: Record<string, unknown>
}
export interface AgentAdapterCapabilities {
  coldResume: boolean
  liveDispatch: boolean
  skillBinding: boolean
  contextReference: 'native' | 'summary' | 'none'
  eventSubscription: boolean
  executionPreflight?: boolean
  sessionProvisioning?: 'none' | 'dedicated' | 'pool'
  runtimeSelection?: 'none' | 'session' | 'turn'
  runtimeIntrospection?: boolean
  lockInspection?: boolean
}
export interface AgentAdapter {
  readonly id: AdapterId
  readonly capabilities: AgentAdapterCapabilities
  start?(signal?: AbortSignal): Promise<void> | void
  listSessions(query?: string, signal?: AbortSignal): Promise<AgentSessionDescriptor[]>
  preflightExecution?(
    request: AgentExecutionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<AgentExecutionPreflightResult>
  provisionSession?(
    request: AgentExecutionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<ProvisionedAgentSession>
  releaseSession?(
    session: ProvisionedAgentSession,
    signal?: AbortSignal,
  ): Promise<void>
  dispatch(request: AgentDispatchRequest, signal?: AbortSignal): Promise<AgentDispatchResult>
  validateSkillBindings?(
    sessionId: string,
    skills: readonly string[],
    signal?: AbortSignal,
  ): Promise<void>
  subscribe?(listener: (event: AgentEvent) => Promise<void> | void): () => void
  dispose?(): Promise<void> | void
}

export type AutomationStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'failed'
export type CalendarDayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6
export type ScheduleTiming =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everySeconds: number }
  | {
      kind: 'calendar'
      timeZone: string
      hour: number
      minute: number
      daysOfWeek?: CalendarDayOfWeek[]
    }
interface ScheduledTaskBase {
  id: string
  name: string
  timing: ScheduleTiming
  status: AutomationStatus
  nextRunAt?: string
  lastRunAt?: string
  createdAt: string
  updatedAt: string
}
export interface ScheduledAgentTask extends ScheduledTaskBase {
  target: AutomationTarget
  pipelineId?: never
}
export interface ScheduledPipelineTask extends ScheduledTaskBase {
  pipelineId: string
  target?: never
}
export type ScheduledTask = ScheduledAgentTask | ScheduledPipelineTask
export interface PipelineNode {
  id: string
  target: AutomationTarget
  inheritUpstreamContext: boolean
}
export interface PipelineEdge {
  from: string
  to: string
}
export type PipelineTrigger =
  | { kind: 'manual' }
  | {
      kind: 'agent_event'
      adapterId?: AdapterId
      sessionId: string
      event: Extract<AgentEventKind, 'turn_completed' | 'task_completed' | 'subagent_completed'>
    }
  | { kind: 'session_turn_completed'; adapterId?: AdapterId; sessionId: string }
export interface PipelineDefinition {
  id: string
  name: string
  trigger: PipelineTrigger
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  status: 'active' | 'paused'
  createdAt: string
  updatedAt: string
}

export interface RunOncePipelineSnapshot {
  version: 1
  name: string
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}

export interface PipelineEventAdmission {
  id: string
  pipelineId: string
  triggerKey: string
  adapterId: AdapterId
  sessionId: string
  eventKind: AgentEventKind
  eventId: string
  receivedAt: string
}

export type AutomationRunStatus = 'running' | 'completed' | 'failed' | 'dead_letter'
export interface AutomationRunNodeResult {
  nodeId: string
  adapterId: AdapterId
  sessionId: string
  loadedSkills: string[]
  referencedSessions: string[]
  outputSummary?: string
  executionEvidence?: AgentExecutionEvidence
}
export interface AutomationRunRecord {
  id: string
  kind: 'schedule' | 'pipeline'
  definitionId: string
  triggerKey: string
  status: AutomationRunStatus
  attempt: number
  startedAt: string
  updatedAt: string
  completedAt?: string
  error?: string
  retryNotBefore?: string
  leaseOwner?: string
  leaseExpiresAt?: string
  lastHeartbeatAt?: string
  permanentDedupe?: boolean
  nodeResults?: AutomationRunNodeResult[]
  pipelineSnapshot?: RunOncePipelineSnapshot
}
export interface AutomationTerminalReceipt {
  kind: 'schedule' | 'pipeline'
  definitionId: string
  triggerKey: string
  status: 'completed' | 'dead_letter'
  recordedAt: string
}
export interface WorkflowState {
  /**
   * Version 2 is the execution-contract fence. Version 1 is accepted only as
   * an on-load migration input and is rewritten to version 2 before the Store
   * becomes visible to workers.
   */
  version: 1 | 2
  schedules: ScheduledTask[]
  pipelines: PipelineDefinition[]
  eventInbox: PipelineEventAdmission[]
  runs: AutomationRunRecord[]
  terminalReceipts: AutomationTerminalReceipt[]
  provisioningIntents: SessionProvisioningIntent[]
}

export interface FlowitCoreConfig {
  storageFile?: string
  legacyStorageFiles?: string[]
  defaultAdapterId: AdapterId
  minimumIntervalSeconds?: number
  maxRunHistory?: number
  maxTerminalReceipts?: number
  terminalReceiptRetentionMs?: number
  maxEventInbox?: number
  activeWorkers?: boolean
  workerId?: string
  leaseDurationMs?: number
  retryDelayMs?: number
  maxPipelineAttempts?: number
  maxScheduleAttempts?: number
}
interface CreateScheduleBaseInput {
  name: string
  timing: ScheduleTiming
}
export interface CreateAgentScheduleInput extends CreateScheduleBaseInput {
  target: AutomationTarget
  pipelineId?: never
}
export interface CreatePipelineScheduleInput extends CreateScheduleBaseInput {
  pipelineId: string
  target?: never
}
export type CreateScheduleInput = CreateAgentScheduleInput | CreatePipelineScheduleInput
export interface CreatePipelineInput {
  name: string
  trigger: PipelineTrigger
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}
export interface LinearPipelineStepInput {
  id: string
  adapterId?: AdapterId
  sessionId: string
  prompt: string
  skills?: string[]
  contextSessions?: Array<string | SessionContextRef>
}
