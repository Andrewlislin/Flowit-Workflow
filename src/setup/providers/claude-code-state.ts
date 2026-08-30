import { access, mkdir, readFile } from 'node:fs/promises'
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

export const CLAUDE_CODE_SETUP_HOST_ID = 'claude-code'
export const CLAUDE_CODE_SETUP_DISPLAY_NAME = 'Claude Code'
export const CLAUDE_CODE_PLUGIN_NAME = 'flowit-workflow'
export const CLAUDE_CODE_SETUP_MANIFEST_VERSION = 1

export const CLAUDE_CODE_MANAGED_FILES = [
  '.claude-plugin/plugin.json',
  'skills/run-bound/SKILL.md',
  'skills/orchestrate/SKILL.md',
  'skills/route/SKILL.md',
  'hooks/hooks.json',
  '.mcp.json',
] as const
export type ClaudeCodeManagedFile = (typeof CLAUDE_CODE_MANAGED_FILES)[number]

export interface ClaudeCodeSetupPaths {
  readonly pluginRoot: string
  readonly setupManifestFile: string
  readonly stateRoot: string
  readonly packageManifestFile: string
  readonly sourcePluginManifestFile: string
  readonly sourceRunBoundSkillFile: string
  readonly sourceOrchestrateSkillFile: string
  readonly sourceRouteSkillFile: string
  readonly mcpServerFile: string
  readonly cliFile: string
}

export interface ClaudeCodeSetupManifest {
  readonly version: 1
  readonly hostId: 'claude-code'
  readonly scope: 'user' | 'project'
  readonly projectDir: string
  readonly pluginRoot: string
  readonly ownedFiles: Readonly<Record<string, string>>
  readonly installedAt: string
}

export interface ClaudeCodeManagedFileState {
  readonly relativePath: ClaudeCodeManagedFile
  readonly file: string
  readonly current: TextSnapshot
  readonly desiredContent: string
  readonly desiredHash: string
  readonly ownedHash?: string
}

export interface ClaudeCodeState {
  readonly paths: ClaudeCodeSetupPaths
  readonly manifest?: ClaudeCodeSetupManifest
  readonly files: readonly ClaudeCodeManagedFileState[]
  readonly pluginRootExists: boolean
  readonly stateRootExists: boolean
  readonly claudeExecutable?: string
  readonly conflicts: readonly string[]
}

export async function detectClaudeCode(context: HostSetupContext): Promise<boolean> {
  if (await findClaudeExecutable(context)) return true
  if (await pathExists(path.join(context.homeDir, '.claude'))) return true
  return pathExists(path.join(context.cwd, '.claude'))
}

export async function inspectClaudeCodeState(
  context: HostSetupContext,
  options: SetupRequestOptions,
): Promise<ClaudeCodeState> {
  if (options.scope === 'project') await assertDirectory(options.projectDir)
  const paths = claudeCodeSetupPaths(context, options)
  await Promise.all([
    assertReadable(paths.packageManifestFile, 'Flowit package manifest'),
    assertReadable(paths.sourcePluginManifestFile, 'packaged Claude Code plugin manifest'),
    assertReadable(paths.sourceRunBoundSkillFile, 'packaged Claude run-bound Skill'),
    assertReadable(paths.sourceOrchestrateSkillFile, 'packaged Claude orchestrate Skill'),
    assertReadable(paths.sourceRouteSkillFile, 'packaged Claude adaptive routing Skill'),
    assertReadable(paths.mcpServerFile, 'Flowit MCP server build artifact'),
    assertReadable(paths.cliFile, 'Flowit CLI build artifact'),
  ])

  const [manifest, desired, pluginRootExists, stateRootExists, claudeExecutable] = await Promise.all([
    readClaudeSetupManifest(paths.setupManifestFile),
    desiredClaudePluginFiles(paths),
    pathExists(paths.pluginRoot),
    pathExists(paths.stateRoot),
    findClaudeExecutable(context),
  ])
  const files = await Promise.all(CLAUDE_CODE_MANAGED_FILES.map(async relativePath => {
    const file = path.join(paths.pluginRoot, ...relativePath.split('/'))
    const current = await readTextSnapshot(file)
    const desiredContent = desired[relativePath]
    const ownedHash = manifest?.ownedFiles[relativePath]
    return {
      relativePath,
      file,
      current,
      desiredContent,
      desiredHash: digest(desiredContent),
      ...(ownedHash ? { ownedHash } : {}),
    } satisfies ClaudeCodeManagedFileState
  }))

  const provisional: ClaudeCodeState = {
    paths,
    ...(manifest ? { manifest } : {}),
    files,
    pluginRootExists,
    stateRootExists,
    ...(claudeExecutable ? { claudeExecutable } : {}),
    conflicts: [],
  }
  return { ...provisional, conflicts: claudeCodeConflicts(provisional, options) }
}

export function claudeCodeSetupPaths(
  context: HostSetupContext,
  options: SetupRequestOptions,
): ClaudeCodeSetupPaths {
  const projectDir = path.resolve(options.projectDir)
  const skillsRoot = options.scope === 'user'
    ? path.join(context.homeDir, '.claude', 'skills')
    : path.join(projectDir, '.claude', 'skills')
  return {
    pluginRoot: path.join(skillsRoot, CLAUDE_CODE_PLUGIN_NAME),
    setupManifestFile: options.scope === 'user'
      ? path.join(context.homeDir, '.flowit-workflow', 'setup', 'claude-code-user.json')
      : path.join(projectDir, '.flowit-workflow', 'setup', 'claude-code.json'),
    stateRoot: path.join(context.homeDir, '.flowit-workflow', 'claude'),
    packageManifestFile: path.join(context.packageRoot, 'package.json'),
    sourcePluginManifestFile: path.join(context.packageRoot, '.claude-plugin', 'plugin.json'),
    sourceRunBoundSkillFile: path.join(context.packageRoot, 'skills', 'run-bound', 'SKILL.md'),
    sourceOrchestrateSkillFile: path.join(context.packageRoot, 'skills', 'orchestrate', 'SKILL.md'),
    sourceRouteSkillFile: path.join(context.packageRoot, 'skills', 'route', 'SKILL.md'),
    mcpServerFile: path.join(context.packageRoot, 'dist', 'mcp-server.js'),
    cliFile: path.join(context.packageRoot, 'dist', 'cli.js'),
  }
}

export function claudeCodeManualSteps(
  options: SetupRequestOptions,
  state: ClaudeCodeState,
): string[] {
  const steps: string[] = []
  if (!state.claudeExecutable) {
    steps.push('Install/authenticate Claude Code, then rerun `flowit-workflow doctor claude-code`.')
  }
  if (options.scope === 'project') {
    steps.push(
      'Launch Claude Code from the project root and accept its workspace-trust and project MCP approval prompts. Flowit does not bypass Claude Code host security gates.',
    )
  }
  steps.push('Restart Claude Code or run `/reload-plugins` so the installed plugin components are loaded.')
  return steps
}

export function claudeCodeDoctorChecks(
  options: SetupRequestOptions,
  state: ClaudeCodeState,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    state.claudeExecutable
      ? {
          id: 'claude-executable',
          status: 'ok',
          summary: `Claude Code executable detected at ${state.claudeExecutable}`,
        }
      : {
          id: 'claude-executable',
          status: 'warning',
          summary: 'Claude Code executable was not found on PATH',
          repairable: false,
        },
  ]
  checks.push(state.conflicts.length
    ? {
        id: 'claude-ownership',
        status: 'error',
        summary: 'Claude Code plugin ownership/configuration conflict detected',
        detail: state.conflicts.join(' '),
        repairable: false,
      }
    : {
        id: 'claude-ownership',
        status: 'ok',
        summary: 'Claude Code plugin ownership is consistent',
      })

  for (const file of state.files) {
    checks.push(file.current.hash === file.desiredHash
      ? {
          id: `plugin:${file.relativePath}`,
          status: 'ok',
          summary: `${file.relativePath} matches the packaged Flowit plugin`,
        }
      : {
          id: `plugin:${file.relativePath}`,
          status: 'error',
          summary: `${file.relativePath} is missing or differs from the packaged Flowit plugin`,
          repairable: Boolean(file.ownedHash) || !file.current.exists,
        })
  }
  checks.push(state.stateRootExists
    ? {
        id: 'claude-state-root',
        status: 'ok',
        summary: 'Claude durable state directory exists',
      }
    : {
        id: 'claude-state-root',
        status: 'warning',
        summary: 'Claude durable state directory has not been initialized',
        repairable: true,
      })
  if (options.scope === 'project') {
    checks.push({
      id: 'claude-project-trust',
      status: 'warning',
      summary: 'Project-scope skills-directory plugins remain subject to Claude Code workspace trust and MCP approval',
      repairable: false,
    })
  }
  return checks
}

export function desiredOwnedFilesAfterPlan(
  state: ClaudeCodeState,
  actionIds: ReadonlySet<string>,
): Record<string, string> {
  const owned: Record<string, string> = { ...(state.manifest?.ownedFiles ?? {}) }
  for (const file of state.files) {
    if (actionIds.has(actionIdFor(file.relativePath)) || file.ownedHash) {
      owned[file.relativePath] = file.desiredHash
    }
  }
  return owned
}

export function actionIdFor(relativePath: ClaudeCodeManagedFile): string {
  return `write:${relativePath}`
}

export async function ensureClaudeStateRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
}

function claudeCodeConflicts(
  state: ClaudeCodeState,
  options: SetupRequestOptions,
): string[] {
  const conflicts: string[] = []
  if (state.pluginRootExists && !state.manifest) {
    conflicts.push(
      `Claude Code plugin root ${state.paths.pluginRoot} already exists without a Flowit ownership manifest; automatic setup will not adopt or overwrite it.`,
    )
    return conflicts
  }
  if (state.manifest && (
    state.manifest.hostId !== CLAUDE_CODE_SETUP_HOST_ID ||
    state.manifest.scope !== options.scope ||
    state.manifest.pluginRoot !== state.paths.pluginRoot
  )) {
    conflicts.push('The Claude Code setup ownership manifest does not match the requested scope/plugin root.')
    return conflicts
  }
  for (const file of state.files) {
    if (!file.current.exists) continue
    if (!file.ownedHash) {
      conflicts.push(`Managed Claude plugin file ${file.file} exists but is not recorded as installer-owned.`)
    } else if (file.current.hash !== file.ownedHash) {
      conflicts.push(`Installer-owned Claude plugin file ${file.file} was modified after setup.`)
    }
  }
  return conflicts
}

async function desiredClaudePluginFiles(
  paths: ClaudeCodeSetupPaths,
): Promise<Record<ClaudeCodeManagedFile, string>> {
  const [packageRaw, pluginRaw, runBound, orchestrate, route] = await Promise.all([
    readFile(paths.packageManifestFile, 'utf8'),
    readFile(paths.sourcePluginManifestFile, 'utf8'),
    readFile(paths.sourceRunBoundSkillFile, 'utf8'),
    readFile(paths.sourceOrchestrateSkillFile, 'utf8'),
    readFile(paths.sourceRouteSkillFile, 'utf8'),
  ])
  const packageManifest = parseJsonObject(packageRaw, paths.packageManifestFile)
  const sourcePlugin = parseJsonObject(pluginRaw, paths.sourcePluginManifestFile)
  const version = packageManifest.version
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Flowit package version is missing')
  }

  const pluginManifest = { ...sourcePlugin, name: CLAUDE_CODE_PLUGIN_NAME, version }
  const routingAuthorityDir = path.join(paths.stateRoot, 'routing-authority')
  const mcp = {
    mcpServers: {
      orchestration: {
        command: process.execPath,
        args: [paths.mcpServerFile],
        env: {
          FLOWIT_WORKFLOW_ADAPTER: 'claude-code',
          FLOWIT_WORKFLOW_PLUGIN_ROOT: paths.pluginRoot,
          FLOWIT_WORKFLOW_CLAUDE_MUTATIONS: '1',
          FLOWIT_WORKFLOW_CLAUDE_ALLOW_LIVE_RESUME: '0',
          FLOWIT_WORKFLOW_ROUTING_MODE: 'suggest',
          FLOWIT_WORKFLOW_ROUTING_AUTHORITY_DIR: routingAuthorityDir,
          FLOWIT_WORKFLOW_ROUTING_REQUIRE_CALLER_ATTESTATION: '1',
        },
      },
    },
  }
  const hookEntry = {
    hooks: [{
      type: 'command',
      command: process.execPath,
      args: [paths.cliFile, 'claude-hook'],
      timeout: 10,
    }],
  }
  const routingHookEntry = {
    hooks: [{
      type: 'command',
      command: process.execPath,
      args: [paths.cliFile, 'claude-routing-hook'],
      timeout: 10,
    }],
  }
  const hooks = {
    hooks: {
      UserPromptSubmit: [routingHookEntry],
      PreToolUse: [{
        matcher:
          'mcp__orchestration__(workflow_assess|workflow_prepare|workflow_commit)',
        ...routingHookEntry,
      }],
      SessionStart: [hookEntry],
      Stop: [hookEntry],
      StopFailure: [hookEntry],
      TaskCompleted: [hookEntry],
      SubagentStop: [hookEntry],
      SessionEnd: [hookEntry],
    },
  }
  return {
    '.claude-plugin/plugin.json': `${JSON.stringify(pluginManifest, null, 2)}\n`,
    'skills/run-bound/SKILL.md': runBound,
    'skills/orchestrate/SKILL.md': orchestrate,
    'skills/route/SKILL.md': route,
    'hooks/hooks.json': `${JSON.stringify(hooks, null, 2)}\n`,
    '.mcp.json': `${JSON.stringify(mcp, null, 2)}\n`,
  }
}

async function readClaudeSetupManifest(
  file: string,
): Promise<ClaudeCodeSetupManifest | undefined> {
  try {
    const value = parseJsonObject(await readFile(file, 'utf8'), file)
    if (
      value.version !== CLAUDE_CODE_SETUP_MANIFEST_VERSION ||
      value.hostId !== CLAUDE_CODE_SETUP_HOST_ID ||
      (value.scope !== 'user' && value.scope !== 'project') ||
      typeof value.projectDir !== 'string' ||
      typeof value.pluginRoot !== 'string' ||
      !isRecord(value.ownedFiles) ||
      Object.values(value.ownedFiles).some(hash => typeof hash !== 'string') ||
      typeof value.installedAt !== 'string'
    ) {
      throw new Error(`invalid Claude Code setup ownership manifest ${file}`)
    }
    return value as unknown as ClaudeCodeSetupManifest
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parseJsonObject(raw: string, file: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error: unknown) {
    throw new Error(
      `invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isRecord(value)) throw new Error(`${file} must contain a JSON object`)
  return value
}

async function findClaudeExecutable(context: HostSetupContext): Promise<string | undefined> {
  const explicit = context.env.FLOWIT_WORKFLOW_CLAUDE_BIN?.trim()
  if (explicit) return await executableExists(explicit) ? path.resolve(explicit) : undefined
  const pathValue = context.env.PATH ?? context.env.Path ?? context.env.path
  if (!pathValue) return undefined
  const extensions = context.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `claude${extension}`)
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
