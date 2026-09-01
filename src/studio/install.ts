import path from 'node:path'
import {
  applySetupMutation,
  executeDoctorCommand,
  prepareSetupMutation,
  type AppliedSetupMutation,
  type PreparedSetupMutation,
} from '../setup/commands.js'
import type { HostSetupRegistry } from '../setup/registry.js'
import type { HostSetupContext, SetupAction, SetupScope } from '../setup/types.js'
import { loadDeclarativeStudioPreset } from './dsl.js'
import type {
  InstalledStudioPackage,
  StudioPackageSnapshot,
  StudioPackageStore,
} from './store.js'
import {
  intentAuthorizesStandardInstall,
  type StudioInstallIntent,
} from './trust.js'
import type { StudioPermissionRequirement } from './types.js'

export interface PrepareStudioInstallOptions {
  readonly sourceRoot: string
  readonly hostId: string
  readonly scope: SetupScope
  readonly projectDir: string
  readonly intent: StudioInstallIntent
}

export interface PreparedStudioInstallTransaction {
  readonly kind: 'studio-install-plan'
  readonly intent: StudioInstallIntent
  readonly snapshot: StudioPackageSnapshot
  readonly hostId: string
  readonly scope: SetupScope
  readonly projectDir: string
  readonly hostSetup: PreparedSetupMutation
  readonly elevatedPermissions: readonly StudioPermissionRequirement[]
  readonly elevatedSetupActions: readonly SetupAction[]
  readonly manualSteps: readonly string[]
  readonly canApplyWithoutAdditionalConfirmation: boolean
}

export interface ApplyStudioInstallOptions {
  readonly allowElevated?: boolean
}

export interface AppliedStudioInstallTransaction {
  readonly kind: 'studio-install-result'
  readonly studioId: string
  readonly version: string
  readonly status: 'complete' | 'manual-action-required' | 'partial'
  readonly installed: InstalledStudioPackage
  readonly hostSetup: AppliedSetupMutation
  readonly manualSteps: readonly string[]
  readonly warnings: readonly string[]
}

export async function prepareStudioInstallTransaction(
  options: PrepareStudioInstallOptions,
  setupContext: HostSetupContext,
  setupRegistry: HostSetupRegistry,
  packageStore: StudioPackageStore,
): Promise<PreparedStudioInstallTransaction> {
  const snapshot = await packageStore.stageFromDirectory(options.sourceRoot)
  try {
    const descriptor = snapshot
    if (descriptor.manifest.id !== options.intent.studioId) {
      throw new Error(
        `Studio install intent is for ${options.intent.studioId}, package is ${descriptor.manifest.id}`,
      )
    }
    if (!descriptor.manifest.supportedHosts.includes(options.hostId)) {
      throw new Error(
        `Studio ${descriptor.manifest.id} does not declare support for host ${options.hostId}`,
      )
    }
    if (!intentAuthorizesStandardInstall(options.intent, 'standard-host-integration')) {
      throw new Error('Studio install intent does not authorize standard host integration')
    }
    if (!intentAuthorizesStandardInstall(options.intent, 'managed-package-files')) {
      throw new Error('Studio install intent does not authorize Flowit-managed package files')
    }

    // Review executable declarations only after bytes are inside Flowit-owned staging.
    await loadDeclarativeStudioPreset(descriptor)

    const projectDir = path.resolve(options.projectDir)
    const hostSetup = await prepareSetupMutation('setup', setupContext, setupRegistry, {
      target: options.hostId,
      scope: options.scope,
      projectDir,
    })
    const elevatedPermissions = (descriptor.manifest.permissions ?? []).filter(
      permission => permission.risk === 'elevated',
    )
    const elevatedSetupActions = hostSetup.plans.flatMap(plan =>
      plan.actions.filter(action => !standardSetupAction(action)),
    )
    const manualSteps = hostSetup.plans.flatMap(plan => plan.manualSteps)

    return {
      kind: 'studio-install-plan',
      intent: options.intent,
      snapshot,
      hostId: options.hostId,
      scope: options.scope,
      projectDir,
      hostSetup,
      elevatedPermissions,
      elevatedSetupActions,
      manualSteps,
      canApplyWithoutAdditionalConfirmation:
        options.intent.initiatedByUser &&
        elevatedPermissions.length === 0 &&
        elevatedSetupActions.length === 0,
    }
  } catch (error: unknown) {
    await packageStore.discardSnapshot(snapshot).catch(() => undefined)
    throw error
  }
}

export async function applyStudioInstallTransaction(
  prepared: PreparedStudioInstallTransaction,
  setupContext: HostSetupContext,
  setupRegistry: HostSetupRegistry,
  packageStore: StudioPackageStore,
  options: ApplyStudioInstallOptions = {},
): Promise<AppliedStudioInstallTransaction> {
  const requiresElevated =
    prepared.elevatedPermissions.length > 0 || prepared.elevatedSetupActions.length > 0
  if (requiresElevated && !options.allowElevated) {
    throw new Error(
      'Studio install requires elevated permissions outside the standard install intent',
    )
  }

  // commitSnapshot re-fences and re-hashes exactly the bytes reviewed by prepare.
  const installed = await packageStore.commitSnapshot(prepared.snapshot)

  let hostSetup: AppliedSetupMutation
  try {
    hostSetup = await applySetupMutation(
      prepared.hostSetup,
      setupContext,
      setupRegistry,
      prepared.canApplyWithoutAdditionalConfirmation || Boolean(options.allowElevated),
    )
  } catch (error: unknown) {
    throw new Error(
      `Studio package was installed but host integration failed; package remains available for repair: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const doctor = await executeDoctorCommand(setupContext, setupRegistry, {
    target: prepared.hostId,
    scope: prepared.scope,
    projectDir: prepared.projectDir,
  })
  const report = doctor.reports[0]
  const manualSteps = unique([
    ...prepared.manualSteps,
    ...hostSetup.results.flatMap(result => result.manualSteps),
  ])
  const warnings = unique(hostSetup.results.flatMap(result => result.warnings))
  const hostIncomplete = hostSetup.results.some(
    result =>
      result.status === 'partial' ||
      result.status === 'failed' ||
      result.status === 'unsupported',
  )
  const doctorFailed = report?.status === 'unhealthy'
  const needsManual =
    manualSteps.length > 0 ||
    hostSetup.results.some(result => result.status === 'manual-action-required') ||
    report?.status === 'degraded' ||
    report?.status === 'unavailable'

  return {
    kind: 'studio-install-result',
    studioId: installed.manifest.id,
    version: installed.manifest.version,
    status:
      hostIncomplete || doctorFailed
        ? 'partial'
        : needsManual
          ? 'manual-action-required'
          : 'complete',
    installed,
    hostSetup,
    manualSteps,
    warnings,
  }
}

export function standardSetupAction(action: SetupAction): boolean {
  return (
    action.risk === 'read-only' ||
    action.risk === 'filesystem' ||
    action.risk === 'configuration' ||
    action.risk === 'process'
  )
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}
