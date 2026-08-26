export type AutomationStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'failed'

export interface SessionContextRef {
  sessionId: string
  label?: string
}

export interface AutomationTarget {
  sessionId: string
  prompt: string
  skills: string[]
  contextRefs: SessionContextRef[]
}

export type ScheduleTiming =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everySeconds: number }

export interface ScheduledTask {
  id: string
  name: string
  target: AutomationTarget
  timing: ScheduleTiming
  status: AutomationStatus
  nextRunAt?: string
  lastRunAt?: string
  createdAt: string
  updatedAt: string
}

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
  | { kind: 'session_turn_completed'; sessionId: string }

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

export type AutomationRunStatus = 'running' | 'completed' | 'failed'

export interface AutomationRunRecord {
  id: string
  kind: 'schedule' | 'pipeline'
  definitionId: string
  triggerKey: string
  status: AutomationRunStatus
  startedAt: string
  completedAt?: string
  error?: string
  nodeResults?: Array<{
    nodeId: string
    sessionId: string
    loadedSkills: string[]
    referencedSessions: string[]
  }>
}

export interface WorkflowState {
  version: 1
  schedules: ScheduledTask[]
  pipelines: PipelineDefinition[]
  runs: AutomationRunRecord[]
}

export interface FlowitWorkflowConfig {
  /** Durable state path. Relative paths are resolved from process.cwd(). */
  storageFile?: string
  /** Minimum fixed-rate schedule interval. Defaults to 60 seconds. */
  minimumIntervalSeconds?: number
  /** Register model-facing mutation tools. Disabled by default. */
  allowModelMutations?: boolean
  /** Maximum retained run records. Defaults to 500. */
  maxRunHistory?: number
}

export interface CreateScheduleInput {
  name: string
  target: AutomationTarget
  timing: ScheduleTiming
}

export interface CreatePipelineInput {
  name: string
  trigger: PipelineTrigger
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}

export interface LinearPipelineStepInput {
  id: string
  sessionId: string
  prompt: string
  skills?: string[]
  contextSessions?: string[]
}
