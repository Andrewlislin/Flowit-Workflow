import { access } from 'node:fs/promises'
import path from 'node:path'
import type { DoctorCheck, HostSetupContext, SetupRequestOptions } from '../types.js'
import {
  assertDirectory,
  assertReadable,
  digest,
  isRecord,
  pathExists,
  readTextSnapshot,
  type TextSnapshot,
} from './workbuddy-files.js'
import {
  jsoncPropertyValue,
  jsoncSemanticValue,
  parseJsoncDocument,
  type JsoncDocument,
} from './opencode-jsonc.js'

export const OPENCODE_SETUP_HOST_ID = 'opencode'
export const OPENCODE_SETUP_DISPLAY_NAME = 'OpenCode V2'
export const OPENCODE_MCP_SERVER = 'flowit-workflow'
export const OPENCODE_SETUP_MANIFEST_VERSION = 1
export const OPENCODE_DEFAULT_URL = 'http://127.0.0.1:4096'
export const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json'
export const OPENCODE_MCP_PATH = ['mcp', 'servers', OPENCODE_MCP_SERVER] as const

export interface OpenCodeSetupPaths {
  readonly configFile: string
  readonly configCandidates: readonly string[]
  readonly existingConfigFiles: readonly string[]
  readonly setupManifestFile: string
  readonly mcpServerFile: string
}

export interface OpenCodeSetupManifest {
  readonly version: 1
  readonly hostId: 'opencode'
  readonly scope: 'user' | 'project'
  readonly projectDir: string
  readonly configFile: string
  readonly entryHash: string
  readonly configExistedBefore: boolean
  readonly baseUrl: string
  readonly installedAt: string
}

export interface OpenCodeState {
  readonly paths: OpenCodeSetupPaths
  readonly config: TextSnapshot
  readonly configDocument: JsoncDocument
  readonly manifestSnapshot: TextSnapshot
  readonly manifest?: OpenCodeSetupManifest
  readonly currentEntry?: unknown
  readonly currentEntryHash?: string
  readonly desiredEntry: Readonly<Record<string, unknown>>
  readonly desiredEntryHash: string
  readonly baseUrl: string
  readonly opencodeExecutable?: string
  readonly binaryFlavor?: 'v2' | 'legacy' | 'explicit'
  readonly conflicts: readonly string[]
}

export async function detectOpenCode(context: HostSetupContext): Promise<boolean> {
  if (await findOpenCodeExecutable(context)) return true
  const user = await openCodeConfigSelection(context, { scope: 'user', projectDir: context.cwd })
  if (user.existing.length > 0) return true
  const project = await openCodeConfigSelection(context, { scope: 'project', projectDir: context.cwd })
  return project.existing.length > 0
}

export async function inspectOpenCodeState(
  context: HostSetupContext,
  options: SetupRequestOptions,
): Promise<OpenCodeState> {
  if (options.scope === 'project') await assertDirectory(options.projectDir)
  const paths = await openCodeSetupPaths(context, options)
  await assertReadable(paths.mcpServerFile, 'Flowit MCP server build artifact')

  const [config, manifestSnapshot, executable] = await Promise.all([
    readTextSnapshot(paths.configFile),
    readTextSnapshot(paths.setupManifestFile),
    findOpenCodeExecutable(context),
  ])
  const source = config.exists ? config.content ?? '' : '{}\n'
  const configDocument = parseJsoncDocument(source)
  const manifest = parseOpenCodeSetupManifest(manifestSnapshot, paths.setupManifestFile)
  const currentEntry = jsoncPropertyValue(configDocument, OPENCODE_MCP_PATH)
  const currentEntryHash = currentEntry === undefined ? undefined : semanticHash(currentEntry)
  const baseUrl = openCodeBaseUrl(context)
  const desiredEntry = openCodeMcpEntry(context, paths, baseUrl)
  const desiredEntryHash = semanticHash(desiredEntry)
  const binary = executable ? executableFlavor(executable, context) : undefined

  const provisional: OpenCodeState = {
    paths,
    config,
    configDocument,
    manifestSnapshot,
    ...(manifest ? { manifest } : {}),
    ...(currentEntry !== undefined ? { currentEntry } : {}),
    ...(currentEntryHash ? { currentEntryHash } : {}),
    desiredEntry,
    desiredEntryHash,
    baseUrl,
    ...(executable ? { opencodeExecutable: executable } : {}),
    ...(binary ? { binaryFlavor: binary } : {}),
    conflicts: [],
  }
  return { ...provisional, conflicts: openCodeConflicts(provisional, options) }
}

export async function openCodeSetupPaths(
  context: HostSetupContext,
  options: SetupRequestOptions,
): Promise<OpenCodeSetupPaths> {
  const selection = await openCodeConfigSelection(context, options)
  const projectDir = path.resolve(options.projectDir)
  return {
    configFile: selection.selected,
    configCandidates: selection.candidates,
    existingConfigFiles: selection.existing,
    setupManifestFile: options.scope === 'user'
      ? path.join(context.homeDir, '.flowit-workflow', 'setup', 'opencode-user.json')
      : path.join(projectDir, '.flowit-workflow', 'setup', 'opencode.json'),
    mcpServerFile: path.join(context.packageRoot, 'dist', 'mcp-server.js'),
  }
}

export function openCodeMcpEntry(
  context: HostSetupContext,
  paths: OpenCodeSetupPaths,
  baseUrl = openCodeBaseUrl(context),
): Readonly<Record<string, unknown>> {
  const environment: Record<string, string> = {
    FLOWIT_WORKFLOW_ADAPTER: OPENCODE_SETUP_HOST_ID,
    FLOWIT_WORKFLOW_MUTATIONS: '1',
    FLOWIT_WORKFLOW_OPENCODE_URL: baseUrl,
  }
  const explicitBinary = context.env.FLOWIT_WORKFLOW_OPENCODE_BIN?.trim()
  if (explicitBinary) environment.FLOWIT_WORKFLOW_OPENCODE_BIN = explicitBinary
  return {
    type: 'local',
    command: [process.execPath, paths.mcpServerFile],
    disabled: false,
    environment,
  }
}

export function openCodeBaseUrl(context: HostSetupContext): string {
  const raw = context.env.FLOWIT_WORKFLOW_OPENCODE_URL?.trim() || OPENCODE_DEFAULT_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`FLOWIT_WORKFLOW_OPENCODE_URL must be an absolute HTTP(S) URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('FLOWIT_WORKFLOW_OPENCODE_URL must use http or https')
  }
  if (url.username || url.password) {
    throw new Error('FLOWIT_WORKFLOW_OPENCODE_URL must not embed credentials; use a separately secured server endpoint')
  }
  return url.toString().replace(/\/$/, '')
}

export function openCodeDoctorChecks(
  options: SetupRequestOptions,
  state: OpenCodeState,
): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  if (state.opencodeExecutable) {
    checks.push({
      id: 'opencode-executable',
      status: state.binaryFlavor === 'legacy' ? 'warning' : 'ok',
      summary: state.binaryFlavor === 'legacy'
        ? `OpenCode executable ${state.opencodeExecutable} was found, but Flowit targets the V2 host contract; verify this binary exposes the V2 API`
        : `OpenCode executable detected at ${state.opencodeExecutable}`,
      repairable: false,
    })
  } else {
    checks.push({
      id: 'opencode-executable',
      status: 'warning',
      summary: 'OpenCode V2 executable was not found on PATH',
      repairable: false,
    })
  }

  if (state.conflicts.length > 0) {
    checks.push({
      id: 'opencode-ownership',
      status: 'error',
      summary: 'OpenCode MCP ownership/configuration conflict detected',
      detail: state.conflicts.join(' '),
      repairable: false,
    })
  } else {
    checks.push({ id: 'opencode-ownership', status: 'ok', summary: 'OpenCode MCP ownership is consistent' })
  }

  checks.push(state.currentEntryHash === state.desiredEntryHash
    ? { id: 'opencode-mcp', status: 'ok', summary: 'Flowit OpenCode V2 MCP entry matches the current installation' }
    : {
        id: 'opencode-mcp',
        status: 'error',
        summary: state.manifest
          ? 'Installer-owned OpenCode MCP entry is missing or needs an update'
          : 'Flowit OpenCode MCP entry is not installed',
        repairable: state.conflicts.length === 0,
      })

  checks.push({
    id: 'opencode-url',
    status: 'ok',
    summary: `Flowit will connect to OpenCode at ${state.baseUrl}`,
  })

  if (options.scope === 'project') {
    checks.push({
      id: 'opencode-project-config',
      status: 'warning',
      summary: 'Project OpenCode configuration has higher precedence and is active only when OpenCode is launched for that project',
      repairable: false,
    })
  }
  return checks
}

export function openCodeManualSteps(
  options: SetupRequestOptions,
  state: OpenCodeState,
  serverReachable?: boolean,
): string[] {
  const steps: string[] = []
  if (!state.opencodeExecutable) {
    steps.push('Install OpenCode V2 (or set FLOWIT_WORKFLOW_OPENCODE_BIN), then rerun `flowit-workflow doctor opencode`.')
  }
  if (serverReachable === false) {
    const command = state.opencodeExecutable ?? 'opencode2'
    const url = new URL(state.baseUrl)
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
      const port = url.port || '80'
      steps.push(
        `Start a compatible OpenCode V2 HTTP server at ${state.baseUrl}, for example: ${command} serve --hostname ${url.hostname} --port ${port}`,
      )
    } else {
      steps.push(`Ensure a compatible OpenCode V2 HTTP server is reachable at ${state.baseUrl}.`)
    }
  }
  steps.push(`Start/restart the Flowit daemon with FLOWIT_WORKFLOW_OPENCODE_URL=${state.baseUrl}.`)
  if (options.scope === 'project') {
    steps.push('Launch OpenCode from the project so its project configuration layer is active.')
  }
  steps.push('Restart/reload OpenCode after setup so the MCP configuration is reconciled.')
  return steps
}

export function isInstallerOnlyOpenCodeConfig(source: string): boolean {
  const document = parseJsoncDocument(source)
  const value = jsoncSemanticValue(document)
  const allowedRoot = new Set(['$schema', 'mcp'])
  if (Object.keys(value).some(key => !allowedRoot.has(key))) return false
  if (value.$schema !== undefined && value.$schema !== OPENCODE_CONFIG_SCHEMA) return false
  if (value.mcp === undefined) return true
  if (!isRecord(value.mcp)) return false
  const mcpKeys = Object.keys(value.mcp)
  if (mcpKeys.some(key => key !== 'servers')) return false
  if (value.mcp.servers === undefined) return true
  return isRecord(value.mcp.servers) && Object.keys(value.mcp.servers).length === 0
}

export function semanticHash(value: unknown): string {
  return digest(canonicalJson(value))
}

export async function findOpenCodeExecutable(context: HostSetupContext): Promise<string | undefined> {
  const explicit = context.env.FLOWIT_WORKFLOW_OPENCODE_BIN?.trim()
  if (explicit) {
    if (path.isAbsolute(explicit) || explicit.includes(path.sep)) {
      const resolved = path.resolve(explicit)
      return await executableExists(resolved) ? resolved : undefined
    }
    return findOnPath(explicit, context)
  }
  return (await findOnPath('opencode2', context)) ?? findOnPath('opencode', context)
}

function openCodeConflicts(state: OpenCodeState, options: SetupRequestOptions): string[] {
  const conflicts: string[] = []
  if (state.paths.existingConfigFiles.length > 1) {
    conflicts.push(
      `Multiple OpenCode config files are present for ${options.scope} scope (${state.paths.existingConfigFiles.join(', ')}); automatic setup will not guess which layer should own Flowit.`,
    )
  }

  const legacy = jsoncPropertyValue(state.configDocument, ['mcp', OPENCODE_MCP_SERVER])
  if (legacy !== undefined) {
    conflicts.push(
      `OpenCode config ${state.paths.configFile} contains a legacy mcp.${OPENCODE_MCP_SERVER} entry; remove or migrate it before installing the V2 mcp.servers entry.`,
    )
  }

  if (state.currentEntry !== undefined && !state.manifest) {
    conflicts.push(
      `OpenCode config ${state.paths.configFile} already contains mcp.servers.${OPENCODE_MCP_SERVER} without a Flowit ownership manifest; automatic setup will not adopt or overwrite it.`,
    )
  }

  if (state.manifest) {
    if (
      state.manifest.hostId !== OPENCODE_SETUP_HOST_ID
      || state.manifest.scope !== options.scope
      || state.manifest.configFile !== state.paths.configFile
    ) {
      conflicts.push('The OpenCode setup ownership manifest does not match the requested scope/config path.')
    } else if (state.currentEntryHash && state.currentEntryHash !== state.manifest.entryHash) {
      conflicts.push('The installer-owned OpenCode MCP entry was modified after setup.')
    }
  }
  return conflicts
}

async function openCodeConfigSelection(
  context: HostSetupContext,
  options: SetupRequestOptions,
): Promise<{ selected: string; candidates: string[]; existing: string[] }> {
  const candidates = openCodeConfigCandidates(context, options)
  const present = await Promise.all(candidates.map(async file => ({ file, exists: await pathExists(file) })))
  const existing = present.filter(row => row.exists).map(row => row.file)
  return { selected: existing[0] ?? candidates[0]!, candidates, existing }
}

function openCodeConfigCandidates(context: HostSetupContext, options: SetupRequestOptions): string[] {
  const projectDir = path.resolve(options.projectDir)
  if (options.scope === 'project') {
    return [
      path.join(projectDir, 'opencode.jsonc'),
      path.join(projectDir, 'opencode.json'),
      path.join(projectDir, '.opencode', 'opencode.jsonc'),
      path.join(projectDir, '.opencode', 'opencode.json'),
    ]
  }

  const explicit = context.env.OPENCODE_CONFIG?.trim()
  if (explicit) return [path.resolve(context.cwd, explicit)]
  const xdg = context.env.XDG_CONFIG_HOME?.trim()
  const configHome = xdg ? path.resolve(context.cwd, xdg) : path.join(context.homeDir, '.config')
  return [
    path.join(configHome, 'opencode', 'opencode.jsonc'),
    path.join(configHome, 'opencode', 'opencode.json'),
  ]
}

function parseOpenCodeSetupManifest(
  snapshot: TextSnapshot,
  file: string,
): OpenCodeSetupManifest | undefined {
  if (!snapshot.exists) return undefined
  let value: unknown
  try {
    value = JSON.parse(snapshot.content ?? '')
  } catch (error: unknown) {
    throw new Error(`invalid OpenCode setup ownership manifest ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(value)) throw new Error(`invalid OpenCode setup ownership manifest ${file}`)
  if (
    value.version !== OPENCODE_SETUP_MANIFEST_VERSION
    || value.hostId !== OPENCODE_SETUP_HOST_ID
    || (value.scope !== 'user' && value.scope !== 'project')
    || typeof value.projectDir !== 'string'
    || typeof value.configFile !== 'string'
    || typeof value.entryHash !== 'string'
    || typeof value.configExistedBefore !== 'boolean'
    || typeof value.baseUrl !== 'string'
    || typeof value.installedAt !== 'string'
  ) throw new Error(`invalid OpenCode setup ownership manifest ${file}`)
  return value as unknown as OpenCodeSetupManifest
}

function executableFlavor(file: string, context: HostSetupContext): 'v2' | 'legacy' | 'explicit' {
  if (context.env.FLOWIT_WORKFLOW_OPENCODE_BIN?.trim()) return 'explicit'
  return /^opencode2(?:\.|$)/i.test(path.basename(file)) ? 'v2' : 'legacy'
}

async function findOnPath(name: string, context: HostSetupContext): Promise<string | undefined> {
  const pathValue = context.env.PATH ?? context.env.Path ?? context.env.path
  if (!pathValue) return undefined
  const extensions = context.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`)
      if (await executableExists(candidate)) return candidate
    }
  }
  return undefined
}

async function executableExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const rows = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${rows.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
