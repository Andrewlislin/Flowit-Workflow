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

export const DSH_SETUP_HOST_ID = 'dsh'
export const DSH_SETUP_DISPLAY_NAME = 'DeepSeek Harness'
export const DSH_SETUP_MANIFEST_VERSION = 1
export const DSH_BLOCK_BEGIN = '# >>> flowit-workflow setup dsh v1'
export const DSH_BLOCK_END = '# <<< flowit-workflow setup dsh v1'

export interface DshSetupPaths {
  readonly dshHome: string
  readonly patchFile: string
  readonly setupManifestFile: string
  readonly pluginFile: string
  readonly storageFile: string
}

export interface DshSetupManifest {
  readonly version: 1
  readonly hostId: 'dsh'
  readonly scope: 'user' | 'project'
  readonly projectDir: string
  readonly patchFile: string
  readonly blockHash: string
  readonly patchExistedBefore: boolean
  readonly storageFile: string
  readonly installedAt: string
}

export interface DshManagedBlock {
  readonly start: number
  readonly end: number
  readonly content: string
  readonly hash: string
}

export interface DshState {
  readonly paths: DshSetupPaths
  readonly patch: TextSnapshot
  readonly manifestSnapshot: TextSnapshot
  readonly manifest?: DshSetupManifest
  readonly managedBlock?: DshManagedBlock
  readonly desiredBlock: string
  readonly desiredBlockHash: string
  readonly dshExecutable?: string
  readonly conflicts: readonly string[]
}

export async function detectDsh(context: HostSetupContext): Promise<boolean> {
  if (await findDshExecutable(context)) return true
  if (await pathExists(dshHome(context))) return true
  if (await pathExists(path.join(context.cwd, 'cordis.yml'))) return true
  if (await pathExists(path.join(context.cwd, 'cordis.patch.yml'))) return true
  return pathExists(path.join(context.cwd, 'node_modules', '@deepseek-ai', 'dsh'))
}

export async function inspectDshState(
  context: HostSetupContext,
  options: SetupRequestOptions,
): Promise<DshState> {
  if (options.scope === 'project') await assertDirectory(options.projectDir)
  const paths = dshSetupPaths(context, options)
  await assertReadable(paths.pluginFile, 'Flowit DeepSeek Harness plugin build artifact')

  const [patch, manifestSnapshot, dshExecutable] = await Promise.all([
    readTextSnapshot(paths.patchFile),
    readTextSnapshot(paths.setupManifestFile),
    findDshExecutable(context, options.projectDir),
  ])
  const manifest = parseDshSetupManifest(manifestSnapshot, paths.setupManifestFile)
  const source = patch.content ?? ''
  validateDshPatchShape(source, paths.patchFile)
  const managedBlock = extractDshManagedBlock(source)
  const desiredBlock = renderDshManagedBlock(paths)
  const desiredBlockHash = digest(desiredBlock)

  const provisional: DshState = {
    paths,
    patch,
    manifestSnapshot,
    ...(manifest ? { manifest } : {}),
    ...(managedBlock ? { managedBlock } : {}),
    desiredBlock,
    desiredBlockHash,
    ...(dshExecutable ? { dshExecutable } : {}),
    conflicts: [],
  }
  return { ...provisional, conflicts: dshConflicts(provisional, options) }
}

export function dshSetupPaths(
  context: HostSetupContext,
  options: SetupRequestOptions,
): DshSetupPaths {
  const projectDir = path.resolve(options.projectDir)
  const home = dshHome(context)
  const projectRoot = path.join(projectDir, '.flowit-workflow', 'dsh')
  return {
    dshHome: home,
    patchFile: options.scope === 'user'
      ? path.join(home, 'cordis.patch.yml')
      : path.join(projectRoot, 'cordis.patch.yml'),
    setupManifestFile: options.scope === 'user'
      ? path.join(context.homeDir, '.flowit-workflow', 'setup', 'dsh-user.json')
      : path.join(projectDir, '.flowit-workflow', 'setup', 'dsh.json'),
    pluginFile: path.join(context.packageRoot, 'dist', 'dsh', 'plugin.js'),
    storageFile: options.scope === 'user'
      ? path.join(context.homeDir, '.flowit-workflow', 'dsh', 'workflow.json')
      : path.join(projectRoot, 'workflow.json'),
  }
}

export function renderDshManagedBlock(paths: DshSetupPaths): string {
  return [
    DSH_BLOCK_BEGIN,
    '- insert:',
    '    - id: flowit-workflow',
    `      name: ${yamlString(paths.pluginFile)}`,
    '      config:',
    `        storageFile: ${yamlString(paths.storageFile)}`,
    '        minimumIntervalSeconds: 60',
    '        allowModelMutations: true',
    '        maxRunHistory: 500',
    DSH_BLOCK_END,
    '',
  ].join('\n')
}

export function dshDoctorChecks(
  options: SetupRequestOptions,
  state: DshState,
): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  checks.push(state.dshExecutable
    ? { id: 'dsh-executable', status: 'ok', summary: `DeepSeek Harness executable detected at ${state.dshExecutable}` }
    : {
        id: 'dsh-executable',
        status: 'warning',
        summary: 'DeepSeek Harness executable was not found; the patch can still be staged for npx/package-local use',
        repairable: false,
      })

  if (state.conflicts.length > 0) {
    checks.push({
      id: 'dsh-ownership',
      status: 'error',
      summary: 'DeepSeek Harness patch ownership/configuration conflict detected',
      detail: state.conflicts.join(' '),
      repairable: false,
    })
  } else {
    checks.push({ id: 'dsh-ownership', status: 'ok', summary: 'DeepSeek Harness patch ownership is consistent' })
  }

  checks.push(state.managedBlock?.hash === state.desiredBlockHash
    ? { id: 'dsh-plugin', status: 'ok', summary: 'Flowit native DSH plugin patch matches the current installation' }
    : {
        id: 'dsh-plugin',
        status: 'error',
        summary: state.manifest
          ? 'Installer-owned DSH plugin patch is missing or needs an update'
          : 'Flowit native DSH plugin patch is not installed',
        repairable: state.conflicts.length === 0,
      })

  if (options.scope === 'user') {
    checks.push({
      id: 'dsh-patch-layer',
      status: 'ok',
      summary: `Using the persistent Harness home patch layer ${state.paths.patchFile}`,
    })
  } else {
    checks.push({
      id: 'dsh-patch-layer',
      status: 'warning',
      summary: 'Project-scoped DSH integration is a runtime --patch overlay because Harness has no project-local persistent patch layer',
      repairable: false,
    })
  }
  return checks
}

export function dshManualSteps(
  options: SetupRequestOptions,
  state: DshState,
): string[] {
  const command = state.dshExecutable ?? 'npx @deepseek-ai/dsh'
  const steps: string[] = []
  if (options.scope === 'project') {
    steps.push(
      `Launch DeepSeek Harness with the generated project overlay, for example: ${command} web --patch ${quoteShell(state.paths.patchFile)}`,
    )
    steps.push(
      `For headless runs, add the same overlay: ${command} --profile headless --patch ${quoteShell(state.paths.patchFile)} "<task>"`,
    )
  } else {
    steps.push('Restart DeepSeek Harness so the updated $DSH_HOME/cordis.patch.yml home layer is recomposed.')
  }
  steps.push(`Verify composition without booting the app: ${command} --profile web --dump-config`)
  return steps
}

export function extractDshManagedBlock(content: string): DshManagedBlock | undefined {
  const starts = markerPositions(content, DSH_BLOCK_BEGIN)
  const ends = markerPositions(content, DSH_BLOCK_END)
  if (starts.length === 0 && ends.length === 0) return undefined
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! <= starts[0]!) {
    throw new Error('DeepSeek Harness patch contains malformed or duplicate Flowit ownership markers')
  }
  const start = starts[0]!
  const end = lineEnd(content, ends[0]! + DSH_BLOCK_END.length)
  const block = content.slice(start, end)
  return { start, end, content: block, hash: digest(block) }
}

export function hasForeignDshFlowitEntry(content: string): boolean {
  const block = extractDshManagedBlock(content)
  const remaining = block ? content.slice(0, block.start) + content.slice(block.end) : content
  for (const rawLine of remaining.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (/^(?:-\s*)?id:\s*["']?flowit-workflow["']?\s*(?:#.*)?$/i.test(line)) return true
    if (/^name:\s*.*(?:flowit-adapter-dsh|flowit-workflow).*$/i.test(line)) return true
  }
  return false
}

export function upsertDshManagedBlock(content: string, blockContent: string): string {
  const block = extractDshManagedBlock(content)
  if (block) return content.slice(0, block.start) + blockContent + content.slice(block.end)
  if (hasForeignDshFlowitEntry(content)) {
    throw new Error('DeepSeek Harness patch already contains an unmanaged Flowit plugin entry')
  }
  if (!content) return blockContent
  const normalized = content.endsWith('\n') ? content : `${content}\n`
  return `${normalized}\n${blockContent}`
}

export function removeDshManagedBlock(content: string): string {
  const block = extractDshManagedBlock(content)
  if (!block) return content
  let before = content.slice(0, block.start)
  let after = content.slice(block.end)
  if (before.endsWith('\n\n') && after.startsWith('\n')) after = after.slice(1)
  if (before.endsWith('\n\n') && !after) before = before.slice(0, -1)
  return before + after
}

export async function findDshExecutable(
  context: HostSetupContext,
  projectDir = context.cwd,
): Promise<string | undefined> {
  const explicit = context.env.FLOWIT_WORKFLOW_DSH_BIN?.trim()
  if (explicit) {
    if (path.isAbsolute(explicit) || explicit.includes(path.sep)) {
      const resolved = path.resolve(context.cwd, explicit)
      return await executableExists(resolved) ? resolved : undefined
    }
    return findOnPath(explicit, context)
  }

  const projectBin = path.join(path.resolve(projectDir), 'node_modules', '.bin')
  const local = await findExecutableInDirectory('dsh', projectBin, context)
  if (local) return local
  return findOnPath('dsh', context)
}

function dshConflicts(state: DshState, options: SetupRequestOptions): string[] {
  const conflicts: string[] = []
  if (hasForeignDshFlowitEntry(state.patch.content ?? '')) {
    conflicts.push(
      `DeepSeek Harness patch ${state.paths.patchFile} already contains an unmanaged Flowit plugin entry; automatic setup will not duplicate or replace it.`,
    )
  }
  if (state.managedBlock && !state.manifest) {
    conflicts.push(
      `DeepSeek Harness patch ${state.paths.patchFile} contains Flowit ownership markers without a setup ownership manifest; automatic setup will not adopt them.`,
    )
  }
  if (state.manifest) {
    if (
      state.manifest.hostId !== DSH_SETUP_HOST_ID
      || state.manifest.scope !== options.scope
      || state.manifest.patchFile !== state.paths.patchFile
      || state.manifest.storageFile !== state.paths.storageFile
    ) {
      conflicts.push('The DeepSeek Harness setup ownership manifest does not match the requested scope/patch path.')
    } else if (state.managedBlock && state.managedBlock.hash !== state.manifest.blockHash) {
      conflicts.push('The installer-owned DeepSeek Harness plugin patch was modified after setup.')
    }
  }
  return conflicts
}

function validateDshPatchShape(content: string, file: string): void {
  if (!content.trim()) return
  const block = extractDshManagedBlock(content)
  const remaining = block ? content.slice(0, block.start) + content.slice(block.end) : content
  for (const rawLine of remaining.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line === '---' || line === '...') continue
    if (!line.startsWith('-')) {
      throw new Error(
        `DeepSeek Harness patch ${file} is not a top-level YAML patch sequence; refusing to append Flowit configuration`,
      )
    }
    return
  }
}

function parseDshSetupManifest(
  snapshot: TextSnapshot,
  file: string,
): DshSetupManifest | undefined {
  if (!snapshot.exists) return undefined
  let value: unknown
  try {
    value = JSON.parse(snapshot.content ?? '')
  } catch (error: unknown) {
    throw new Error(`invalid DeepSeek Harness setup ownership manifest ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(value)) throw new Error(`invalid DeepSeek Harness setup ownership manifest ${file}`)
  if (
    value.version !== DSH_SETUP_MANIFEST_VERSION
    || value.hostId !== DSH_SETUP_HOST_ID
    || (value.scope !== 'user' && value.scope !== 'project')
    || typeof value.projectDir !== 'string'
    || typeof value.patchFile !== 'string'
    || typeof value.blockHash !== 'string'
    || typeof value.patchExistedBefore !== 'boolean'
    || typeof value.storageFile !== 'string'
    || typeof value.installedAt !== 'string'
  ) throw new Error(`invalid DeepSeek Harness setup ownership manifest ${file}`)
  return value as unknown as DshSetupManifest
}

function dshHome(context: HostSetupContext): string {
  const configured = context.env.DSH_HOME?.trim()
  return path.resolve(context.cwd, configured || path.join(context.homeDir, '.dsh'))
}

async function findOnPath(name: string, context: HostSetupContext): Promise<string | undefined> {
  const pathValue = context.env.PATH ?? context.env.Path ?? context.env.path
  if (!pathValue) return undefined
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const found = await findExecutableInDirectory(name, directory, context)
    if (found) return found
  }
  return undefined
}

async function findExecutableInDirectory(
  name: string,
  directory: string,
  context: HostSetupContext,
): Promise<string | undefined> {
  const extensions = context.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const extension of extensions) {
    const candidate = path.join(directory, `${name}${extension}`)
    if (await executableExists(candidate)) return candidate
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

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function quoteShell(value: string): string {
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
