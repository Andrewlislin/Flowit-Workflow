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

export const CODEX_SETUP_HOST_ID = 'codex'
export const CODEX_SETUP_DISPLAY_NAME = 'Codex'
export const CODEX_SETUP_MANIFEST_VERSION = 1
export const CODEX_MCP_SERVER = 'flowit-workflow'
export const CODEX_BLOCK_BEGIN = '# >>> flowit-workflow setup codex v1'
export const CODEX_BLOCK_END = '# <<< flowit-workflow setup codex v1'

export interface CodexSetupPaths {
  readonly codexHome: string
  readonly configFile: string
  readonly setupManifestFile: string
  readonly mcpServerFile: string
}

export interface CodexSetupManifest {
  readonly version: 1
  readonly hostId: 'codex'
  readonly scope: 'user' | 'project'
  readonly projectDir: string
  readonly configFile: string
  readonly blockHash: string
  readonly configExistedBefore: boolean
  readonly installedAt: string
}

export interface CodexManagedBlock {
  readonly start: number
  readonly end: number
  readonly content: string
  readonly hash: string
}

export interface CodexState {
  readonly paths: CodexSetupPaths
  readonly config: TextSnapshot
  readonly manifestSnapshot: TextSnapshot
  readonly manifest?: CodexSetupManifest
  readonly managedBlock?: CodexManagedBlock
  readonly desiredBlock: string
  readonly desiredBlockHash: string
  readonly codexExecutable?: string
  readonly conflicts: readonly string[]
}

export async function detectCodex(context: HostSetupContext): Promise<boolean> {
  if (await findCodexExecutable(context)) return true
  if (await pathExists(codexHome(context))) return true
  return pathExists(path.join(context.cwd, '.codex'))
}

export async function inspectCodexState(
  context: HostSetupContext,
  options: SetupRequestOptions,
): Promise<CodexState> {
  if (options.scope === 'project') await assertDirectory(options.projectDir)
  const paths = codexSetupPaths(context, options)
  await assertReadable(paths.mcpServerFile, 'Flowit MCP server build artifact')

  const [config, manifestSnapshot, codexExecutable] = await Promise.all([
    readTextSnapshot(paths.configFile),
    readTextSnapshot(paths.setupManifestFile),
    findCodexExecutable(context),
  ])
  const manifest = parseCodexSetupManifest(manifestSnapshot, paths.setupManifestFile)
  const raw = config.content ?? ''
  const managedBlock = extractCodexManagedBlock(raw)
  const desiredBlock = renderCodexManagedBlock(context, paths)
  const desiredBlockHash = digest(desiredBlock)

  const provisional: CodexState = {
    paths,
    config,
    manifestSnapshot,
    ...(manifest ? { manifest } : {}),
    ...(managedBlock ? { managedBlock } : {}),
    desiredBlock,
    desiredBlockHash,
    ...(codexExecutable ? { codexExecutable } : {}),
    conflicts: [],
  }
  return { ...provisional, conflicts: codexConflicts(provisional, options) }
}

export function codexSetupPaths(
  context: HostSetupContext,
  options: SetupRequestOptions,
): CodexSetupPaths {
  const projectDir = path.resolve(options.projectDir)
  const home = codexHome(context)
  return {
    codexHome: home,
    configFile: options.scope === 'user'
      ? path.join(home, 'config.toml')
      : path.join(projectDir, '.codex', 'config.toml'),
    setupManifestFile: options.scope === 'user'
      ? path.join(context.homeDir, '.flowit-workflow', 'setup', 'codex-user.json')
      : path.join(projectDir, '.flowit-workflow', 'setup', 'codex.json'),
    mcpServerFile: path.join(context.packageRoot, 'dist', 'mcp-server.js'),
  }
}

export function codexManualSteps(
  options: SetupRequestOptions,
  state: CodexState,
): string[] {
  const steps: string[] = []
  if (!state.codexExecutable) {
    steps.push('Install/authenticate Codex, then rerun `flowit-workflow doctor codex`.')
  }
  if (options.scope === 'project') {
    steps.push(
      'Open Codex from the project root and trust the project before relying on `.codex/config.toml`; Codex intentionally disables project-local config for untrusted directories.',
    )
  }
  steps.push('Restart Codex or start a new Codex thread so the MCP configuration is reloaded.')
  return steps
}

export function codexDoctorChecks(
  options: SetupRequestOptions,
  state: CodexState,
): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  checks.push(state.codexExecutable
    ? { id: 'codex-executable', status: 'ok', summary: `Codex executable detected at ${state.codexExecutable}` }
    : { id: 'codex-executable', status: 'warning', summary: 'Codex executable was not found on PATH', repairable: false })

  if (state.conflicts.length > 0) {
    checks.push({
      id: 'codex-ownership',
      status: 'error',
      summary: 'Codex MCP ownership/configuration conflict detected',
      detail: state.conflicts.join(' '),
      repairable: false,
    })
  } else {
    checks.push({ id: 'codex-ownership', status: 'ok', summary: 'Codex MCP ownership is consistent' })
  }

  if (state.managedBlock?.hash === state.desiredBlockHash) {
    checks.push({ id: 'codex-mcp', status: 'ok', summary: 'Flowit Codex MCP block matches the current installation' })
  } else if (state.manifest) {
    checks.push({
      id: 'codex-mcp',
      status: 'error',
      summary: state.managedBlock
        ? 'Installer-owned Codex MCP block needs an update'
        : 'Installer-owned Codex MCP block is missing',
      repairable: state.conflicts.length === 0,
    })
  } else {
    checks.push({
      id: 'codex-mcp',
      status: 'error',
      summary: 'Flowit Codex MCP block is not installed',
      repairable: state.conflicts.length === 0,
    })
  }

  if (options.scope === 'project') {
    checks.push({
      id: 'codex-project-trust',
      status: 'warning',
      summary: 'Project-local Codex config is loaded only for trusted projects',
      repairable: false,
    })
  }
  return checks
}

export function renderCodexManagedBlock(
  context: HostSetupContext,
  paths: CodexSetupPaths,
): string {
  const envRows = [
    `FLOWIT_WORKFLOW_ADAPTER = ${tomlString('codex')}`,
    `FLOWIT_WORKFLOW_MUTATIONS = ${tomlString('1')}`,
  ]
  const explicitCodex = context.env.FLOWIT_WORKFLOW_CODEX_BIN?.trim()
  if (explicitCodex) envRows.push(`FLOWIT_WORKFLOW_CODEX_BIN = ${tomlString(explicitCodex)}`)
  return [
    CODEX_BLOCK_BEGIN,
    `[mcp_servers.${CODEX_MCP_SERVER}]`,
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(paths.mcpServerFile)}]`,
    'enabled = true',
    '',
    `[mcp_servers.${CODEX_MCP_SERVER}.env]`,
    ...envRows,
    CODEX_BLOCK_END,
    '',
  ].join('\n')
}

export function extractCodexManagedBlock(content: string): CodexManagedBlock | undefined {
  const starts = markerPositions(content, CODEX_BLOCK_BEGIN)
  const ends = markerPositions(content, CODEX_BLOCK_END)
  if (starts.length === 0 && ends.length === 0) return undefined
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! <= starts[0]!) {
    throw new Error('Codex config contains malformed or duplicate Flowit ownership markers')
  }
  const start = starts[0]!
  const end = lineEnd(content, ends[0]! + CODEX_BLOCK_END.length)
  const block = content.slice(start, end)
  return { start, end, content: block, hash: digest(block) }
}

export function hasForeignCodexMcpTable(content: string): boolean {
  const block = extractCodexManagedBlock(content)
  const remaining = block ? content.slice(0, block.start) + content.slice(block.end) : content
  return /^\s*\[\s*mcp_servers\s*\.\s*(?:flowit-workflow|"flowit-workflow"|'flowit-workflow')\s*(?:\.[^\]]+)?\]\s*(?:#.*)?$/m.test(remaining)
}

export function upsertCodexManagedBlock(content: string, blockContent: string): string {
  const block = extractCodexManagedBlock(content)
  if (block) return content.slice(0, block.start) + blockContent + content.slice(block.end)
  if (hasForeignCodexMcpTable(content)) {
    throw new Error('Codex config already contains an unmanaged flowit-workflow MCP table')
  }
  if (!content) return blockContent
  const normalized = content.endsWith('\n') ? content : `${content}\n`
  return `${normalized}\n${blockContent}`
}

export function removeCodexManagedBlock(content: string): string {
  const block = extractCodexManagedBlock(content)
  if (!block) return content
  let before = content.slice(0, block.start)
  let after = content.slice(block.end)
  if (before.endsWith('\n\n') && after.startsWith('\n')) after = after.slice(1)
  if (!before.trim() && !after.trim()) return ''
  if (before.endsWith('\n\n') && !after) before = before.slice(0, -1)
  return before + after
}

export async function findCodexExecutable(context: HostSetupContext): Promise<string | undefined> {
  const explicit = context.env.FLOWIT_WORKFLOW_CODEX_BIN?.trim()
  if (explicit) {
    if (path.isAbsolute(explicit) || explicit.includes(path.sep)) {
      const resolved = path.resolve(explicit)
      return await executableExists(resolved) ? resolved : undefined
    }
    return findOnPath(explicit, context)
  }
  return findOnPath('codex', context)
}

function codexConflicts(state: CodexState, options: SetupRequestOptions): string[] {
  const conflicts: string[] = []
  const raw = state.config.content ?? ''
  if (hasForeignCodexMcpTable(raw)) {
    conflicts.push(
      `Codex config ${state.paths.configFile} already contains an unmanaged mcp_servers.${CODEX_MCP_SERVER} table; automatic setup will not replace it.`,
    )
  }
  if (state.managedBlock && !state.manifest) {
    conflicts.push(
      `Codex config ${state.paths.configFile} contains Flowit ownership markers without a setup ownership manifest; automatic setup will not adopt them.`,
    )
  }
  if (state.manifest) {
    if (
      state.manifest.hostId !== CODEX_SETUP_HOST_ID
      || state.manifest.scope !== options.scope
      || state.manifest.configFile !== state.paths.configFile
    ) {
      conflicts.push('The Codex setup ownership manifest does not match the requested scope/config path.')
    } else if (state.managedBlock && state.managedBlock.hash !== state.manifest.blockHash) {
      conflicts.push('The installer-owned Codex MCP block was modified after setup.')
    }
  }
  return conflicts
}

function parseCodexSetupManifest(
  snapshot: TextSnapshot,
  file: string,
): CodexSetupManifest | undefined {
  if (!snapshot.exists) return undefined
  let value: unknown
  try {
    value = JSON.parse(snapshot.content ?? '')
  } catch (error: unknown) {
    throw new Error(`invalid Codex setup ownership manifest ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(value)) throw new Error(`invalid Codex setup ownership manifest ${file}`)
  if (
    value.version !== CODEX_SETUP_MANIFEST_VERSION
    || value.hostId !== CODEX_SETUP_HOST_ID
    || (value.scope !== 'user' && value.scope !== 'project')
    || typeof value.projectDir !== 'string'
    || typeof value.configFile !== 'string'
    || typeof value.blockHash !== 'string'
    || typeof value.configExistedBefore !== 'boolean'
    || typeof value.installedAt !== 'string'
  ) throw new Error(`invalid Codex setup ownership manifest ${file}`)
  return value as unknown as CodexSetupManifest
}

function codexHome(context: HostSetupContext): string {
  const configured = context.env.CODEX_HOME?.trim()
  return path.resolve(configured || path.join(context.homeDir, '.codex'))
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

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function markerPositions(content: string, marker: string): number[] {
  const rows: number[] = []
  let offset = 0
  while (offset <= content.length) {
    const index = content.indexOf(marker, offset)
    if (index < 0) break
    const before = index === 0 ? '\n' : content[index - 1]
    const afterIndex = index + marker.length
    const after = afterIndex >= content.length ? '\n' : content[afterIndex]
    if (before === '\n' && (after === '\n' || after === '\r')) rows.push(index)
    offset = index + marker.length
  }
  return rows
}

function lineEnd(content: string, offset: number): number {
  const newline = content.indexOf('\n', offset)
  return newline < 0 ? content.length : newline + 1
}
