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
  isRecord,
  readJsonSnapshot,
  readTextSnapshot,
  removeEmptyParents,
  writeJson,
  type JsonRecord,
} from './workbuddy-files.js'
import {
  WORKBUDDY_DISPLAY_NAME,
  WORKBUDDY_HOOK_EVENTS,
  WORKBUDDY_HOST_ID,
  WORKBUDDY_MANIFEST_VERSION,
  WORKBUDDY_MCP_SERVER,
  canManageHooks,
  canManageMcpEntry,
  canManageSkill,
  deepEqual,
  detectWorkBuddy,
  getMcpEntry,
  hasDesiredHooks,
  hooksContain,
  inspectWorkBuddyState,
  requiresDesktopAutomation,
  workBuddyDoctorChecks,
  workBuddyManualSteps,
  type WorkBuddySetupManifest,
  type WorkBuddyState,
} from './workbuddy-state.js'

export class WorkBuddySetupProvider implements HostSetupProvider {
  readonly id = WORKBUDDY_HOST_ID
  readonly displayName = WORKBUDDY_DISPLAY_NAME

  async detect(context: HostSetupContext): Promise<HostDetection> {
    const detected = await detectWorkBuddy(context)
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: detected ? 'detected' : 'not-detected',
      details: {
        userMcp: path.join(context.homeDir, '.workbuddy', 'mcp.json'),
        projectMcp: path.join(context.cwd, '.workbuddy', 'mcp.json'),
        managedDriver: Boolean(context.env.FLOWIT_WORKFLOW_WORKBUDDY_DRIVER?.trim()),
      },
      ...detected
        ? {}
        : { message: 'No WorkBuddy configuration directory was found; explicit setup can create it.' },
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
      const state = await inspectWorkBuddyState(context, options)
      const checks = workBuddyDoctorChecks(context, state)
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
          id: 'workbuddy-state',
          status: 'error',
          summary: 'WorkBuddy setup state could not be inspected',
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
    const state = await inspectWorkBuddyState(context, options)
    const actions: SetupPlan['actions'][number][] = []
    const warnings = [...state.conflicts]
    if (ownsCurrentMcp(state)) {
      actions.push(action(
        'remove-mcp', 'remove-mcp-entry',
        'Remove the Flowit Workflow MCP server entry from WorkBuddy',
        'configuration', true, true, state.paths.mcpFile,
        { expectedHash: state.mcp.hash },
      ))
    } else if (getMcpEntry(state.mcp.value) !== undefined) {
      warnings.push(
        'The current WorkBuddy flowit-workflow MCP entry no longer matches the installer-owned value; uninstall will leave it unchanged.',
      )
    }
    if (ownsCurrentSkill(state)) {
      actions.push(action(
        'remove-skill', 'remove-file',
        'Remove the installer-owned Flowit Bridge Worker Skill',
        'destructive', true, false, state.paths.skillFile,
        { expectedHash: state.skill.hash },
      ))
    } else if (state.skill.exists) {
      warnings.push(
        'The installed Flowit Bridge Worker Skill was modified after setup; uninstall will leave it unchanged.',
      )
    }
    if (ownsCurrentHooks(state)) {
      actions.push(action(
        'remove-hooks', 'remove-hooks',
        'Remove installer-owned WorkBuddy lifecycle Hooks',
        'configuration', true, true, state.paths.settingsFile,
        { expectedHash: state.settings.hash },
      ))
    }
    if (state.manifest) {
      actions.push(action(
        'remove-manifest', 'remove-file',
        'Remove the WorkBuddy setup ownership manifest',
        'destructive', true, false, state.paths.manifestFile,
      ))
    }
    warnings.push(
      `Bridge state under ${state.paths.bridgeRoot} is retained to avoid deleting workflow history or pending work.`,
    )
    return {
      version: 1,
      operation: 'uninstall',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: actions.length === 0
        ? 'No installer-owned WorkBuddy configuration can be removed automatically.'
        : 'Remove only configuration still provably owned by the WorkBuddy setup provider.',
      actions,
      warnings,
      manualSteps: [],
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
    const state = await inspectWorkBuddyState(context, options)
    const warnings = [...state.conflicts]
    if (state.conflicts.length > 0) {
      return {
        version: 1,
        operation,
        hostId: this.id,
        displayName: this.displayName,
        scope: options.scope,
        summary: 'WorkBuddy setup is blocked because existing configuration cannot be proven installer-owned.',
        actions: [],
        warnings,
        manualSteps: [
          'Resolve the reported WorkBuddy configuration conflict, then rerun `flowit-workflow setup workbuddy --dry-run` before applying changes.',
          ...workBuddyManualSteps(context),
        ],
      }
    }

    const actions: SetupPlan['actions'][number][] = []
    if (!deepEqual(getMcpEntry(state.mcp.value), state.desiredMcpEntry)) {
      actions.push(action(
        'merge-mcp', 'merge-json',
        'Configure Flowit Workflow as a WorkBuddy MCP server with mutation tools enabled',
        'configuration', true, true, state.paths.mcpFile,
        { expectedHash: state.mcp.hash },
      ))
    }
    if (state.skill.hash !== state.sourceSkill.hash) {
      actions.push(action(
        'install-skill', 'install-skill',
        'Install the Flowit Workflow Bridge Worker Skill',
        'filesystem', true, true, state.paths.skillFile,
        { expectedHash: state.skill.hash },
      ))
    }
    if (!hasDesiredHooks(state)) {
      actions.push(action(
        'merge-hooks', 'merge-hooks',
        'Merge Flowit lifecycle Hooks into WorkBuddy/CodeBuddy settings',
        'configuration', true, true, state.paths.settingsFile,
        { expectedHash: state.settings.hash },
      ))
    }
    if (state.bridgeMissing.length > 0) {
      actions.push(action(
        'ensure-bridge-directories', 'ensure-directory',
        'Create WorkBuddy Bridge transport directories',
        'filesystem', true, true, state.paths.bridgeRoot,
      ))
    }
    if (needsManifestUpdate(state, options)) {
      actions.push(action(
        'write-manifest', 'write-manifest',
        'Record installer ownership for safe repair and uninstall',
        'filesystem', true, true, state.paths.manifestFile,
      ))
    }
    return {
      version: 1,
      operation,
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: operation === 'setup'
        ? 'Configure WorkBuddy MCP, the Bridge Worker Skill, lifecycle Hooks, and durable Bridge directories.'
        : 'Repair installer-owned WorkBuddy integration files without overwriting conflicting user configuration.',
      actions,
      warnings,
      manualSteps: workBuddyManualSteps(context),
    }
  }

  private async applyPlan(
    operation: SetupOperation,
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult> {
    assertPlan(plan, operation, options)
    const state = await inspectWorkBuddyState(context, options)
    assertPlannedSnapshots(plan, state)
    preflightOwnership(plan, state)

    const applied: string[] = []
    const skipped: string[] = []
    for (const row of plan.actions) {
      const changed = await applyAction(row.id, context, options, state)
      ;(changed ? applied : skipped).push(row.id)
    }

    const doctor = operation === 'uninstall' ? undefined : await this.doctor(context, options)
    const manualSteps = operation === 'uninstall' ? [] : workBuddyManualSteps(context)
    const uninstallIncomplete = skipped.length > 0
      || plan.warnings.some(warning => !warning.startsWith('Bridge state under '))
    const status = operation === 'uninstall'
      ? uninstallIncomplete ? 'partial' : 'complete'
      : doctor?.status === 'unhealthy'
        ? 'failed'
        : requiresDesktopAutomation(context)
          ? 'manual-action-required'
          : 'complete'
    return {
      operation,
      hostId: this.id,
      displayName: this.displayName,
      status,
      appliedActions: applied,
      skippedActions: skipped,
      warnings: plan.warnings,
      manualSteps,
      ...(doctor ? { doctor } : {}),
    }
  }
}

async function applyAction(
  id: string,
  context: HostSetupContext,
  options: SetupRequestOptions,
  state: WorkBuddyState,
): Promise<boolean> {
  switch (id) {
    case 'merge-mcp':
      await mergeMcp(state)
      return true
    case 'install-skill':
      await installSkill(state)
      return true
    case 'merge-hooks':
      await mergeHooks(state)
      return true
    case 'ensure-bridge-directories':
      await ensureBridgeDirectories(state.paths.bridgeRoot)
      return true
    case 'write-manifest':
      await writeManifest(options, state)
      return true
    case 'remove-mcp':
      return removeMcp(state)
    case 'remove-skill':
      return removeSkill(state)
    case 'remove-hooks':
      return removeHooks(state)
    case 'remove-manifest':
      await rm(state.paths.manifestFile, { force: true })
      return true
    default:
      throw new Error(`WorkBuddy setup plan contains unknown action ${id}`)
  }
}

async function mergeMcp(state: WorkBuddyState): Promise<void> {
  const latest = await readJsonSnapshot(state.paths.mcpFile)
  assertSameHash('MCP configuration', latest.hash, state.mcp.hash, state.paths.mcpFile)
  const servers = latest.value.mcpServers === undefined ? {} : latest.value.mcpServers
  if (!isRecord(servers)) throw new Error('WorkBuddy mcpServers must be a JSON object')
  const current = servers[WORKBUDDY_MCP_SERVER]
  if (
    current !== undefined
    && !deepEqual(current, state.desiredMcpEntry)
    && !(state.manifest?.mcpEntry && deepEqual(current, state.manifest.mcpEntry))
  ) throw new Error('WorkBuddy flowit-workflow MCP entry is not installer-owned')
  await writeJson(state.paths.mcpFile, {
    ...latest.value,
    mcpServers: { ...servers, [WORKBUDDY_MCP_SERVER]: state.desiredMcpEntry },
  })
}

async function installSkill(state: WorkBuddyState): Promise<void> {
  const latest = await readTextSnapshot(state.paths.skillFile)
  assertSameHash('Skill', latest.hash, state.skill.hash, state.paths.skillFile)
  if (
    latest.exists
    && latest.hash !== state.sourceSkill.hash
    && !(state.manifest?.skillHash && latest.hash === state.manifest.skillHash)
  ) throw new Error('WorkBuddy Bridge Worker Skill is not installer-owned')
  await durableWriteText(state.paths.skillFile, state.sourceSkill.content)
}

async function mergeHooks(state: WorkBuddyState): Promise<void> {
  const latest = await readJsonSnapshot(state.paths.settingsFile)
  assertSameHash('settings', latest.hash, state.settings.hash, state.paths.settingsFile)
  const hooksValue = latest.value.hooks === undefined ? {} : latest.value.hooks
  if (!isRecord(hooksValue)) throw new Error('WorkBuddy settings hooks must be a JSON object')
  const hooks: JsonRecord = { ...hooksValue }
  for (const event of WORKBUDDY_HOOK_EVENTS) {
    const rows = hooks[event] === undefined ? [] : hooks[event]
    if (!Array.isArray(rows)) throw new Error(`WorkBuddy hook event ${event} must be an array`)
    const withoutOld = state.manifest?.hookEntry
      ? rows.filter(row => !deepEqual(row, state.manifest?.hookEntry))
      : rows
    hooks[event] = withoutOld.some(row => deepEqual(row, state.desiredHookEntry))
      ? withoutOld
      : [...withoutOld, state.desiredHookEntry]
  }
  await writeJson(state.paths.settingsFile, { ...latest.value, hooks })
}

async function removeMcp(state: WorkBuddyState): Promise<boolean> {
  const latest = await readJsonSnapshot(state.paths.mcpFile)
  assertSameHash('MCP configuration', latest.hash, state.mcp.hash, state.paths.mcpFile)
  const servers = latest.value.mcpServers
  if (!isRecord(servers)) return false
  const current = servers[WORKBUDDY_MCP_SERVER]
  if (!state.manifest?.mcpEntry || !deepEqual(current, state.manifest.mcpEntry)) return false
  const nextServers = { ...servers }
  delete nextServers[WORKBUDDY_MCP_SERVER]
  const next = { ...latest.value }
  if (Object.keys(nextServers).length === 0) delete next.mcpServers
  else next.mcpServers = nextServers
  await writeJson(state.paths.mcpFile, next)
  return true
}

async function removeSkill(state: WorkBuddyState): Promise<boolean> {
  const latest = await readTextSnapshot(state.paths.skillFile)
  assertSameHash('Skill', latest.hash, state.skill.hash, state.paths.skillFile)
  if (!latest.exists) return false
  if (!state.manifest?.skillHash || latest.hash !== state.manifest.skillHash) return false
  await rm(state.paths.skillFile, { force: true })
  await removeEmptyParents(
    path.dirname(state.paths.skillFile),
    path.dirname(path.dirname(state.paths.skillFile)),
  )
  return true
}

async function removeHooks(state: WorkBuddyState): Promise<boolean> {
  const latest = await readJsonSnapshot(state.paths.settingsFile)
  assertSameHash('settings', latest.hash, state.settings.hash, state.paths.settingsFile)
  const hooksValue = latest.value.hooks
  if (!isRecord(hooksValue)) return false
  const owned = state.manifest?.hookEntry
  if (!owned) return false
  let changed = false
  const hooks: JsonRecord = { ...hooksValue }
  for (const event of WORKBUDDY_HOOK_EVENTS) {
    const rows = hooks[event]
    if (!Array.isArray(rows)) continue
    const index = rows.findIndex(row => deepEqual(row, owned))
    if (index < 0) continue
    const kept = rows.toSpliced(index, 1)
    changed = true
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  if (!changed) return false
  const next = { ...latest.value }
  if (Object.keys(hooks).length === 0) delete next.hooks
  else next.hooks = hooks
  await writeJson(state.paths.settingsFile, next)
  return true
}

async function writeManifest(
  options: SetupRequestOptions,
  state: WorkBuddyState,
): Promise<void> {
  const [mcp, settings, skill] = await Promise.all([
    readJsonSnapshot(state.paths.mcpFile),
    readJsonSnapshot(state.paths.settingsFile),
    readTextSnapshot(state.paths.skillFile),
  ])
  const ownsMcp = Boolean(state.manifest?.mcpEntry)
    || !deepEqual(getMcpEntry(state.mcp.value), state.desiredMcpEntry)
  const ownsHooks = Boolean(state.manifest?.hookEntry) || !hasDesiredHooks(state)
  const ownsSkill = Boolean(state.manifest?.skillHash)
    || state.skill.hash !== state.sourceSkill.hash
  const manifest: WorkBuddySetupManifest = {
    version: WORKBUDDY_MANIFEST_VERSION,
    hostId: WORKBUDDY_HOST_ID,
    scope: options.scope,
    projectDir: path.resolve(options.projectDir),
    mcpFile: state.paths.mcpFile,
    settingsFile: state.paths.settingsFile,
    skillFile: state.paths.skillFile,
    bridgeRoot: state.paths.bridgeRoot,
    ...(ownsMcp && deepEqual(getMcpEntry(mcp.value), state.desiredMcpEntry)
      ? { mcpEntry: state.desiredMcpEntry } : {}),
    ...(ownsHooks && hooksContain(settings.value, state.desiredHookEntry)
      ? { hookEntry: state.desiredHookEntry } : {}),
    ...(ownsSkill && skill.hash === state.sourceSkill.hash
      ? { skillHash: state.sourceSkill.hash } : {}),
    installedAt: new Date().toISOString(),
  }
  await writeJson(state.paths.manifestFile, manifest as unknown as JsonRecord)
}

function needsManifestUpdate(state: WorkBuddyState, options: SetupRequestOptions): boolean {
  const manifest = state.manifest
  if (!manifest) return true
  if (manifest.scope !== options.scope) return true
  if (
    manifest.mcpFile !== state.paths.mcpFile
    || manifest.settingsFile !== state.paths.settingsFile
    || manifest.skillFile !== state.paths.skillFile
    || manifest.bridgeRoot !== state.paths.bridgeRoot
  ) return true
  if (manifest.mcpEntry && !deepEqual(manifest.mcpEntry, state.desiredMcpEntry)) return true
  if (manifest.hookEntry && !deepEqual(manifest.hookEntry, state.desiredHookEntry)) return true
  if (manifest.skillHash && manifest.skillHash !== state.sourceSkill.hash) return true
  return false
}

function ownsCurrentMcp(state: WorkBuddyState): boolean {
  return Boolean(
    state.manifest?.mcpEntry
    && deepEqual(getMcpEntry(state.mcp.value), state.manifest.mcpEntry),
  )
}

function ownsCurrentSkill(state: WorkBuddyState): boolean {
  return Boolean(
    state.manifest?.skillHash
    && state.skill.exists
    && state.skill.hash === state.manifest.skillHash,
  )
}

function ownsCurrentHooks(state: WorkBuddyState): boolean {
  const owned = state.manifest?.hookEntry
  if (!owned) return false
  const hooks = state.settings.value.hooks
  return isRecord(hooks) && WORKBUDDY_HOOK_EVENTS.some(
    event => Array.isArray(hooks[event]) && hooks[event].some(row => deepEqual(row, owned)),
  )
}

function preflightOwnership(plan: SetupPlan, state: WorkBuddyState): void {
  const ids = new Set(plan.actions.map(row => row.id))
  if (ids.has('merge-mcp') && !canManageMcpEntry(state)) {
    throw new Error('WorkBuddy MCP ownership changed after planning; refusing to overwrite it')
  }
  if (ids.has('install-skill') && !canManageSkill(state)) {
    throw new Error('WorkBuddy Skill ownership changed after planning; refusing to overwrite it')
  }
  if (ids.has('merge-hooks') && !canManageHooks(state)) {
    throw new Error('WorkBuddy Hooks changed after planning; refusing to overwrite them')
  }
  if (ids.has('remove-mcp') && !ownsCurrentMcp(state)) {
    throw new Error('WorkBuddy MCP ownership changed after uninstall planning; refusing to remove it')
  }
  if (ids.has('remove-skill') && !ownsCurrentSkill(state)) {
    throw new Error('WorkBuddy Skill ownership changed after uninstall planning; refusing to remove it')
  }
}

function assertPlannedSnapshots(plan: SetupPlan, state: WorkBuddyState): void {
  for (const row of plan.actions) {
    const expected = row.details?.expectedHash
    if (expected !== null && typeof expected !== 'string') continue
    const actual = row.id === 'merge-mcp' || row.id === 'remove-mcp'
      ? state.mcp.hash
      : row.id === 'merge-hooks' || row.id === 'remove-hooks'
        ? state.settings.hash
        : row.id === 'install-skill' || row.id === 'remove-skill'
          ? state.skill.hash
          : undefined
    if (actual !== undefined && actual !== expected) {
      throw new Error(
        `WorkBuddy ${row.id} target changed after planning; rerun --dry-run before applying changes`,
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
    plan.hostId !== WORKBUDDY_HOST_ID
    || plan.operation !== operation
    || plan.scope !== options.scope
  ) throw new Error('WorkBuddy setup plan does not match the requested operation/scope')
  const allowed = new Set([
    'merge-mcp', 'install-skill', 'merge-hooks', 'ensure-bridge-directories', 'write-manifest',
    'remove-mcp', 'remove-skill', 'remove-hooks', 'remove-manifest',
  ])
  for (const row of plan.actions) {
    if (!allowed.has(row.id)) throw new Error(`unsupported WorkBuddy setup action ${row.id}`)
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

function assertSameHash(
  label: string,
  actual: string | null,
  expected: string | null,
  file: string,
): void {
  if (actual !== expected) throw new Error(`WorkBuddy ${label} changed while setup was running: ${file}`)
}
