import { rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  DoctorReport,
  HostDetection,
  HostSetupContext,
  HostSetupProvider,
  SetupApplyOptions,
  SetupOperation,
  SetupPlan,
  SetupRequestOptions,
  SetupResult,
} from '../types.js'
import { durableWriteText, readTextSnapshot } from './workbuddy-files.js'
import {
  DSH_SETUP_DISPLAY_NAME,
  DSH_SETUP_HOST_ID,
  DSH_SETUP_MANIFEST_VERSION,
  detectDsh,
  dshDoctorChecks,
  dshManualSteps,
  dshSetupPaths,
  extractDshManagedBlock,
  hasForeignDshFlowitEntry,
  inspectDshState,
  removeDshManagedBlock,
  upsertDshManagedBlock,
  type DshSetupManifest,
  type DshState,
} from './dsh-state.js'

export class DshSetupProvider implements HostSetupProvider {
  readonly id = DSH_SETUP_HOST_ID
  readonly displayName = DSH_SETUP_DISPLAY_NAME

  async detect(context: HostSetupContext): Promise<HostDetection> {
    const detected = await detectDsh(context)
    const userPaths = dshSetupPaths(context, { scope: 'user', projectDir: context.cwd })
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: detected ? 'detected' : 'not-detected',
      details: {
        dshHome: userPaths.dshHome,
        userPatch: userPaths.patchFile,
        projectOverlay: path.join(context.cwd, '.flowit-workflow', 'dsh', 'cordis.patch.yml'),
      },
      ...(detected ? {} : {
        message: 'DeepSeek Harness was not detected on PATH or in standard project/home locations; setup can still stage the native plugin patch.',
      }),
    }
  }

  async planSetup(context: HostSetupContext, options: SetupRequestOptions): Promise<SetupPlan> {
    return this.buildPlan('setup', context, options)
  }

  async applySetup(
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult> {
    return this.applyPlan('setup', context, plan, options)
  }

  async doctor(context: HostSetupContext, options: SetupRequestOptions): Promise<DoctorReport> {
    try {
      const state = await inspectDshState(context, options)
      const checks = dshDoctorChecks(options, state)
      const status = checks.some(check => check.status === 'error')
        ? 'unhealthy'
        : checks.some(check => check.status === 'warning')
          ? 'degraded'
          : 'healthy'
      return { hostId: this.id, displayName: this.displayName, status, checks }
    } catch (error: unknown) {
      return {
        hostId: this.id,
        displayName: this.displayName,
        status: 'unhealthy',
        checks: [{
          id: 'dsh-state',
          status: 'error',
          summary: 'DeepSeek Harness setup state could not be inspected',
          detail: error instanceof Error ? error.message : String(error),
        }],
      }
    }
  }

  async planRepair(
    context: HostSetupContext,
    _report: DoctorReport,
    options: SetupRequestOptions,
  ): Promise<SetupPlan> {
    return this.buildPlan('repair', context, options)
  }

  async applyRepair(
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult> {
    return this.applyPlan('repair', context, plan, options)
  }

  async planUninstall(context: HostSetupContext, options: SetupRequestOptions): Promise<SetupPlan> {
    const state = await inspectDshState(context, options)
    const actions: SetupPlan['actions'][number][] = []
    const warnings = [...state.conflicts]

    if (state.managedBlock) {
      if (state.manifest && state.managedBlock.hash === state.manifest.blockHash) {
        actions.push(action(
          'remove-plugin-patch',
          'edit-yaml',
          'Remove the installer-owned Flowit plugin patch from DeepSeek Harness configuration',
          'configuration',
          true,
          true,
          state.paths.patchFile,
          { expectedHash: state.patch.hash },
        ))
      } else {
        warnings.push('The Flowit DeepSeek Harness plugin patch cannot be proven installer-owned and will be preserved.')
      }
    }
    if (state.manifest) {
      actions.push(action(
        'remove-manifest',
        'remove-file',
        'Remove the DeepSeek Harness setup ownership manifest',
        'destructive',
        true,
        false,
        state.paths.setupManifestFile,
        { expectedHash: state.manifestSnapshot.hash },
      ))
    }
    warnings.push(`Workflow state at ${state.paths.storageFile} is retained.`)

    return {
      version: 1,
      operation: 'uninstall',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: actions.length === 0
        ? 'No installer-owned DeepSeek Harness plugin patch can be removed automatically.'
        : 'Remove only the Flowit DSH patch still provably owned by setup.',
      actions,
      warnings,
      manualSteps: options.scope === 'user'
        ? ['Restart DeepSeek Harness so the home patch layer is recomposed without Flowit.']
        : ['Stop using the generated Flowit --patch overlay in future DeepSeek Harness launches.'],
    }
  }

  async applyUninstall(
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult> {
    return this.applyPlan('uninstall', context, plan, options)
  }

  private async buildPlan(
    operation: Extract<SetupOperation, 'setup' | 'repair'>,
    context: HostSetupContext,
    options: SetupRequestOptions,
  ): Promise<SetupPlan> {
    const state = await inspectDshState(context, options)
    const warnings = [...state.conflicts]
    if (state.conflicts.length > 0) {
      return {
        version: 1,
        operation,
        hostId: this.id,
        displayName: this.displayName,
        scope: options.scope,
        summary: 'DeepSeek Harness setup is blocked because the target patch cannot be proven installer-owned.',
        actions: [],
        warnings,
        manualSteps: [
          `Resolve the reported DSH patch conflict in ${state.paths.patchFile}, then rerun \`flowit-workflow setup dsh --dry-run\`.`,
          ...dshManualSteps(options, state),
        ],
      }
    }

    const actions: SetupPlan['actions'][number][] = []
    const blockNeedsWrite = state.managedBlock?.hash !== state.desiredBlockHash
    const patchExistedBefore = state.manifest?.patchExistedBefore ?? state.patch.exists
    const manifestNeedsWrite = !state.manifest
      || state.manifest.blockHash !== state.desiredBlockHash
      || state.manifest.storageFile !== state.paths.storageFile

    if (!state.manifest && blockNeedsWrite) {
      actions.push(manifestAction(state, patchExistedBefore, true))
    }
    if (blockNeedsWrite) {
      actions.push(action(
        'upsert-plugin-patch',
        'edit-yaml',
        'Install/update the Flowit native plugin in the DeepSeek Harness patch layer',
        'configuration',
        true,
        true,
        state.paths.patchFile,
        { expectedHash: state.patch.hash, blockHash: state.desiredBlockHash },
      ))
    }
    if (state.manifest && manifestNeedsWrite) {
      actions.push(manifestAction(state, patchExistedBefore, false))
    }

    if (options.scope === 'user') {
      warnings.push(
        'User scope installs Flowit in the Harness home cordis.patch.yml layer, so it applies to every DSH profile that provides the required agent/session/tool services.',
      )
    } else {
      warnings.push(
        'DeepSeek Harness has no project-local persistent patch layer; project scope creates a project-owned overlay that must be supplied with --patch when DSH starts.',
      )
    }

    return {
      version: 1,
      operation,
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: operation === 'setup'
        ? 'Configure Flowit as a native DeepSeek Harness Cordis plugin with model mutation tools enabled by this confirmation-gated setup.'
        : 'Repair only the installer-owned Flowit Cordis patch without overwriting other Harness patch entries.',
      actions,
      warnings,
      manualSteps: dshManualSteps(options, state),
    }
  }

  private async applyPlan(
    operation: SetupOperation,
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult> {
    assertPlan(plan, operation, options)
    const state = await inspectDshState(context, options)
    if (operation !== 'uninstall' && state.conflicts.length > 0 && plan.actions.length > 0) {
      throw new Error('DeepSeek Harness patch ownership changed after planning; refusing to modify it')
    }
    assertPlannedSnapshots(plan, state)
    preflightOwnership(plan, state)

    const applied: string[] = []
    const skipped: string[] = []
    for (const row of plan.actions) {
      const changed = await applyAction(row, options, state)
      ;(changed ? applied : skipped).push(row.id)
    }

    if (operation === 'uninstall') {
      const meaningfulWarnings = plan.warnings.filter(warning => !warning.startsWith('Workflow state at '))
      return {
        operation,
        hostId: this.id,
        displayName: this.displayName,
        status: skipped.length > 0 || meaningfulWarnings.length > 0 ? 'partial' : 'complete',
        appliedActions: applied,
        skippedActions: skipped,
        warnings: plan.warnings,
        manualSteps: plan.manualSteps,
      }
    }

    const fresh = await inspectDshState(context, options)
    const doctor = await this.doctor(context, options)
    const manualRequired = options.scope === 'project' || !fresh.dshExecutable
    return {
      operation,
      hostId: this.id,
      displayName: this.displayName,
      status: doctor.status === 'unhealthy'
        ? 'failed'
        : manualRequired
          ? 'manual-action-required'
          : 'complete',
      appliedActions: applied,
      skippedActions: skipped,
      warnings: plan.warnings,
      manualSteps: dshManualSteps(options, fresh),
      doctor,
    }
  }
}

async function applyAction(
  row: SetupPlan['actions'][number],
  options: SetupRequestOptions,
  state: DshState,
): Promise<boolean> {
  switch (row.id) {
    case 'write-manifest': {
      const latest = await readTextSnapshot(state.paths.setupManifestFile)
      assertHash('DeepSeek Harness setup manifest', latest.hash, row.details?.expectedHash, state.paths.setupManifestFile)
      const blockHash = row.details?.blockHash
      const patchExistedBefore = row.details?.patchExistedBefore
      const storageFile = row.details?.storageFile
      if (typeof blockHash !== 'string' || typeof patchExistedBefore !== 'boolean' || typeof storageFile !== 'string') {
        throw new Error('DeepSeek Harness setup manifest action is missing ownership metadata')
      }
      const manifest: DshSetupManifest = {
        version: DSH_SETUP_MANIFEST_VERSION,
        hostId: DSH_SETUP_HOST_ID,
        scope: options.scope,
        projectDir: path.resolve(options.projectDir),
        patchFile: state.paths.patchFile,
        blockHash,
        patchExistedBefore,
        storageFile,
        installedAt: state.manifest?.installedAt ?? new Date().toISOString(),
      }
      await durableWriteText(state.paths.setupManifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
      return true
    }
    case 'upsert-plugin-patch': {
      const latest = await readTextSnapshot(state.paths.patchFile)
      assertHash('DeepSeek Harness patch', latest.hash, row.details?.expectedHash, state.paths.patchFile)
      if (row.details?.blockHash !== state.desiredBlockHash) {
        throw new Error('DeepSeek Harness plugin patch changed after planning; rerun --dry-run')
      }
      const raw = latest.content ?? ''
      const current = extractDshManagedBlock(raw)
      if (current) {
        if (!state.manifest || current.hash !== state.manifest.blockHash) {
          throw new Error('DeepSeek Harness plugin patch ownership changed while setup was running')
        }
      } else if (hasForeignDshFlowitEntry(raw)) {
        throw new Error('An unmanaged Flowit DSH plugin entry appeared after planning; refusing to duplicate it')
      }
      await durableWriteText(state.paths.patchFile, upsertDshManagedBlock(raw, state.desiredBlock))
      return true
    }
    case 'remove-plugin-patch': {
      const latest = await readTextSnapshot(state.paths.patchFile)
      assertHash('DeepSeek Harness patch', latest.hash, row.details?.expectedHash, state.paths.patchFile)
      if (!latest.exists || !state.manifest) return false
      const current = extractDshManagedBlock(latest.content ?? '')
      if (!current || current.hash !== state.manifest.blockHash) return false
      const next = removeDshManagedBlock(latest.content ?? '')
      await durableWriteText(state.paths.patchFile, next)
      return true
    }
    case 'remove-manifest': {
      const latest = await readTextSnapshot(state.paths.setupManifestFile)
      assertHash('DeepSeek Harness setup manifest', latest.hash, row.details?.expectedHash, state.paths.setupManifestFile)
      if (!latest.exists) return false
      await rm(state.paths.setupManifestFile, { force: true })
      return true
    }
    default:
      throw new Error(`DeepSeek Harness setup plan contains unknown action ${row.id}`)
  }
}

function manifestAction(
  state: DshState,
  patchExistedBefore: boolean,
  seed: boolean,
): SetupPlan['actions'][number] {
  return action(
    'write-manifest',
    'write-manifest',
    seed
      ? 'Seed DeepSeek Harness patch ownership before writing the native plugin entry'
      : 'Update DeepSeek Harness patch ownership after the native plugin entry changes',
    'filesystem',
    true,
    true,
    state.paths.setupManifestFile,
    {
      expectedHash: state.manifestSnapshot.hash,
      blockHash: state.desiredBlockHash,
      patchExistedBefore,
      storageFile: state.paths.storageFile,
    },
  )
}

function preflightOwnership(plan: SetupPlan, state: DshState): void {
  const ids = new Set(plan.actions.map(row => row.id))
  if (ids.has('remove-plugin-patch')) {
    if (!state.manifest || !state.managedBlock || state.managedBlock.hash !== state.manifest.blockHash) {
      throw new Error('DeepSeek Harness patch ownership changed after uninstall planning; refusing to remove it')
    }
  }
}

function assertPlannedSnapshots(plan: SetupPlan, state: DshState): void {
  for (const row of plan.actions) {
    const expected = row.details?.expectedHash
    if (expected !== null && typeof expected !== 'string') continue
    const actual = row.id === 'upsert-plugin-patch' || row.id === 'remove-plugin-patch'
      ? state.patch.hash
      : row.id === 'write-manifest' || row.id === 'remove-manifest'
        ? state.manifestSnapshot.hash
        : undefined
    if (actual !== undefined && actual !== expected) {
      throw new Error(`DeepSeek Harness ${row.id} target changed after planning; rerun --dry-run before applying changes`)
    }
  }
}

function assertPlan(
  plan: SetupPlan,
  operation: SetupOperation,
  options: SetupRequestOptions,
): void {
  if (
    plan.hostId !== DSH_SETUP_HOST_ID
    || plan.operation !== operation
    || plan.scope !== options.scope
  ) throw new Error('DeepSeek Harness setup plan does not match the requested operation/scope')
  const allowed = new Set(['write-manifest', 'upsert-plugin-patch', 'remove-plugin-patch', 'remove-manifest'])
  for (const row of plan.actions) {
    if (!allowed.has(row.id)) throw new Error(`unsupported DeepSeek Harness setup action ${row.id}`)
  }
}

function assertHash(
  label: string,
  actual: string | null,
  expected: unknown,
  file: string,
): void {
  if (expected !== null && typeof expected !== 'string') {
    throw new Error(`${label} plan snapshot is invalid for ${file}`)
  }
  if (actual !== expected) throw new Error(`${label} changed while setup was running: ${file}`)
}

function action(
  id: string,
  kind: string,
  description: string,
  risk: SetupPlan['actions'][number]['risk'],
  requiresConfirmation: boolean,
  reversible: boolean,
  target?: string,
  details?: Readonly<Record<string, unknown>>,
): SetupPlan['actions'][number] {
  return {
    id,
    kind,
    description,
    risk,
    requiresConfirmation,
    reversible,
    ...(target ? { target } : {}),
    ...(details ? { details } : {}),
  }
}
