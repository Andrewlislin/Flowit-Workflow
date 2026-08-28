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
import {
  durableWriteText,
  ensureBridgeDirectories,
  readTextSnapshot,
} from './workbuddy-files.js'
import {
  DOUBAO_OFFICE_SETUP_DISPLAY_NAME,
  DOUBAO_OFFICE_SETUP_HOST_ID,
  DOUBAO_OFFICE_SETUP_MANIFEST_VERSION,
  desiredDoubaoOwnership,
  detectDoubaoOffice,
  doubaoOfficeDoctorChecks,
  doubaoOfficeManualSteps,
  doubaoOfficeSetupPaths,
  inspectDoubaoOfficeState,
  type DoubaoOfficeSetupManifest,
  type DoubaoOfficeState,
} from './doubao-office-state.js'

export class DoubaoOfficeSetupProvider implements HostSetupProvider {
  readonly id = DOUBAO_OFFICE_SETUP_HOST_ID
  readonly displayName = DOUBAO_OFFICE_SETUP_DISPLAY_NAME

  async detect(context: HostSetupContext): Promise<HostDetection> {
    const detected = await detectDoubaoOffice(context)
    const paths = doubaoOfficeSetupPaths(context, { scope: 'user', projectDir: context.cwd })
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: detected ? 'detected' : 'not-detected',
      details: {
        bridgeRoot: paths.bridgeRoot,
        stagedSkill: paths.stagedSkillFile,
        ...(paths.managedSkillFile ? { managedSkill: paths.managedSkillFile } : {}),
      },
      message: detected
        ? 'Flowit 豆包办公 bridge state or an explicit managed Skill target was detected.'
        : '豆包办公 has no public stable discovery API; explicit setup can still prepare all Flowit-side Bridge assets.',
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
      const state = await inspectDoubaoOfficeState(context, options)
      const checks = doubaoOfficeDoctorChecks(state)
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
          id: 'doubao-office-state',
          status: 'error',
          summary: '豆包办公 setup state could not be inspected',
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
    const state = await inspectDoubaoOfficeState(context, options)
    const actions: SetupPlan['actions'][number][] = []
    const warnings = [...state.conflicts]

    if (state.manifest?.ownedStagedSkillHash && state.stagedSkill.exists) {
      if (state.stagedSkill.hash === state.manifest.ownedStagedSkillHash) {
        actions.push(action(
          'remove-staged-skill',
          'remove-file',
          'Remove the installer-owned staged 豆包办公 Bridge Worker Skill',
          'destructive',
          true,
          false,
          state.paths.stagedSkillFile,
          { expectedHash: state.stagedSkill.hash },
        ))
      } else {
        warnings.push(`The staged Bridge Worker Skill was modified after setup and will be preserved: ${state.paths.stagedSkillFile}`)
      }
    }

    if (
      state.paths.managedSkillFile
      && state.manifest?.ownedManagedSkillHash
      && state.managedSkill?.exists
    ) {
      if (state.managedSkill.hash === state.manifest.ownedManagedSkillHash) {
        actions.push(action(
          'remove-managed-skill',
          'remove-file',
          'Remove the installer-owned managed 豆包办公 Bridge Worker Skill',
          'destructive',
          true,
          false,
          state.paths.managedSkillFile,
          { expectedHash: state.managedSkill.hash },
        ))
      } else {
        warnings.push(`The managed 豆包办公 Bridge Worker Skill was modified after setup and will be preserved: ${state.paths.managedSkillFile}`)
      }
    }

    if (state.manifest) {
      actions.push(action(
        'remove-manifest',
        'remove-file',
        'Remove the 豆包办公 setup ownership manifest',
        'destructive',
        true,
        false,
        state.paths.setupManifestFile,
        { expectedHash: state.manifestSnapshot.hash },
      ))
    }

    warnings.push(`Bridge transport state/history under ${state.paths.bridgeRoot} is retained.`)
    return {
      version: 1,
      operation: 'uninstall',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: actions.length === 0
        ? 'No installer-owned 豆包办公 Skill files can be removed automatically.'
        : 'Remove only 豆包办公 Skill files still provably owned by Flowit setup.',
      actions,
      warnings,
      manualSteps: [
        'Disable/remove the Flowit Bridge Worker Skill inside 豆包办公 if it was imported through the host UI.',
        'Disable the 豆包办公 native scheduled task that invokes the Bridge Worker.',
      ],
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
    const state = await inspectDoubaoOfficeState(context, options)
    const warnings = [...state.conflicts]
    if (state.conflicts.length > 0) {
      return {
        version: 1,
        operation,
        hostId: this.id,
        displayName: this.displayName,
        scope: options.scope,
        summary: '豆包办公 setup is blocked because an existing Skill asset cannot be proven safe to manage.',
        actions: [],
        warnings,
        manualSteps: [
          'Resolve the reported Skill/ownership conflict, then rerun `flowit-workflow setup doubao-office --dry-run`.',
          ...doubaoOfficeManualSteps(state),
        ],
      }
    }

    const stageNeedsWrite = needsOwnedWrite(
      state.stagedSkill.hash,
      state.desiredSkillHash,
      state.manifest?.ownedStagedSkillHash,
    )
    const managedNeedsWrite = Boolean(
      state.paths.managedSkillFile
      && state.managedSkill
      && needsOwnedWrite(
        state.managedSkill.hash,
        state.desiredSkillHash,
        state.manifest?.ownedManagedSkillHash,
      ),
    )
    const bridgeNeedsWrite = state.missingBridgeDirs.length > 0
    const ownership = desiredDoubaoOwnership(state, stageNeedsWrite, managedNeedsWrite)
    const manifestNeedsWrite = !state.manifest
      || state.manifest.ownedStagedSkillHash !== ownership.ownedStagedSkillHash
      || state.manifest.ownedManagedSkillHash !== ownership.ownedManagedSkillHash

    const actions: SetupPlan['actions'][number][] = []
    if (!state.manifest && (stageNeedsWrite || managedNeedsWrite || bridgeNeedsWrite)) {
      actions.push(manifestAction(state, ownership))
    }
    if (stageNeedsWrite) {
      actions.push(action(
        'write-staged-skill',
        'write-file',
        'Stage the Flowit Bridge Worker Skill for 豆包办公 import/activation',
        'filesystem',
        true,
        true,
        state.paths.stagedSkillFile,
        { expectedHash: state.stagedSkill.hash },
      ))
    }
    if (managedNeedsWrite && state.paths.managedSkillFile && state.managedSkill) {
      actions.push(action(
        'write-managed-skill',
        'write-file',
        'Deploy the Flowit Bridge Worker Skill to the explicitly configured 豆包办公 managed Skill directory',
        'configuration',
        true,
        true,
        state.paths.managedSkillFile,
        { expectedHash: state.managedSkill.hash },
      ))
    }
    if (bridgeNeedsWrite) {
      actions.push(action(
        'ensure-bridge-directories',
        'ensure-directory',
        'Create the durable 豆包办公 Bridge transport directories',
        'filesystem',
        true,
        true,
        state.paths.bridgeRoot,
      ))
    }
    if (state.manifest && manifestNeedsWrite) actions.push(manifestAction(state, ownership))

    if (state.paths.managedSkillFile) {
      warnings.push(
        'FLOWIT_WORKFLOW_DOUBAO_SKILL_DIR is treated as an explicit deployment-owned target; Flowit does not infer private 豆包办公 application directories.',
      )
    }

    return {
      version: 1,
      operation,
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: operation === 'setup'
        ? 'Prepare the 豆包办公 Bridge Worker, durable transport directories, and optional explicitly managed Skill deployment.'
        : 'Repair only installer-owned 豆包办公 Bridge assets.',
      actions,
      warnings,
      manualSteps: doubaoOfficeManualSteps(state),
    }
  }

  private async applyPlan(
    operation: SetupOperation,
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult> {
    assertPlan(plan, operation, options)
    const state = await inspectDoubaoOfficeState(context, options)
    if (operation !== 'uninstall' && state.conflicts.length > 0 && plan.actions.length > 0) {
      throw new Error('豆包办公 setup ownership changed after planning; refusing to modify it')
    }
    assertSnapshots(plan, state)
    preflightOwnership(plan, state)

    const applied: string[] = []
    const skipped: string[] = []
    for (const row of plan.actions) {
      const changed = await applyAction(row, options, state)
      ;(changed ? applied : skipped).push(row.id)
    }

    if (operation === 'uninstall') {
      const meaningfulWarnings = plan.warnings.filter(
        warning => !warning.startsWith('Bridge transport state/history under '),
      )
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

    const fresh = await inspectDoubaoOfficeState(context, options)
    const doctor = await this.doctor(context, options)
    return {
      operation,
      hostId: this.id,
      displayName: this.displayName,
      status: doctor.status === 'unhealthy' ? 'failed' : 'manual-action-required',
      appliedActions: applied,
      skippedActions: skipped,
      warnings: plan.warnings,
      manualSteps: doubaoOfficeManualSteps(fresh),
      doctor,
    }
  }
}

async function applyAction(
  row: SetupPlan['actions'][number],
  options: SetupRequestOptions,
  state: DoubaoOfficeState,
): Promise<boolean> {
  switch (row.id) {
    case 'write-manifest': {
      const latest = await readTextSnapshot(state.paths.setupManifestFile)
      assertHash('豆包办公 setup manifest', latest.hash, row.details?.expectedHash, state.paths.setupManifestFile)
      const ownedStagedSkillHash = nullableString(row.details?.ownedStagedSkillHash)
      const ownedManagedSkillHash = nullableString(row.details?.ownedManagedSkillHash)
      const manifest: DoubaoOfficeSetupManifest = {
        version: DOUBAO_OFFICE_SETUP_MANIFEST_VERSION,
        hostId: DOUBAO_OFFICE_SETUP_HOST_ID,
        scope: options.scope,
        projectDir: path.resolve(options.projectDir),
        bridgeRoot: state.paths.bridgeRoot,
        stagedSkillFile: state.paths.stagedSkillFile,
        ...(ownedStagedSkillHash ? { ownedStagedSkillHash } : {}),
        ...(state.paths.managedSkillFile ? { managedSkillFile: state.paths.managedSkillFile } : {}),
        ...(ownedManagedSkillHash ? { ownedManagedSkillHash } : {}),
        installedAt: state.manifest?.installedAt ?? new Date().toISOString(),
      }
      await durableWriteText(state.paths.setupManifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
      return true
    }
    case 'write-staged-skill':
      await writeSkill(
        'staged 豆包办公 Bridge Worker Skill',
        state.paths.stagedSkillFile,
        row.details?.expectedHash,
        state.manifest?.ownedStagedSkillHash,
        state,
      )
      return true
    case 'write-managed-skill':
      if (!state.paths.managedSkillFile) throw new Error('豆包办公 managed Skill target disappeared after planning')
      await writeSkill(
        'managed 豆包办公 Bridge Worker Skill',
        state.paths.managedSkillFile,
        row.details?.expectedHash,
        state.manifest?.ownedManagedSkillHash,
        state,
      )
      return true
    case 'ensure-bridge-directories':
      await ensureBridgeDirectories(state.paths.bridgeRoot)
      return true
    case 'remove-staged-skill':
      return removeOwnedSkill(
        state.paths.stagedSkillFile,
        row.details?.expectedHash,
        state.manifest?.ownedStagedSkillHash,
      )
    case 'remove-managed-skill':
      if (!state.paths.managedSkillFile) return false
      return removeOwnedSkill(
        state.paths.managedSkillFile,
        row.details?.expectedHash,
        state.manifest?.ownedManagedSkillHash,
      )
    case 'remove-manifest': {
      const latest = await readTextSnapshot(state.paths.setupManifestFile)
      assertHash('豆包办公 setup manifest', latest.hash, row.details?.expectedHash, state.paths.setupManifestFile)
      if (!latest.exists) return false
      await rm(state.paths.setupManifestFile, { force: true })
      return true
    }
    default:
      throw new Error(`豆包办公 setup plan contains unknown action ${row.id}`)
  }
}

async function writeSkill(
  label: string,
  file: string,
  expectedHash: unknown,
  ownedHash: string | undefined,
  state: DoubaoOfficeState,
): Promise<void> {
  const latest = await readTextSnapshot(file)
  assertHash(label, latest.hash, expectedHash, file)
  if (latest.exists && !ownedHash) {
    throw new Error(`${label} appeared or became unowned while setup was running: ${file}`)
  }
  if (latest.exists && ownedHash && latest.hash !== ownedHash && latest.hash !== state.desiredSkillHash) {
    throw new Error(`${label} ownership changed while setup was running: ${file}`)
  }
  await durableWriteText(file, state.sourceSkill.content ?? '')
}

async function removeOwnedSkill(
  file: string,
  expectedHash: unknown,
  ownedHash: string | undefined,
): Promise<boolean> {
  const latest = await readTextSnapshot(file)
  assertHash('豆包办公 Skill', latest.hash, expectedHash, file)
  if (!latest.exists || !ownedHash || latest.hash !== ownedHash) return false
  await rm(file, { force: true })
  return true
}

function manifestAction(
  state: DoubaoOfficeState,
  ownership: ReturnType<typeof desiredDoubaoOwnership>,
): SetupPlan['actions'][number] {
  return action(
    'write-manifest',
    'write-manifest',
    state.manifest
      ? 'Update 豆包办公 setup ownership after managed Skill changes'
      : 'Seed 豆包办公 setup ownership before creating managed Skill files',
    'filesystem',
    true,
    true,
    state.paths.setupManifestFile,
    {
      expectedHash: state.manifestSnapshot.hash,
      ownedStagedSkillHash: ownership.ownedStagedSkillHash ?? null,
      ownedManagedSkillHash: ownership.ownedManagedSkillHash ?? null,
    },
  )
}

function needsOwnedWrite(
  currentHash: string | null,
  desiredHash: string,
  ownedHash: string | undefined,
): boolean {
  if (currentHash === desiredHash) return false
  if (currentHash === null) return true
  return Boolean(ownedHash && currentHash === ownedHash)
}

function preflightOwnership(plan: SetupPlan, state: DoubaoOfficeState): void {
  const ids = new Set(plan.actions.map(row => row.id))
  if (ids.has('remove-staged-skill')) {
    if (!state.manifest?.ownedStagedSkillHash || state.stagedSkill.hash !== state.manifest.ownedStagedSkillHash) {
      throw new Error('Staged 豆包办公 Skill ownership changed after uninstall planning')
    }
  }
  if (ids.has('remove-managed-skill')) {
    if (!state.manifest?.ownedManagedSkillHash || state.managedSkill?.hash !== state.manifest.ownedManagedSkillHash) {
      throw new Error('Managed 豆包办公 Skill ownership changed after uninstall planning')
    }
  }
}

function assertSnapshots(plan: SetupPlan, state: DoubaoOfficeState): void {
  for (const row of plan.actions) {
    const expected = row.details?.expectedHash
    if (expected !== null && typeof expected !== 'string') continue
    const actual = row.id === 'write-staged-skill' || row.id === 'remove-staged-skill'
      ? state.stagedSkill.hash
      : row.id === 'write-managed-skill' || row.id === 'remove-managed-skill'
        ? state.managedSkill?.hash
        : row.id === 'write-manifest' || row.id === 'remove-manifest'
          ? state.manifestSnapshot.hash
          : undefined
    if (actual !== undefined && actual !== expected) {
      throw new Error(`豆包办公 ${row.id} target changed after planning; rerun --dry-run before applying changes`)
    }
  }
}

function assertPlan(
  plan: SetupPlan,
  operation: SetupOperation,
  options: SetupRequestOptions,
): void {
  if (
    plan.hostId !== DOUBAO_OFFICE_SETUP_HOST_ID
    || plan.operation !== operation
    || plan.scope !== options.scope
  ) throw new Error('豆包办公 setup plan does not match the requested operation/scope')
  const allowed = new Set([
    'write-manifest',
    'write-staged-skill',
    'write-managed-skill',
    'ensure-bridge-directories',
    'remove-staged-skill',
    'remove-managed-skill',
    'remove-manifest',
  ])
  for (const row of plan.actions) {
    if (!allowed.has(row.id)) throw new Error(`unsupported 豆包办公 setup action ${row.id}`)
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

function nullableString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('豆包办公 setup ownership hash must be a string or null')
  return value
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
