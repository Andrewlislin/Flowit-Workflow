import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  DoctorCheck,
  HostSetupContext,
  SetupRequestOptions,
} from '../types.js'
import {
  assertDirectory,
  assertReadable,
  digest,
  isRecord,
  missingBridgeDirectories,
  pathExists,
  readJsonSnapshot,
  readTextSnapshot,
  type JsonRecord,
  type JsonSnapshot,
  type TextSnapshot,
} from './workbuddy-files.js'

export const WORKBUDDY_HOST_ID = 'workbuddy'
export const WORKBUDDY_DISPLAY_NAME = 'WorkBuddy'
export const WORKBUDDY_MCP_SERVER = 'flowit-workflow'
export const WORKBUDDY_SKILL_NAME = 'flowit-workflow-bridge-worker'
export const WORKBUDDY_HOOK_EVENTS = ['SessionStart', 'Stop', 'SessionEnd'] as const
export const WORKBUDDY_MANIFEST_VERSION = 1

export interface WorkBuddySetupPaths {
  readonly mcpFile: string
  readonly settingsFile: string
  readonly skillFile: string
  readonly sourceSkillFile: string
  readonly mcpServerFile: string
  readonly cliFile: string
  readonly bridgeRoot: string
  readonly manifestFile: string
}

export interface WorkBuddySetupManifest {
  readonly version: 1
  readonly hostId: 'workbuddy'
  readonly scope: 'user' | 'project'
  readonly projectDir: string
  readonly mcpFile: string
  readonly settingsFile: string
  readonly skillFile: string
  readonly bridgeRoot: string
  readonly mcpEntry?: JsonRecord
  readonly hookEntry?: JsonRecord
  readonly skillHash?: string
  readonly installedAt: string
}

export interface WorkBuddyState {
  readonly paths: WorkBuddySetupPaths
  readonly mcp: JsonSnapshot
  readonly settings: JsonSnapshot
  readonly skill: TextSnapshot
  readonly sourceSkill: { readonly content: string; readonly hash: string }
  readonly manifest?: WorkBuddySetupManifest
  readonly desiredMcpEntry: JsonRecord
  readonly desiredHookEntry: JsonRecord
  readonly bridgeMissing: readonly string[]
  readonly conflicts: readonly string[]
}

export async function detectWorkBuddy(context: HostSetupContext): Promise<boolean> {
  if (context.env.FLOWIT_WORKFLOW_WORKBUDDY_DRIVER?.trim()) return true
  return (await pathExists(path.join(context.homeDir, '.workbuddy')))
    || (await pathExists(path.join(context.cwd, '.workbuddy')))
}

export async function inspectWorkBuddyState(
  context: HostSetupContext,
  options: SetupRequestOptions,
): Promise<WorkBuddyState> {
  if (options.scope === 'project') await assertDirectory(options.projectDir)
  const paths = workBuddySetupPaths(context, options)
  await Promise.all([
    assertReadable(paths.sourceSkillFile, 'packaged WorkBuddy Bridge Worker Skill'),
    assertReadable(paths.mcpServerFile, 'Flowit MCP server build artifact'),
    assertReadable(paths.cliFile, 'Flowit CLI build artifact'),
  ])

  const [mcp, settings, skill, sourceContent, manifest, bridgeMissing] = await Promise.all([
    readJsonSnapshot(paths.mcpFile),
    readJsonSnapshot(paths.settingsFile),
    readTextSnapshot(paths.skillFile),
    readFile(paths.sourceSkillFile, 'utf8'),
    readWorkBuddyManifest(paths.manifestFile),
    missingBridgeDirectories(paths.bridgeRoot),
  ])
  const sourceSkill = { content: sourceContent, hash: digest(sourceContent) }
  const desiredMcpEntry = workBuddyMcpEntry(paths)
  const desiredHookEntry = workBuddyHookEntry(context, paths)
  const provisional: WorkBuddyState = {
    paths,
    mcp,
    settings,
    skill,
    sourceSkill,
    ...(manifest ? { manifest } : {}),
    desiredMcpEntry,
    desiredHookEntry,
    bridgeMissing,
    conflicts: [],
  }
  return { ...provisional, conflicts: workBuddyConflicts(provisional) }
}

export function workBuddySetupPaths(
  context: HostSetupContext,
  options: SetupRequestOptions,
): WorkBuddySetupPaths {
  const projectDir = path.resolve(options.projectDir)
  const userCodeBuddyRoot = context.env.CODEBUDDY_CONFIG_DIR?.trim()
    ? path.resolve(context.env.CODEBUDDY_CONFIG_DIR)
    : path.join(context.homeDir, '.codebuddy')
  const mcpFile = options.scope === 'user'
    ? path.join(context.homeDir, '.workbuddy', 'mcp.json')
    : path.join(projectDir, '.workbuddy', 'mcp.json')
  const codeBuddyRoot = options.scope === 'user'
    ? userCodeBuddyRoot
    : path.join(projectDir, '.codebuddy')
  return {
    mcpFile,
    settingsFile: path.join(codeBuddyRoot, 'settings.json'),
    skillFile: path.join(codeBuddyRoot, 'skills', WORKBUDDY_SKILL_NAME, 'SKILL.md'),
    sourceSkillFile: path.join(
      context.packageRoot,
      'integrations', 'workbuddy', 'flowit-bridge-worker', 'SKILL.md',
    ),
    mcpServerFile: path.join(context.packageRoot, 'dist', 'mcp-server.js'),
    cliFile: path.join(context.packageRoot, 'dist', 'cli.js'),
    bridgeRoot: path.join(context.homeDir, '.flowit-workflow', 'bridges', WORKBUDDY_HOST_ID),
    manifestFile: options.scope === 'user'
      ? path.join(context.homeDir, '.flowit-workflow', 'setup', 'workbuddy-user.json')
      : path.join(projectDir, '.flowit-workflow', 'setup', 'workbuddy.json'),
  }
}

export function workBuddyManualSteps(context: HostSetupContext): string[] {
  const steps = ['Restart/reload WorkBuddy after setup so MCP, Skills, and lifecycle Hooks are reloaded.']
  if (requiresDesktopAutomation(context)) {
    steps.unshift(
      'For unattended Desktop Bridge execution, enable one WorkBuddy native Automation that periodically invokes the installed “Flowit Workflow Bridge Worker” Skill. WorkBuddy currently exposes no public Automation write API for the installer to call safely.',
    )
  }
  return steps
}

export function requiresDesktopAutomation(context: HostSetupContext): boolean {
  return !context.env.FLOWIT_WORKFLOW_WORKBUDDY_DRIVER?.trim()
}

export function getMcpEntry(root: JsonRecord): unknown {
  const servers = root.mcpServers
  if (servers === undefined) return undefined
  if (!isRecord(servers)) return INVALID_MCP_SERVERS
  return servers[WORKBUDDY_MCP_SERVER]
}

export function canManageMcpEntry(state: WorkBuddyState): boolean {
  const servers = state.mcp.value.mcpServers
  if (servers !== undefined && !isRecord(servers)) return false
  const current = getMcpEntry(state.mcp.value)
  if (current === undefined || deepEqual(current, state.desiredMcpEntry)) return true
  return Boolean(state.manifest?.mcpEntry && deepEqual(current, state.manifest.mcpEntry))
}

export function canRemoveMcpEntry(state: WorkBuddyState): boolean {
  const current = getMcpEntry(state.mcp.value)
  if (current === undefined) return false
  return deepEqual(current, state.desiredMcpEntry)
    || Boolean(state.manifest?.mcpEntry && deepEqual(current, state.manifest.mcpEntry))
}

export function canManageSkill(state: WorkBuddyState): boolean {
  if (!state.skill.exists || state.skill.hash === state.sourceSkill.hash) return true
  return Boolean(state.manifest?.skillHash && state.skill.hash === state.manifest.skillHash)
}

export function canRemoveSkill(state: WorkBuddyState): boolean {
  if (!state.skill.exists) return false
  return state.skill.hash === state.sourceSkill.hash
    || Boolean(state.manifest?.skillHash && state.skill.hash === state.manifest.skillHash)
}

export function canManageHooks(state: WorkBuddyState): boolean {
  const hooks = state.settings.value.hooks
  if (hooks === undefined) return true
  if (!isRecord(hooks)) return false
  return WORKBUDDY_HOOK_EVENTS.every(event => hooks[event] === undefined || Array.isArray(hooks[event]))
}

export function hasDesiredHooks(state: WorkBuddyState): boolean {
  return hooksContain(state.settings.value, state.desiredHookEntry)
}

export function hasOwnedHooks(state: WorkBuddyState): boolean {
  const hooks = state.settings.value.hooks
  if (!isRecord(hooks)) return false
  const owned = state.manifest?.hookEntry ?? state.desiredHookEntry
  return WORKBUDDY_HOOK_EVENTS.some(
    event => Array.isArray(hooks[event]) && hooks[event].some(row => deepEqual(row, owned)),
  )
}

export function manifestNeedsUpdate(state: WorkBuddyState, options: SetupRequestOptions): boolean {
  const manifest = state.manifest
  if (!manifest) return true
  if (manifest.scope !== options.scope) return true
  if (
    manifest.mcpFile !== state.paths.mcpFile
    || manifest.settingsFile !== state.paths.settingsFile
    || manifest.skillFile !== state.paths.skillFile
    || manifest.bridgeRoot !== state.paths.bridgeRoot
  ) return true
  const mcpOwned = deepEqual(getMcpEntry(state.mcp.value), state.desiredMcpEntry)
  const hooksOwned = hooksContain(state.settings.value, state.desiredHookEntry)
  const skillOwned = state.skill.hash === state.sourceSkill.hash
  if (mcpOwned !== Boolean(manifest.mcpEntry)) return true
  if (hooksOwned !== Boolean(manifest.hookEntry)) return true
  if (skillOwned !== Boolean(manifest.skillHash)) return true
  if (mcpOwned && !deepEqual(manifest.mcpEntry, state.desiredMcpEntry)) return true
  if (hooksOwned && !deepEqual(manifest.hookEntry, state.desiredHookEntry)) return true
  if (skillOwned && manifest.skillHash !== state.sourceSkill.hash) return true
  return false
}

export function workBuddyDoctorChecks(
  context: HostSetupContext,
  state: WorkBuddyState,
): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  const currentMcp = getMcpEntry(state.mcp.value)
  checks.push(
    deepEqual(currentMcp, state.desiredMcpEntry)
      ? { id: 'mcp', status: 'ok', summary: 'Flowit Workflow MCP is configured for WorkBuddy' }
      : currentMcp === undefined
        ? { id: 'mcp', status: 'warning', summary: 'Flowit Workflow MCP is not configured for WorkBuddy', repairable: true }
        : { id: 'mcp', status: 'error', summary: 'WorkBuddy flowit-workflow MCP entry conflicts with installer ownership', repairable: false },
  )
  checks.push(
    state.skill.hash === state.sourceSkill.hash
      ? { id: 'skill', status: 'ok', summary: 'Flowit Workflow Bridge Worker Skill is installed' }
      : !state.skill.exists
        ? { id: 'skill', status: 'warning', summary: 'Flowit Workflow Bridge Worker Skill is missing', repairable: true }
        : { id: 'skill', status: 'error', summary: 'Flowit Workflow Bridge Worker Skill was modified outside the installer', repairable: false },
  )
  checks.push(
    hasDesiredHooks(state)
      ? { id: 'hooks', status: 'ok', summary: 'WorkBuddy lifecycle Hooks include Flowit Bridge ingestion' }
      : canManageHooks(state)
        ? { id: 'hooks', status: 'warning', summary: 'Flowit WorkBuddy lifecycle Hooks are incomplete', repairable: true }
        : { id: 'hooks', status: 'error', summary: 'WorkBuddy Hooks configuration cannot be merged safely', repairable: false },
  )
  checks.push({
    id: 'bridge-directories',
    status: state.bridgeMissing.length === 0 ? 'ok' : 'warning',
    summary: state.bridgeMissing.length === 0
      ? 'WorkBuddy Bridge directories are ready'
      : `WorkBuddy Bridge is missing ${state.bridgeMissing.length} director${state.bridgeMissing.length === 1 ? 'y' : 'ies'}`,
    ...(state.bridgeMissing.length === 0
      ? {}
      : { detail: state.bridgeMissing.join(', '), repairable: true }),
  })
  checks.push(
    requiresDesktopAutomation(context)
      ? {
          id: 'worker-execution',
          status: 'warning',
          summary: 'Desktop Bridge worker Automation cannot be provisioned through a public WorkBuddy API',
          detail: 'Enable one WorkBuddy native Automation that periodically invokes the installed Flowit Workflow Bridge Worker Skill. Interactive/manual Skill invocation also works.',
          repairable: false,
        }
      : { id: 'worker-execution', status: 'ok', summary: 'Managed WorkBuddy driver is configured' },
  )
  return checks
}

export function hooksContain(settings: JsonRecord, entry: JsonRecord): boolean {
  const hooks = settings.hooks
  return isRecord(hooks) && WORKBUDDY_HOOK_EVENTS.every(
    event => Array.isArray(hooks[event]) && hooks[event].some(row => deepEqual(row, entry)),
  )
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right)
}

async function readWorkBuddyManifest(file: string): Promise<WorkBuddySetupManifest | undefined> {
  const snapshot = await readJsonSnapshot(file)
  if (!snapshot.exists) return undefined
  const value = snapshot.value as Partial<WorkBuddySetupManifest>
  if (
    value.version !== WORKBUDDY_MANIFEST_VERSION
    || value.hostId !== WORKBUDDY_HOST_ID
    || (value.scope !== 'user' && value.scope !== 'project')
  ) throw new Error(`unsupported or malformed WorkBuddy setup manifest: ${file}`)
  if (
    typeof value.projectDir !== 'string'
    || typeof value.mcpFile !== 'string'
    || typeof value.settingsFile !== 'string'
    || typeof value.skillFile !== 'string'
    || typeof value.bridgeRoot !== 'string'
    || typeof value.installedAt !== 'string'
  ) throw new Error(`malformed WorkBuddy setup manifest: ${file}`)
  return value as WorkBuddySetupManifest
}

function workBuddyConflicts(state: WorkBuddyState): string[] {
  const conflicts: string[] = []
  if (getMcpEntry(state.mcp.value) !== undefined && !canManageMcpEntry(state)) {
    conflicts.push(
      `MCP server ${WORKBUDDY_MCP_SERVER} already exists in ${state.paths.mcpFile} with a value not owned by this installer.`,
    )
  }
  if (state.skill.exists && !canManageSkill(state)) {
    conflicts.push(`Skill ${state.paths.skillFile} already exists with content not owned by this installer.`)
  }
  if (!canManageHooks(state)) {
    conflicts.push(`Hooks in ${state.paths.settingsFile} use a shape the installer cannot merge safely.`)
  }
  return conflicts
}

function workBuddyMcpEntry(paths: WorkBuddySetupPaths): JsonRecord {
  return {
    command: process.execPath,
    args: [paths.mcpServerFile],
    env: {
      FLOWIT_WORKFLOW_ADAPTER: WORKBUDDY_HOST_ID,
      FLOWIT_WORKFLOW_MUTATIONS: '1',
    },
    disabled: false,
  }
}

function workBuddyHookEntry(
  context: HostSetupContext,
  paths: WorkBuddySetupPaths,
): JsonRecord {
  const command = [process.execPath, paths.cliFile, 'bridge-hook', WORKBUDDY_HOST_ID]
    .map(value => shellQuote(value, context.platform))
    .join(' ')
  return { hooks: [{ type: 'command', command, timeout: 10 }] }
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`
  return `'${value.replaceAll("'", "'\\''")}'`
}

const INVALID_MCP_SERVERS = Symbol('invalid-mcp-servers')
