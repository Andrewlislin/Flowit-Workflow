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
  CODEX_SETUP_DISPLAY_NAME,
  CODEX_SETUP_HOST_ID,
  CODEX_SETUP_MANIFEST_VERSION,
  codexDoctorChecks,
  codexManualSteps,
  codexSetupPaths,
  detectCodex,
  extractCodexManagedBlock,
  hasForeignCodexMcpTable,
  inspectCodexState,
  removeCodexManagedBlock,
  upsertCodexManagedBlock,
  type CodexSetupManifest,
  type CodexState,
} from './codex-state.js'

export class CodexSetupProvider implements HostSetupProvider {
  readonly id = CODEX_SETUP_HOST_ID
  readonly displayName = CODEX_SETUP_DISPLAY_NAME

  async detect(context: HostSetupContext): Promise<HostDetection> {
    const detected = await detectCodex(context)
    const userPaths = codexSetupPaths(context, { scope: 'user', projectDir: context.cwd })
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: detected ? 'detected' : 'not-detected',
      details: {
        codexHome: userPaths.codexHome,
        userConfig: userPaths.configFile,
        projectConfig: path.join(context.cwd, '.codex', 'config.toml'),
      },
      ...(detected ? {} : {
        message: 'Codex was not detected on PATH or in its config directories; explicit setup can still stage the MCP configuration.',
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
      const state = await inspectCodexState(context, options)
      const checks = codexDoctorChecks(options, state)
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
          id: 'codex-state',
          status: 'error',
          summary: 'Codex setup state could not be inspected',
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
    const state = await inspectCodexState(context, options)
    const actions: SetupPlan['actions'][number][] = []
    const warnings = [...state.conflicts]

    if (state.managedBlock) {
      if (state.manifest && state.managedBlock.hash === state.manifest.blockHash) {
        actions.push(action(
          'remove-mcp-block',
          'edit-toml',
          'Remove the installer-owned Flowit MCP block from Codex config',
          'configuration',
          true,
          true,
          state.paths.configFile,
          { expectedHash: state.config.hash },
        ))
      } else {
        warnings.push('The Flowit Codex MCP block cannot be proven installer-owned and will be preserved.')
      }
    }
    if (state.manifest) {
      actions.push(action(
        'remove-manifest',
        'remove-file',
        'Remove the Codex setup ownership manifest',
        'destructive',
        true,
        false,
        state.paths.setupManifestFile,
        { expectedHash: state.manifestSnapshot.hash },
      ))
    }

    return {
      version: 1,
      operation: 'uninstall',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: actions.length === 0
        ? 'No installer-owned Codex configuration can be removed automatically.'
        : 'Remove only the Flowit Codex MCP block still provably owned by setup.',
      actions,
      warnings,
      manualSteps: ['Restart Codex or start a new thread after uninstall so MCP configuration is reloaded.'],
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
    const state = await inspectCodexState(context, options)
    const warnings = [...state.conflicts]
    if (state.conflicts.length > 0) {
      return {
        version: 1,
        operation,
        hostId: this.id,
        displayName: this.displayName,
        scope: options.scope,
        summary: 'Codex setup is blocked because the target MCP table cannot be proven installer-owned.',
        actions: [],
        warnings,
        manualSteps: [
          `Resolve the reported Codex config conflict in ${state.paths.configFile}, then rerun \`flowit-workflow setup codex --dry-run\`.`,
          ...codexManualSteps(options, state),
        ],
      }
    }

    const actions: SetupPlan['actions'][number][] = []
    const blockNeedsWrite = state.managedBlock?.hash !== state.desiredBlockHash
    const configExistedBefore = state.manifest?.configExistedBefore ?? state.config.exists
    const manifestNeedsWrite = !state.manifest || state.manifest.blockHash !== state.desiredBlockHash

    if (!state.manifest && blockNeedsWrite) {
      actions.push(manifestAction(state, configExistedBefore, true))
    }
    if (blockNeedsWrite) {
      actions.push(action(
        'upsert-mcp-block',
        'edit-toml',
        'Install/update the Flowit MCP server block in Codex config',
        'configuration',
        true,
        true,
        state.paths.configFile,
        { expectedHash: state.config.hash, blockHash: state.desiredBlockHash },
      ))
    }
    if (state.manifest && manifestNeedsWrite) {
      actions.push(manifestAction(state, configExistedBefore, false))
    }

    if (
      options.scope === 'project'
      && !path.resolve(context.packageRoot).startsWith(`${path.resolve(options.projectDir)}${path.sep}`)
    ) {
      warnings.push(
        'This project-scope MCP block references the current Flowit installation path. For a team-portable project config, install Flowit inside the project or use the future published-package setup path before committing `.codex/config.toml`.',
      )
    }

    return {
      version: 1,
      operation,
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: operation === 'setup'
        ? 'Configure Flowit as a Codex stdio MCP server while preserving the rest of config.toml byte-for-byte.'
        : 'Repair only the installer-owned Flowit MCP block in Codex config.',
      actions,
      warnings,
      manualSteps: codexManualSteps(options, state),
    }
  }

  private async applyPlan(
    operation: SetupOperation,
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult> {
    assertPlan(plan, operation, options)
    const state = await inspectCodexState(context, options)
    if (operation !== 'uninstall' && state.conflicts.length > 0 && plan.actions.length > 0) {
      throw new Error('Codex MCP ownership changed after planning; refusing to modify it')
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
      return {
        operation,
        hostId: this.id,
        displayName: this.displayName,
        status: skipped.length > 0 || plan.warnings.length > 0 ? 'partial' : 'complete',
        appliedActions: applied,
        skippedActions: skipped,
        warnings: plan.warnings,
        manualSteps: plan.manualSteps,
      }
    }

    const doctor = await this.doctor(context, options)
    const manualRequired = !state.codexExecutable || options.scope === 'project'
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
      manualSteps: plan.manualSteps,
      doctor,
    }
  }
}

async function applyAction(
  row: SetupPlan['actions'][number],
  options: SetupRequestOptions,
  state: CodexState,
): Promise<boolean> {
  switch (row.id) {
    case 'write-manifest': {
      const latest = await readTextSnapshot(state.paths.setupManifestFile)
      assertHash('Codex setup manifest', latest.hash, row.details?.expectedHash, state.paths.setupManifestFile)
      const blockHash = row.details?.blockHash
      const configExistedBefore = row.details?.configExistedBefore
      if (typeof blockHash !== 'string' || typeof configExistedBefore !== 'boolean') {
        throw new Error('Codex setup manifest action is missing ownership metadata')
      }
      const manifest: CodexSetupManifest = {
        version: CODEX_SETUP_MANIFEST_VERSION,
        hostId: CODEX_SETUP_HOST_ID,
        scope: options.scope,
        projectDir: path.resolve(options.projectDir),
        configFile: state.paths.configFile,
        blockHash,
        configExistedBefore,
        installedAt: state.manifest?.installedAt ?? new Date().toISOString(),
      }
      await durableWriteText(state.paths.setupManifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
      return true
    }
    case 'upsert-mcp-block': {
      const latest = await readTextSnapshot(state.paths.configFile)
      assertHash('Codex config', latest.hash, row.details?.expectedHash, state.paths.configFile)
      const desiredHash = row.details?.blockHash
      if (desiredHash !== state.desiredBlockHash) {
        throw new Error('Codex setup block changed after planning; rerun --dry-run')
      }
      const raw = latest.content ?? ''
      const current = extractCodexManagedBlock(raw)
      if (current) {
        if (!state.manifest || current.hash !== state.manifest.blockHash) {
          throw new Error('Codex MCP block ownership changed while setup was running')
        }
      } else if (hasForeignCodexMcpTable(raw)) {
        throw new Error('Codex flowit-workflow MCP table appeared after planning; refusing to overwrite it')
      }
      await durableWriteText(state.paths.configFile, upsertCodexManagedBlock(raw, state.desiredBlock))
      return true
    }
    case 'remove-mcp-block': {
      const latest = await readTextSnapshot(state.paths.configFile)
      assertHash('Codex config', latest.hash, row.details?.expectedHash, state.paths.configFile)
      const raw = latest.content ?? ''
      const current = extractCodexManagedBlock(raw)
      if (!current || !state.manifest || current.hash !== state.manifest.blockHash) return false
      const next = removeCodexManagedBlock(raw)
      if (!next && !state.manifest.configExistedBefore) await rm(state.paths.configFile, { force: true })
      else await durableWriteText(state.paths.configFile, next)
      return true
    }
    case 'remove-manifest': {
      const latest = await readTextSnapshot(state.paths.setupManifestFile)
      assertHash('Codex setup manifest', latest.hash, row.details?.expectedHash, state.paths.setupManifestFile)
      if (!latest.exists) return false
      await rm(state.paths.setupManifestFile, { force: true })
      return true
    }
    default:
      throw new Error(`Codex setup plan contains unknown action ${row.id}`)
  }
}

function manifestAction(
  state: CodexState,
  configExistedBefore: boolean,
  seed: boolean,
): SetupPlan['actions'][number] {
  return action(
    'write-manifest',
    'write-manifest',
    seed
      ? 'Seed Codex MCP ownership before writing the managed TOML block'
      : 'Update Codex MCP ownership after the managed block changes',
    'filesystem',
    true,
    true,
    state.paths.setupManifestFile,
    {
      expectedHash: state.manifestSnapshot.hash,
      blockHash: state.desiredBlockHash,
      configExistedBefore,
    },
  )
}

function preflightOwnership(plan: SetupPlan, state: CodexState): void {
  const ids = new Set(plan.actions.map(row => row.id))
  if (ids.has('remove-mcp-block')) {
    if (!state.manifest || !state.managedBlock || state.managedBlock.hash !== state.manifest.blockHash) {
      throw new Error('Codex MCP ownership changed after uninstall planning; refusing to remove it')
    }
  }
}

function assertPlannedSnapshots(plan: SetupPlan, state: CodexState): void {
  for (const row of plan.actions) {
    const expected = row.details?.expectedHash
    if (expected !== null && typeof expected !== 'string') continue
    const actual = row.id === 'upsert-mcp-block' || row.id === 'remove-mcp-block'
      ? state.config.hash
      : row.id === 'write-manifest' || row.id === 'remove-manifest'
        ? state.manifestSnapshot.hash
        : undefined
    if (actual !== undefined && actual !== expected) {
      throw new Error(`Codex ${row.id} target changed after planning; rerun --dry-run before applying changes`)
    }
  }
}

function assertPlan(
  plan: SetupPlan,
  operation: SetupOperation,
  options: SetupRequestOptions,
): void {
  if (
    plan.hostId !== CODEX_SETUP_HOST_ID
    || plan.operation !== operation
    || plan.scope !== options.scope
  ) throw new Error('Codex setup plan does not match the requested operation/scope')
  const allowed = new Set(['write-manifest', 'upsert-mcp-block', 'remove-mcp-block', 'remove-manifest'])
  for (const row of plan.actions) {
    if (!allowed.has(row.id)) throw new Error(`unsupported Codex setup action ${row.id}`)
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
