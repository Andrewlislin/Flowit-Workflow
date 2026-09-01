import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import {
  installStudioForCurrentAgent,
  StudioRuntimeHandoffRequired,
} from './consumer.js'
import type { StudioLicenseDocumentV1 } from './license.js'
import {
  createStudioScaffold,
  defaultStudioArtifactOutputDir,
  packStudioProject,
  validateStudioProject,
} from './sdk.js'
import { StudioTrustStore, type StudioPublisherTrustLevel } from './signing.js'
import { StudioPackageStore } from './store.js'
import { loadStudioPackage } from './validate.js'

const execFileAsync = promisify(execFile)

export type StudioCliCommand =
  | 'init'
  | 'inspect'
  | 'validate'
  | 'test'
  | 'pack'
  | 'list'
  | 'install'

export interface StudioCliRuntime {
  readonly cwd?: string
  readonly homeDir?: string
  readonly env?: Readonly<NodeJS.ProcessEnv>
  readonly stdout?: Writable
}

export async function runStudioCli(
  args: readonly string[],
  runtime: StudioCliRuntime = {},
): Promise<void> {
  const cwd = runtime.cwd ?? process.cwd()
  const stdout = runtime.stdout ?? process.stdout
  const command = (args[0] ?? 'list') as StudioCliCommand
  const json = args.includes('--json')

  switch (command) {
    case 'init': {
      const target = positional(args, 1, 'studio init requires a target directory')
      const id = requiredOption(args, 'id')
      const displayName = option(args, 'name') ?? id
      const publisherId = requiredOption(args, 'publisher')
      const descriptor = await createStudioScaffold(path.resolve(cwd, target), {
        id,
        displayName,
        publisherId,
        ...(option(args, 'host') ? { hostId: option(args, 'host')! } : {}),
        ...(option(args, 'version') ? { version: option(args, 'version')! } : {}),
        ...(args.includes('--force') ? { force: true } : {}),
      })
      write(
        stdout,
        { created: true, rootDir: descriptor.rootDir, manifest: descriptor.manifest },
        json,
      )
      return
    }
    case 'inspect': {
      const target = positional(args, 1, 'studio inspect requires a package directory')
      const descriptor = await loadStudioPackage(path.resolve(cwd, target))
      write(stdout, descriptor, json)
      return
    }
    case 'validate':
    case 'test': {
      const target = positional(
        args,
        1,
        `studio ${command} requires a package directory`,
      )
      const result = await validateStudioProject(path.resolve(cwd, target))
      write(
        stdout,
        { ...result, mode: command === 'test' ? 'compile-test' : 'validation' },
        json,
      )
      return
    }
    case 'pack': {
      const target = positional(args, 1, 'studio pack requires a project directory')
      const sourceRoot = path.resolve(cwd, target)
      const outputDir = option(args, 'out')
        ? path.resolve(cwd, option(args, 'out')!)
        : defaultStudioArtifactOutputDir(cwd, sourceRoot, 'studios')
      const result = await packStudioProject(sourceRoot, outputDir)
      write(
        stdout,
        {
          packed: true,
          outputPath: result.outputPath,
          manifest: result.validation.descriptor.manifest,
        },
        json,
      )
      return
    }
    case 'install': {
      const target = positional(args, 1, 'studio install requires a package directory')
      const publisherKeyFiles = options(args, 'publisher-key').map(value =>
        path.resolve(cwd, value),
      )
      const trustStore = await loadTrustStore(publisherKeyFiles)
      const licensePath = option(args, 'license')
      const license = licensePath
        ? (JSON.parse(
            await readFile(path.resolve(cwd, licensePath), 'utf8'),
          ) as StudioLicenseDocumentV1)
        : undefined
      const scope = option(args, 'scope') ?? 'user'
      if (scope !== 'user' && scope !== 'project') {
        throw new Error('--scope must be user or project')
      }
      try {
        const result = await installStudioForCurrentAgent(
          {
            sourceRoot: path.resolve(cwd, target),
            projectDir: path.resolve(cwd, option(args, 'project-dir') ?? '.'),
            scope,
            ...(option(args, 'host') ? { hostId: option(args, 'host')! } : {}),
            ...(option(args, 'session') ? { sessionId: option(args, 'session')! } : {}),
            ...(option(args, 'workspace')
              ? { workspace: option(args, 'workspace')! }
              : {}),
            ...(option(args, 'source') ? { sourceLabel: option(args, 'source')! } : {}),
            ...(option(args, 'handoff-digest')
              ? { expectedSourceDigest: option(args, 'handoff-digest')! }
              : {}),
            ...(publisherKeyFiles.length ? { trustStore } : {}),
            ...(license ? { license } : {}),
            ...(args.includes('--allow-elevated') ? { allowElevated: true } : {}),
            ...(option(args, 'store')
              ? { storeRoot: path.resolve(cwd, option(args, 'store')!) }
              : {}),
          },
          {
            cwd,
            ...(runtime.homeDir ? { homeDir: runtime.homeDir } : {}),
            ...(runtime.env ? { env: runtime.env } : {}),
          },
        )
        write(stdout, result, json)
        return
      } catch (error: unknown) {
        if (!(error instanceof StudioRuntimeHandoffRequired)) throw error
        const childArgs = createRuntimeHandoffArgs(args, error)
        try {
          const result = await execFileAsync(
            process.execPath,
            [error.runtime.studioCliPath, ...childArgs],
            {
              cwd,
              env: { ...process.env, ...(runtime.env ?? {}) },
              encoding: 'utf8',
              maxBuffer: 10 * 1024 * 1024,
            },
          )
          stdout.write(result.stdout)
          if (result.stderr) process.stderr.write(result.stderr)
          return
        } finally {
          await error.releaseSnapshot()
        }
      }
    }
    case 'list': {
      const rootDir =
        option(args, 'store') ??
        path.join(runtime.homeDir ?? os.homedir(), '.flowit-workflow', 'studios')
      const installed = await new StudioPackageStore({ rootDir }).listInstalled()
      write(
        stdout,
        installed.map(item => ({
          id: item.manifest.id,
          displayName: item.manifest.displayName,
          publisher: item.manifest.publisher.id,
          version: item.manifest.version,
          installDir: item.installDir,
        })),
        json,
      )
      return
    }
    default:
      throw new Error(
        `unknown studio command ${String(command)}; expected init, inspect, validate, test, pack, install, or list`,
      )
  }
}

export function createRuntimeHandoffArgs(
  args: readonly string[],
  handoff: StudioRuntimeHandoffRequired,
): string[] {
  const withoutInternal = removeOptions(args, new Set(['handoff-digest', 'source']))
  if (withoutInternal[0] !== 'install') {
    throw new Error('Studio runtime handoff is valid only for the install command')
  }
  if (withoutInternal.length < 2) throw new Error('Studio runtime handoff has no install target')
  const result = [...withoutInternal]
  result[1] = handoff.snapshot.snapshotDir
  result.push(`--handoff-digest=${handoff.snapshot.digest}`)
  result.push(`--source=${handoff.sourceLabel}`)
  return result
}

async function loadTrustStore(files: readonly string[]): Promise<StudioTrustStore> {
  const store = new StudioTrustStore()
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const publisherId = requiredString(parsed.publisherId, `${file}: publisherId`)
    const keyId = requiredString(parsed.keyId, `${file}: keyId`)
    const publicKey = requiredString(parsed.publicKey, `${file}: publicKey`)
    const trust = requiredString(parsed.trust, `${file}: trust`) as StudioPublisherTrustLevel
    if (trust !== 'publisher' && trust !== 'verified' && trust !== 'official') {
      throw new Error(`${file}: trust must be publisher, verified, or official`)
    }
    store.add({ publisherId, keyId, publicKey, trust })
  }
  return store
}

function removeOptions(args: readonly string[], names: ReadonlySet<string>): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!arg.startsWith('--')) {
      result.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const name = arg.slice(2, equals >= 0 ? equals : undefined)
    if (!names.has(name)) {
      result.push(arg)
      continue
    }
    if (equals < 0 && args[index + 1] && !args[index + 1]!.startsWith('--')) index += 1
  }
  return result
}

function write(stdout: Writable, value: unknown, json: boolean): void {
  if (json) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      stdout.write('No installed Studios.\n')
      return
    }
    for (const item of value as Array<{
      id: string
      version: string
      publisher: string
      displayName: string
    }>) {
      stdout.write(`${item.displayName} — ${item.publisher}/${item.id}@${item.version}\n`)
    }
    return
  }
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function option(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const inline = args.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length).trim() || undefined
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1]?.trim() || undefined : undefined
}

function options(args: readonly string[], name: string): string[] {
  const prefix = `--${name}=`
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length))
    else if (arg === `--${name}` && args[index + 1]) values.push(args[++index]!)
  }
  return values.map(value => value.trim()).filter(Boolean)
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function positional(args: readonly string[], index: number, message: string): string {
  const value = args[index]
  if (!value || value.startsWith('-')) throw new Error(message)
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}
