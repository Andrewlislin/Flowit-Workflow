import { rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  DoctorCheck,
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
  OPENCODE_CONFIG_SCHEMA,
  OPENCODE_MCP_PATH,
  OPENCODE_SETUP_DISPLAY_NAME,
  OPENCODE_SETUP_HOST_ID,
  OPENCODE_SETUP_MANIFEST_VERSION,
  detectOpenCode,
  inspectOpenCodeState,
  openCodeDoctorChecks,
  openCodeManualSteps,
  openCodeSetupPaths,
  semanticHash,
  type OpenCodeSetupManifest,
  type OpenCodeState,
} from './opencode-state.js'
import {
  jsoncPropertyValue,
  parseJsoncDocument,
  removeJsoncProperty,
  setJsoncProperty,
} from './opencode-jsonc.js'

export class OpenCodeSetupProvider implements HostSetupProvider {
  readonly id = OPENCODE_SETUP_HOST_ID
  readonly displayName = OPENCODE_SETUP_DISPLAY_NAME

  async detect(context: HostSetupContext): Promise<HostDetection> {
    const detected = await detectOpenCode(context)
    const userPaths = await openCodeSetupPaths(context, { scope: 'user', projectDir: context.cwd })
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: detected ? 'detected' : 'not-detected',
      details: {
        userConfig: userPaths.configFile,
        projectConfig: path.join(context.cwd, 'opencode.jsonc'),
        baseUrl: context.env.FLOWIT_WORKFLOW_OPENCODE_URL?.trim() || 'http://127.0.0.1:4096',
      },
      ...(detected ? {} : {
        message: 'OpenCode V2 was not detected on PATH or in standard config locations; explicit setup can still stage the MCP configuration.',
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
      const state = await inspectOpenCodeState(context, options)
      const checks = [...openCodeDoctorChecks(options, state)]
      const server = await probeOpenCodeServer(state.baseUrl)
      checks.push(serverCheck(state.baseUrl, server))
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
          id: 'opencode-state',
          status: 'error',
          summary: 'OpenCode setup state could not be inspected',
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
    const state = await inspectOpenCodeState(context, options)
    const actions: SetupPlan['actions'][number][] = []
    const warnings = [...state.conflicts]

    if (state.currentEntry !== undefined) {
      if (state.manifest && state.currentEntryHash === state.manifest.entryHash) {
        actions.push(action(
          'remove-mcp-entry',
          'edit-jsonc',
          'Remove the installer-owned Flowit MCP entry from OpenCode config',
          'configuration',
          true,
          true,
          state.paths.configFile,
          { expectedHash: state.config.hash },
        ))
      } else {
        warnings.push('The Flowit OpenCode MCP entry cannot be proven installer-owned and will be preserved.')
      }
    }
    if (state.manifest) {
      actions.push(action(
        'remove-manifest',
        'remove-file',
        'Remove the OpenCode setup ownership manifest',
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
        ? 'No installer-owned OpenCode configuration can be removed automatically.'
        : 'Remove only the Flowit OpenCode MCP entry still provably owned by setup.',
      actions,
      warnings,
      manualSteps: [
        'Restart/reload OpenCode after uninstall so MCP configuration is reconciled.',
        'Restart the Flowit daemon if it was running with the OpenCode adapter.',
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
    const state = await inspectOpenCodeState(context, options)
    const warnings = [...state.conflicts]
    if (state.conflicts.length > 0) {
      return {
        version: 1,
        operation,
        hostId: this.id,
        displayName: this.displayName,
        scope: options.scope,
        summary: 'OpenCode setup is blocked because the target V2 MCP entry cannot be proven installer-owned.',
        actions: [],
        warnings,
        manualSteps: [
          `Resolve the reported OpenCode config conflict in ${state.paths.configFile}, then rerun \`flowit-workflow setup opencode --dry-run\`.`,
          ...openCodeManualSteps(options, state),
        ],
      }
    }

    const actions: SetupPlan['actions'][number][] = []
    const entryNeedsWrite = state.currentEntryHash !== state.desiredEntryHash
    const configExistedBefore = state.manifest?.configExistedBefore ?? state.config.exists
    const manifestNeedsWrite = !state.manifest
      || state.manifest.entryHash !== state.desiredEntryHash
      || state.manifest.baseUrl !== state.baseUrl

    if (!state.manifest && entryNeedsWrite) {
      actions.push(manifestAction(state, configExistedBefore, true))
    }
    if (entryNeedsWrite) {
      actions.push(action(
        'upsert-mcp-entry',
        'edit-jsonc',
        'Install/update Flowit under OpenCode V2 mcp.servers while preserving unrelated JSONC',
        'configuration',
        true,
        true,
        state.paths.configFile,
        { expectedHash: state.config.hash, entryHash: state.desiredEntryHash },
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
        'This project-scope MCP entry references the current Flowit installation path. For a team-portable project config, install Flowit inside the project or use the future published-package setup path before committing OpenCode config.',
      )
    }

    return {
      version: 1,
      operation,
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: operation === 'setup'
        ? 'Configure Flowit as an OpenCode V2 local MCP server using a comment-preserving JSONC edit.'
        : 'Repair only the installer-owned Flowit MCP entry in OpenCode V2 configuration.',
      actions,
      warnings,
      manualSteps: openCodeManualSteps(options, state),
    }
  }

  private async applyPlan(
    operation: SetupOperation,
    context: HostSetupContext,
    plan: SetupPlan,
    options: SetupApplyOptions,
  ): Promise<SetupResult> {
    assertPlan(plan, operation, options)
    const state = await inspectOpenCodeState(context, options)
    if (operation !== 'uninstall' && state.conflicts.length > 0 && plan.actions.length > 0) {
      throw new Error('OpenCode MCP ownership changed after planning; refusing to modify it')
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

    const fresh = await inspectOpenCodeState(context, options)
    const doctor = await this.doctor(context, options)
    const serverReachable = doctor.checks.find(check => check.id === 'opencode-server')?.status === 'ok'
    const manualSteps = openCodeManualSteps(options, fresh, serverReachable)
    return {
      operation,
      hostId: this.id,
      displayName: this.displayName,
      status: doctor.status === 'unhealthy'
        ? 'failed'
        : doctor.status === 'degraded'
          ? 'manual-action-required'
          : 'complete',
      appliedActions: applied,
      skippedActions: skipped,
      warnings: plan.warnings,
      manualSteps,
      doctor,
    }
  }
}

async function applyAction(
  row: SetupPlan['actions'][number],
  options: SetupRequestOptions,
  state: OpenCodeState,
): Promise<boolean> {
  switch (row.id) {
    case 'write-manifest': {
      const latest = await readTextSnapshot(state.paths.setupManifestFile)
      assertHash('OpenCode setup manifest', latest.hash, row.details?.expectedHash, state.paths.setupManifestFile)
      const entryHash = row.details?.entryHash
      const configExistedBefore = row.details?.configExistedBefore
      const baseUrl = row.details?.baseUrl
      if (typeof entryHash !== 'string' || typeof configExistedBefore !== 'boolean' || typeof baseUrl !== 'string') {
        throw new Error('OpenCode setup manifest action is missing ownership metadata')
      }
      const manifest: OpenCodeSetupManifest = {
        version: OPENCODE_SETUP_MANIFEST_VERSION,
        hostId: OPENCODE_SETUP_HOST_ID,
        scope: options.scope,
        projectDir: path.resolve(options.projectDir),
        configFile: state.paths.configFile,
        entryHash,
        configExistedBefore,
        baseUrl,
        installedAt: state.manifest?.installedAt ?? new Date().toISOString(),
      }
      await durableWriteText(state.paths.setupManifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
      return true
    }
    case 'upsert-mcp-entry': {
      const latest = await readTextSnapshot(state.paths.configFile)
      assertHash('OpenCode config', latest.hash, row.details?.expectedHash, state.paths.configFile)
      if (row.details?.entryHash !== state.desiredEntryHash) {
        throw new Error('OpenCode MCP entry changed after planning; rerun --dry-run')
      }
      const source = latest.exists
        ? latest.content ?? ''
        : `{\n  "$schema": ${JSON.stringify(OPENCODE_CONFIG_SCHEMA)}\n}\n`
      const document = parseJsoncDocument(source)
      const current = jsoncPropertyValue(document, OPENCODE_MCP_PATH)
      if (current !== undefined) {
        if (!state.manifest || semanticHash(current) !== state.manifest.entryHash) {
          throw new Error('OpenCode MCP ownership changed while setup was running')
        }
      }
      const legacy = jsoncPropertyValue(document, ['mcp', OPENCODE_SETUP_HOST_ID])
      if (legacy !== undefined) {
        throw new Error('A legacy OpenCode mcp.flowit-workflow entry appeared after planning; refusing to create the V2 entry')
      }
      const next = setJsoncProperty(document, OPENCODE_MCP_PATH, state.desiredEntry)
      parseJsoncDocument(next)
      await durableWriteText(state.paths.configFile, next.endsWith('\n') ? next : `${next}\n`)
      return true
    }
    case 'remove-mcp-entry': {
      const latest = await readTextSnapshot(state.paths.configFile)
      assertHash('OpenCode config', latest.hash, row.details?.expectedHash, state.paths.configFile)
      if (!latest.exists || !state.manifest) return false
      const document = parseJsoncDocument(latest.content ?? '')
      const current = jsoncPropertyValue(document, OPENCODE_MCP_PATH)
      if (current === undefined || semanticHash(current) !== state.manifest.entryHash) return false
      const next = removeJsoncProperty(document, OPENCODE_MCP_PATH)
      parseJsoncDocument(next)
      await durableWriteText(state.paths.configFile, next.endsWith('\n') ? next : `${next}\n`)
      return true
    }
    case 'remove-manifest': {
      const latest = await readTextSnapshot(state.paths.setupManifestFile)
      assertHash('OpenCode setup manifest', latest.hash, row.details?.expectedHash, state.paths.setupManifestFile)
      if (!latest.exists) return false
      await rm(state.paths.setupManifestFile, { force: true })
      return true
    }
    default:
      throw new Error(`OpenCode setup plan contains unknown action ${row.id}`)
  }
}

function manifestAction(
  state: OpenCodeState,
  configExistedBefore: boolean,
  seed: boolean,
): SetupPlan['actions'][number] {
  return action(
    'write-manifest',
    'write-manifest',
    seed
      ? 'Seed OpenCode MCP ownership before editing JSONC configuration'
      : 'Update OpenCode MCP ownership after the managed entry changes',
    'filesystem',
    true,
    true,
    state.paths.setupManifestFile,
    {
      expectedHash: state.manifestSnapshot.hash,
      entryHash: state.desiredEntryHash,
      configExistedBefore,
      baseUrl: state.baseUrl,
    },
  )
}

function preflightOwnership(plan: SetupPlan, state: OpenCodeState): void {
  const ids = new Set(plan.actions.map(row => row.id))
  if (ids.has('remove-mcp-entry')) {
    if (!state.manifest || state.currentEntryHash !== state.manifest.entryHash) {
      throw new Error('OpenCode MCP ownership changed after uninstall planning; refusing to remove it')
    }
  }
}

function assertPlannedSnapshots(plan: SetupPlan, state: OpenCodeState): void {
  for (const row of plan.actions) {
    const expected = row.details?.expectedHash
    if (expected !== null && typeof expected !== 'string') continue
    const actual = row.id === 'upsert-mcp-entry' || row.id === 'remove-mcp-entry'
      ? state.config.hash
      : row.id === 'write-manifest' || row.id === 'remove-manifest'
        ? state.manifestSnapshot.hash
        : undefined
    if (actual !== undefined && actual !== expected) {
      throw new Error(`OpenCode ${row.id} target changed after planning; rerun --dry-run before applying changes`)
    }
  }
}

function assertPlan(
  plan: SetupPlan,
  operation: SetupOperation,
  options: SetupRequestOptions,
): void {
  if (
    plan.hostId !== OPENCODE_SETUP_HOST_ID
    || plan.operation !== operation
    || plan.scope !== options.scope
  ) throw new Error('OpenCode setup plan does not match the requested operation/scope')
  const allowed = new Set(['write-manifest', 'upsert-mcp-entry', 'remove-mcp-entry', 'remove-manifest'])
  for (const row of plan.actions) {
    if (!allowed.has(row.id)) throw new Error(`unsupported OpenCode setup action ${row.id}`)
  }
}

async function probeOpenCodeServer(baseUrl: string): Promise<boolean> {
  for (const pathname of ['/global/health', '/api/health']) {
    try {
      const response = await fetch(new URL(pathname, `${baseUrl}/`), {
        signal: AbortSignal.timeout(500),
        headers: { accept: 'application/json' },
      })
      if (response.ok) return true
    } catch {}
  }
  return false
}

function serverCheck(baseUrl: string, reachable: boolean): DoctorCheck {
  return reachable
    ? { id: 'opencode-server', status: 'ok', summary: `OpenCode V2 server is reachable at ${baseUrl}` }
    : {
        id: 'opencode-server',
        status: 'warning',
        summary: `OpenCode V2 server is not currently reachable at ${baseUrl}`,
        detail: 'Flowit does not silently start an unmanaged host process; start OpenCode serve/service explicitly and rerun doctor.',
        repairable: false,
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
