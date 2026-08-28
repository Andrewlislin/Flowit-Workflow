export type SetupHostId = string
export type SetupScope = 'user' | 'project'
export type SetupOperation = 'setup' | 'repair' | 'uninstall'
export type SetupOutcomeStatus =
  | 'complete'
  | 'partial'
  | 'manual-action-required'
  | 'unsupported'
  | 'failed'

export type HostDetectionStatus = 'detected' | 'not-detected' | 'unknown'
export type DoctorCheckStatus = 'ok' | 'warning' | 'error' | 'skipped'
export type DoctorStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unavailable'
export type SetupActionRisk = 'read-only' | 'filesystem' | 'configuration' | 'process' | 'destructive'

export interface HostSetupContext {
  readonly cwd: string
  readonly homeDir: string
  readonly packageRoot: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly nodeVersion: string
  readonly env: Readonly<NodeJS.ProcessEnv>
}

export interface HostDetection {
  readonly hostId: SetupHostId
  readonly displayName: string
  readonly status: HostDetectionStatus
  readonly version?: string
  readonly details?: Readonly<Record<string, unknown>>
  readonly message?: string
}

export interface SetupAction {
  readonly id: string
  readonly kind: string
  readonly description: string
  readonly risk: SetupActionRisk
  readonly requiresConfirmation: boolean
  readonly reversible: boolean
  readonly target?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface SetupPlan {
  readonly version: 1
  readonly operation: SetupOperation
  readonly hostId: SetupHostId
  readonly displayName: string
  readonly scope: SetupScope
  readonly summary: string
  readonly actions: readonly SetupAction[]
  readonly warnings: readonly string[]
  readonly manualSteps: readonly string[]
}

export interface SetupRequestOptions {
  readonly scope: SetupScope
  readonly projectDir: string
}

export interface SetupApplyOptions extends SetupRequestOptions {
  readonly assumeYes: boolean
}

export interface DoctorOptions extends SetupRequestOptions {}

export interface DoctorCheck {
  readonly id: string
  readonly status: DoctorCheckStatus
  readonly summary: string
  readonly detail?: string
  readonly repairable?: boolean
}

export interface DoctorReport {
  readonly hostId: SetupHostId
  readonly displayName: string
  readonly status: DoctorStatus
  readonly checks: readonly DoctorCheck[]
}

export interface SetupResult {
  readonly operation: SetupOperation
  readonly hostId: SetupHostId
  readonly displayName: string
  readonly status: SetupOutcomeStatus
  readonly appliedActions: readonly string[]
  readonly skippedActions: readonly string[]
  readonly warnings: readonly string[]
  readonly manualSteps: readonly string[]
  readonly doctor?: DoctorReport
}

export interface HostSetupProvider {
  readonly id: SetupHostId
  readonly displayName: string

  detect(context: HostSetupContext): Promise<HostDetection>

  planSetup(
    context: HostSetupContext,
    options: SetupRequestOptions,
  ): Promise<SetupPlan>
  applySetup(
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult>

  doctor(
    context: HostSetupContext,
    options: DoctorOptions,
  ): Promise<DoctorReport>

  planRepair(
    context: HostSetupContext,
    report: DoctorReport,
    options: SetupRequestOptions,
  ): Promise<SetupPlan>
  applyRepair(
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult>

  planUninstall(
    context: HostSetupContext,
    options: SetupRequestOptions,
  ): Promise<SetupPlan>
  applyUninstall(
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult>
}
