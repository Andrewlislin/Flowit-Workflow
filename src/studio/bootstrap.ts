import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { assertFlowitRuntimeRange } from './runtime-range.js'
import { intentAuthorizesStandardInstall, type StudioInstallIntent } from './trust.js'

const execFileAsync = promisify(execFile)
export const OFFICIAL_FLOWIT_NPM_PACKAGE = '@coaseedgeltd/flowit-workflow'
export const OFFICIAL_FLOWIT_NPM_REGISTRY = 'https://registry.npmjs.org/'
const OFFICIAL_SCOPE_REGISTRY_OPTION =
  `--@coaseedgeltd:registry=${OFFICIAL_FLOWIT_NPM_REGISTRY}`
const RUNTIME_ORIGIN_FILE = 'flowit-runtime-origin.json'

export interface BootstrapCommandResult {
  readonly stdout: string
  readonly stderr: string
}

export type BootstrapCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<BootstrapCommandResult>

export interface OfficialRuntimeResolverOptions {
  readonly homeDir?: string
  readonly npmCommand?: string
  readonly runCommand?: BootstrapCommandRunner
}

export interface ResolvedOfficialFlowitRuntime {
  readonly packageName: typeof OFFICIAL_FLOWIT_NPM_PACKAGE
  readonly registry: typeof OFFICIAL_FLOWIT_NPM_REGISTRY
  readonly version: string
  readonly rootDir: string
  readonly packageRoot: string
  readonly cliPath: string
  readonly studioCliPath: string
  readonly reused: boolean
}

export async function bootstrapStudioRuntime(
  intent: StudioInstallIntent,
  versionRange: string,
  options: OfficialRuntimeResolverOptions = {},
): Promise<ResolvedOfficialFlowitRuntime> {
  if (!intentAuthorizesStandardInstall(intent, 'runtime-bootstrap')) {
    throw new Error('Studio install intent does not authorize official runtime bootstrap')
  }
  return resolveOfficialFlowitRuntime(versionRange, options)
}

export async function resolveOfficialFlowitRuntime(
  versionRange: string,
  options: OfficialRuntimeResolverOptions = {},
): Promise<ResolvedOfficialFlowitRuntime> {
  const range = assertFlowitRuntimeRange(versionRange)
  const run = options.runCommand ?? defaultCommandRunner
  const npm = options.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const exactVersion = await resolveOfficialPublishedVersion(range, npm, run)
  const runtimeRoot = path.join(
    options.homeDir ?? os.homedir(),
    '.flowit-workflow',
    'runtime',
  )
  const targetRoot = path.join(runtimeRoot, 'versions', exactVersion)
  const existing = await inspectRuntime(targetRoot)
  if (existing) return { ...existing, reused: true }

  await mkdir(path.dirname(targetRoot), { recursive: true })
  const stagingRoot = `${targetRoot}.install-${randomUUID()}`
  try {
    await mkdir(stagingRoot, { recursive: true })
    await run(npm, [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--registry=${OFFICIAL_FLOWIT_NPM_REGISTRY}`,
      OFFICIAL_SCOPE_REGISTRY_OPTION,
      '--prefix',
      stagingRoot,
      `${OFFICIAL_FLOWIT_NPM_PACKAGE}@${exactVersion}`,
    ])
    await writeRuntimeOrigin(stagingRoot, exactVersion)
    const staged = await inspectRuntime(stagingRoot)
    if (!staged) {
      throw new Error('official Flowit package install completed without a valid runtime payload')
    }
    if (staged.version !== exactVersion) {
      throw new Error(
        `official Flowit install resolved ${exactVersion} but installed ${staged.version}`,
      )
    }
    try {
      await rename(stagingRoot, targetRoot)
    } catch (error: unknown) {
      const raced = await inspectRuntime(targetRoot)
      if (!raced || raced.version !== exactVersion) throw error
      return { ...raced, reused: true }
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
  const installed = await inspectRuntime(targetRoot)
  if (!installed) throw new Error('official Flowit runtime disappeared after bootstrap')
  return { ...installed, reused: false }
}

export async function resolveOfficialPublishedVersion(
  versionRange: string,
  npmCommand: string,
  run: BootstrapCommandRunner,
): Promise<string> {
  const range = assertFlowitRuntimeRange(versionRange)
  const query = `${OFFICIAL_FLOWIT_NPM_PACKAGE}@${range}`
  const result = await run(npmCommand, [
    'view',
    query,
    'version',
    '--json',
    `--registry=${OFFICIAL_FLOWIT_NPM_REGISTRY}`,
    OFFICIAL_SCOPE_REGISTRY_OPTION,
  ])
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`npm returned invalid JSON while resolving ${query}`)
  }
  const versions =
    typeof parsed === 'string'
      ? [parsed]
      : Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : []
  const version = versions.at(-1)?.trim()
  if (
    !version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error(`no published official Flowit version satisfies ${versionRange}`)
  }
  return version
}

async function writeRuntimeOrigin(rootDir: string, version: string): Promise<void> {
  await writeFile(
    path.join(rootDir, RUNTIME_ORIGIN_FILE),
    `${JSON.stringify({
      version: 1,
      packageName: OFFICIAL_FLOWIT_NPM_PACKAGE,
      registry: OFFICIAL_FLOWIT_NPM_REGISTRY,
      packageVersion: version,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

async function inspectRuntime(
  rootDir: string,
): Promise<Omit<ResolvedOfficialFlowitRuntime, 'reused'> | undefined> {
  try {
    await stat(rootDir)
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }

  const packageRoot = path.join(
    rootDir,
    'node_modules',
    '@coaseedgeltd',
    'flowit-workflow',
  )
  const origin = await readOrigin(rootDir)
  if (
    origin.packageName !== OFFICIAL_FLOWIT_NPM_PACKAGE ||
    origin.registry !== OFFICIAL_FLOWIT_NPM_REGISTRY
  ) {
    throw new Error(`runtime at ${rootDir} has no trusted official npm provenance`)
  }
  const parsed = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { name?: unknown; version?: unknown }
  if (parsed.name !== OFFICIAL_FLOWIT_NPM_PACKAGE || typeof parsed.version !== 'string') {
    throw new Error(`runtime at ${rootDir} is not ${OFFICIAL_FLOWIT_NPM_PACKAGE}`)
  }
  if (origin.packageVersion !== parsed.version) {
    throw new Error(`runtime at ${rootDir} differs from its recorded official provenance`)
  }
  const cliPath = path.join(packageRoot, 'dist', 'cli.js')
  const studioCliPath = path.join(packageRoot, 'dist', 'studio', 'cli-entry.js')
  await Promise.all([stat(cliPath), stat(studioCliPath)])
  return {
    packageName: OFFICIAL_FLOWIT_NPM_PACKAGE,
    registry: OFFICIAL_FLOWIT_NPM_REGISTRY,
    version: parsed.version,
    rootDir,
    packageRoot,
    cliPath,
    studioCliPath,
  }
}

async function readOrigin(rootDir: string): Promise<{
  packageName: unknown
  registry: unknown
  packageVersion: unknown
}> {
  try {
    const value = JSON.parse(
      await readFile(path.join(rootDir, RUNTIME_ORIGIN_FILE), 'utf8'),
    ) as Record<string, unknown>
    if (value.version !== 1) throw new Error('unsupported runtime provenance version')
    return {
      packageName: value.packageName,
      registry: value.registry,
      packageVersion: value.packageVersion,
    }
  } catch (error: unknown) {
    if (isMissing(error)) {
      throw new Error(`runtime at ${rootDir} predates trusted official provenance; reinstall it`)
    }
    throw error
  }
}

async function defaultCommandRunner(
  command: string,
  args: readonly string[],
): Promise<BootstrapCommandResult> {
  const result = await execFileAsync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
}
