import os from 'node:os'
import path from 'node:path'
import type { Writable } from 'node:stream'
import {
  createStudioScaffold,
  defaultStudioArtifactOutputDir,
  packStudioProject,
  validateStudioProject,
} from './sdk.js'
import { StudioPackageStore } from './store.js'
import { loadStudioPackage } from './validate.js'

export type StudioCliCommand =
  | 'init'
  | 'inspect'
  | 'validate'
  | 'test'
  | 'pack'
  | 'list'

export interface StudioCliRuntime {
  readonly cwd?: string
  readonly homeDir?: string
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
        `unknown studio command ${String(command)}; expected init, inspect, validate, test, pack, or list`,
      )
  }
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
