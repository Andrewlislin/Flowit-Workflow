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
  readTextSnapshot,
  removeEmptyParents,
} from './workbuddy-files.js'
import {
  CLAUDE_CODE_MANAGED_FILES,
  CLAUDE_CODE_PLUGIN_NAME,
  CLAUDE_CODE_SETUP_DISPLAY_NAME,
  CLAUDE_CODE_SETUP_HOST_ID,
  CLAUDE_CODE_SETUP_MANIFEST_VERSION,
  actionIdFor,
  claudeCodeDoctorChecks,
  claudeCodeManualSteps,
  desiredOwnedFilesAfterPlan,
  detectClaudeCode,
  ensureClaudeStateRoot,
  inspectClaudeCodeState,
  type ClaudeCodeManagedFile,
  type ClaudeCodeSetupManifest,
  type ClaudeCodeState,
} from './claude-code-state.js'

export class ClaudeCodeSetupProvider implements HostSetupProvider {
  readonly id = CLAUDE_CODE_SETUP_HOST_ID
  readonly displayName = CLAUDE_CODE_SETUP_DISPLAY_NAME

  async detect(context: HostSetupContext): Promise<HostDetection> {
    const detected = await detectClaudeCode(context)
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: detected ? 'detected' : 'not-detected',
      details: {
        userPluginRoot: path.join(context.homeDir, '.claude', 'skills', CLAUDE_CODE_PLUGIN_NAME),
        projectPluginRoot: path.join(context.cwd, '.claude', 'skills', CLAUDE_CODE_PLUGIN_NAME),
      },
      ...(detected ? {} : {
        message: 'Claude Code was not detected on PATH or in its standard configuration directories; explicit setup can still stage the plugin.',
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
      const state = await inspectClaudeCodeState(context, options)
      const checks = claudeCodeDoctorChecks(options, state)
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
          id: 'claude-code-state',
          status: 'error',
          summary: 'Claude Code setup state could not be inspected',
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
    const state = await inspectClaudeCodeState(context, options)
    const actions: SetupPlan['actions'][number][] = []
    const warnings = [...state.conflicts]

    for (const file of state.files) {
      if (!file.ownedHash) continue
      if (!file.current.exists) continue
      if (file.current.hash !== file.ownedHash) {
        warnings.push(
          `Installer-owned Claude plugin file ${file.file} was modified after setup; uninstall will preserve it.`,
        )
        continue
      }
      actions.push(action(
        `remove:${file.relativePath}`,
        'remove-file',
        `Remove installer-owned Claude plugin file ${file.relativePath}`,
        'destructive',
        true,
        false,
        file.file,
        { expectedHash: file.current.hash },
      ))
    }
    if (state.manifest) {
      actions.push(action(
        'remove-manifest',
        'remove-file',
        'Remove the Claude Code setup ownership manifest',
        'destructive',
        true,
        false,
        state.paths.setupManifestFile,
      ))
    }
    warnings.push(`Claude event/session state under ${state.paths.stateRoot} is retained.`)
    return {
      version: 1,
      operation: 'uninstall',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: actions.length === 0
        ? 'No installer-owned Claude Code plugin files can be removed automatically.'
        : 'Remove only Claude Code plugin files still provably owned by Flowit setup.',
      actions,
      warnings,
      manualSteps: ['Restart Claude Code or run `/reload-plugins` after uninstall.'],
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
    const state = await inspectClaudeCodeState(context, options)
    const warnings = [...state.conflicts]
    if (state.conflicts.length > 0) {
      return {
        version: 1,
        operation,
        hostId: this.id,
        displayName: this.displayName,
        scope: options.scope,
        summary: 'Claude Code setup is blocked because the target plugin root cannot be proven installer-owned.',
        actions: [],
        warnings,
        manualSteps: [
          `Resolve or move the existing plugin root at ${state.paths.pluginRoot}, then rerun \`flowit-workflow setup claude-code --dry-run\`.`,
        ],
      }
    }

    const fileActions: SetupPlan['actions'][number][] = []
    for (const file of state.files) {
      if (file.current.hash === file.desiredHash) continue
      fileActions.push(action(
        actionIdFor(file.relativePath),
        'write-file',
        `Install/update Claude Code plugin file ${file.relativePath}`,
        file.relativePath === '.mcp.json' || file.relativePath === 'hooks/hooks.json'
          ? 'configuration'
          : 'filesystem',
        true,
        true,
        file.file,
        { expectedHash: file.current.hash },
      ))
    }

    const actions: SetupPlan['actions'][number][] = []
    const needsManifest = needsManifestWrite(state, fileActions)
    // Seed ownership before a first install. If the process crashes after this point,
    // repair can safely finish missing files instead of treating a partial plugin as foreign.
    if (!state.manifest && needsManifest) actions.push(manifestAction(state, true))
    actions.push(...fileActions)
    if (!state.stateRootExists) {
      actions.push(action(
        'ensure-state-root',
        'ensure-directory',
        'Create the durable Claude event/session state directory',
        'filesystem',
        true,
        true,
        state.paths.stateRoot,
      ))
    }
    if (state.manifest && needsManifest) actions.push(manifestAction(state, false))

    if (options.scope === 'project' && !path.resolve(context.packageRoot).startsWith(`${path.resolve(options.projectDir)}${path.sep}`)) {
      warnings.push(
        'This project-scope plugin references the current Flowit installation path. For a team-portable project install, install Flowit inside the project or use the future marketplace/npm distribution path before committing the generated plugin files.',
      )
    }

    return {
      version: 1,
      operation,
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: operation === 'setup'
        ? 'Install Flowit as a Claude Code skills-directory plugin with Skills, lifecycle Hooks, and MCP orchestration tools.'
        : 'Repair installer-owned Claude Code plugin files without overwriting user-modified or foreign plugin content.',
      actions,
      warnings,
      manualSteps: claudeCodeManualSteps(options, state),
    }
  }

  private async applyPlan(
    operation: SetupOperation,
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult> {
    assertPlan(plan, operation, options)
    const state = await inspectClaudeCodeState(context, options)
    assertPlannedSnapshots(plan, state)
    preflightOwnership(plan, state)

    const applied: string[] = []
    const skipped: string[] = []
    for (const row of plan.actions) {
      const changed = await applyAction(row.id, context, options, state, plan)
      ;(changed ? applied : skipped).push(row.id)
    }

    if (operation === 'uninstall') {
      await removeEmptyParents(
        state.paths.pluginRoot,
        options.scope === 'user'
          ? path.join(context.homeDir, '.claude', 'skills')
          : path.join(path.resolve(options.projectDir), '.claude', 'skills'),
      )
      const partial = skipped.length > 0
        || plan.warnings.some(warning => !warning.startsWith('Claude event/session state under '))
      return {
        operation,
        hostId: this.id,
        displayName: this.displayName,
        status: partial ? 'partial' : 'complete',
        appliedActions: applied,
        skippedActions: skipped,
        warnings: plan.warnings,
        manualSteps: plan.manualSteps,
      }
    }

    const doctor = await this.doctor(context, options)
    const manualRequired = !state.claudeExecutable || options.scope === 'project'
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
  id: string,
  context: HostSetupContext,
  options: SetupRequestOptions,
  state: ClaudeCodeState,
  plan: SetupPlan,
): Promise<boolean> {
  if (id.startsWith('write:')) {
    const relative = id.slice('write:'.length) as ClaudeCodeManagedFile
    const file = state.files.find(row => row.relativePath === relative)
    if (!file) throw new Error(`Claude setup plan references unknown file ${relative}`)
    const latest = await readTextSnapshot(file.file)
    if (latest.hash !== file.current.hash) {
      throw new Error(`Claude plugin file changed while setup was running: ${file.file}`)
    }
    if (latest.exists && file.ownedHash && latest.hash !== file.ownedHash) {
      throw new Error(`Claude plugin file ownership changed while setup was running: ${file.file}`)
    }
    await durableWriteText(file.file, file.desiredContent)
    return true
  }
  if (id.startsWith('remove:')) {
    const relative = id.slice('remove:'.length) as ClaudeCodeManagedFile
    const file = state.files.find(row => row.relativePath === relative)
    if (!file?.ownedHash) return false
    const latest = await readTextSnapshot(file.file)
    if (!latest.exists || latest.hash !== file.ownedHash) return false
    await rm(file.file, { force: true })
    return true
  }
  switch (id) {
    case 'ensure-state-root':
      await ensureClaudeStateRoot(state.paths.stateRoot)
      return true
    case 'write-manifest':
      await writeManifest(context, options, state, plan)
      return true
    case 'remove-manifest':
      await rm(state.paths.setupManifestFile, { force: true })
      return true
    default:
      throw new Error(`Claude Code setup plan contains unknown action ${id}`)
  }
}

async function writeManifest(
  _context: HostSetupContext,
  options: SetupRequestOptions,
  state: ClaudeCodeState,
  plan: SetupPlan,
): Promise<void> {
  const actionIds = new Set(plan.actions.map(row => row.id))
  const manifest: ClaudeCodeSetupManifest = {
    version: CLAUDE_CODE_SETUP_MANIFEST_VERSION,
    hostId: CLAUDE_CODE_SETUP_HOST_ID,
    scope: options.scope,
    projectDir: path.resolve(options.projectDir),
    pluginRoot: state.paths.pluginRoot,
    ownedFiles: desiredOwnedFilesAfterPlan(state, actionIds),
    installedAt: state.manifest?.installedAt ?? new Date().toISOString(),
  }
  await durableWriteText(state.paths.setupManifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
}

function needsManifestWrite(
  state: ClaudeCodeState,
  fileActions: readonly SetupPlan['actions'][number][],
): boolean {
  if (!state.manifest) return fileActions.length > 0 || !state.stateRootExists
  if (state.manifest.pluginRoot !== state.paths.pluginRoot) return true
  for (const file of state.files) {
    const willWrite = fileActions.some(action => action.id === actionIdFor(file.relativePath))
    if (willWrite && state.manifest.ownedFiles[file.relativePath] !== file.desiredHash) return true
    if (file.ownedHash && file.ownedHash !== file.desiredHash) return true
  }
  return false
}

function manifestAction(state: ClaudeCodeState, seed: boolean): SetupPlan['actions'][number] {
  return action(
    'write-manifest',
    'write-manifest',
    seed
      ? 'Seed Claude Code plugin ownership before creating managed plugin files'
      : 'Update Claude Code plugin ownership after managed file updates',
    'filesystem',
    true,
    true,
    state.paths.setupManifestFile,
  )
}

function preflightOwnership(plan: SetupPlan, state: ClaudeCodeState): void {
  if (plan.operation !== 'uninstall' && state.conflicts.length > 0 && plan.actions.length > 0) {
    throw new Error('Claude Code plugin ownership changed after planning; refusing to modify it')
  }
  for (const row of plan.actions) {
    if (!row.id.startsWith('write:') && !row.id.startsWith('remove:')) continue
    const relative = row.id.slice(row.id.indexOf(':') + 1) as ClaudeCodeManagedFile
    const file = state.files.find(candidate => candidate.relativePath === relative)
    if (!file) throw new Error(`Claude setup plan references unknown file ${relative}`)
    if (row.id.startsWith('remove:') && (!file.ownedHash || file.current.hash !== file.ownedHash)) {
      throw new Error(`Claude plugin ownership changed after uninstall planning: ${file.file}`)
    }
  }
}

function assertPlannedSnapshots(plan: SetupPlan, state: ClaudeCodeState): void {
  for (const row of plan.actions) {
    if (!row.id.startsWith('write:') && !row.id.startsWith('remove:')) continue
    const expected = row.details?.expectedHash
    if (expected !== null && typeof expected !== 'string') continue
    const relative = row.id.slice(row.id.indexOf(':') + 1) as ClaudeCodeManagedFile
    const file = state.files.find(candidate => candidate.relativePath === relative)
    if (file && file.current.hash !== expected) {
      throw new Error(
        `Claude Code ${relative} changed after planning; rerun --dry-run before applying changes`,
      )
    }
  }
}

function assertPlan(
  plan: SetupPlan,
  operation: SetupOperation,
  options: SetupRequestOptions,
): void {
  if (
    plan.hostId !== CLAUDE_CODE_SETUP_HOST_ID
    || plan.operation !== operation
    || plan.scope !== options.scope
  ) throw new Error('Claude Code setup plan does not match the requested operation/scope')
  const allowed = new Set([
    ...CLAUDE_CODE_MANAGED_FILES.map(file => `write:${file}`),
    ...CLAUDE_CODE_MANAGED_FILES.map(file => `remove:${file}`),
    'ensure-state-root', 'write-manifest', 'remove-manifest',
  ])
  for (const row of plan.actions) {
    if (!allowed.has(row.id)) throw new Error(`unsupported Claude Code setup action ${row.id}`)
  }
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
