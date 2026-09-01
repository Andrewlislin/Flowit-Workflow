import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDeclarativeStudioPreset } from './dsl.js'
import { compatibleFlowitRuntimeRange } from './runtime-range.js'
import { assertSafePackageTree } from './store.js'
import type { StudioPackageDescriptor } from './types.js'
import { loadStudioPackage } from './validate.js'

export interface StudioScaffoldOptions {
  readonly id: string
  readonly displayName: string
  readonly publisherId: string
  readonly hostId?: string
  readonly version?: string
  readonly force?: boolean
}

export interface StudioValidationResult {
  readonly valid: true
  readonly descriptor: StudioPackageDescriptor
  readonly presetId: string
  readonly roles: readonly string[]
  readonly nodes: readonly string[]
}

export async function currentFlowitPackageVersion(): Promise<string> {
  const packageFile = fileURLToPath(new URL('../../package.json', import.meta.url))
  const parsed = JSON.parse(await readFile(packageFile, 'utf8')) as { version?: unknown }
  if (typeof parsed.version !== 'string' || !parsed.version.trim()) {
    throw new Error('Flowit package.json has no usable version')
  }
  return parsed.version.trim()
}

export async function createStudioScaffold(
  targetDir: string,
  options: StudioScaffoldOptions,
): Promise<StudioPackageDescriptor> {
  const root = path.resolve(targetDir)
  const existing = await directoryEntries(root)
  if (existing.length > 0 && !options.force) {
    throw new Error(
      `Studio target directory is not empty: ${root}; pass --force to replace it explicitly`,
    )
  }
  if (existing.length > 0 && options.force) {
    await rm(root, { recursive: true, force: true })
  }

  const version = options.version ?? '0.1.0'
  const hostId = options.hostId ?? 'claude-code'
  const presetId = packageLeaf(options.id)
  const runtimeRange = compatibleFlowitRuntimeRange(await currentFlowitPackageVersion())

  await mkdir(path.join(root, 'presets'), { recursive: true })
  await mkdir(path.join(root, 'roles'), { recursive: true })
  await writeFile(
    path.join(root, 'flowit.package.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: options.id,
        displayName: options.displayName,
        publisher: { id: options.publisherId },
        version,
        runtime: {
          id: 'flowit-workflow',
          version: runtimeRange,
          bootstrap: 'official',
        },
        supportedHosts: [hostId],
        entryPreset: presetId,
        license: { type: 'freeware' },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    path.join(root, 'presets', `${presetId}.json`),
    `${JSON.stringify(
      {
        version: 1,
        id: presetId,
        displayName: options.displayName,
        description: `Starter Studio for ${options.displayName}`,
        input: { required: true, label: 'Goal' },
        roles: [
          {
            id: 'worker',
            displayName: 'Worker',
            description: 'Complete the requested work',
          },
        ],
        nodes: [
          {
            id: 'work',
            roleId: 'worker',
            promptFile: 'roles/worker.md',
          },
        ],
        edges: [],
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    path.join(root, 'roles', 'worker.md'),
    '# Worker\n\nComplete the following goal carefully:\n\n{{input}}\n\nWrite durable artifacts under {{workspace}} when useful.\n',
  )
  await writeFile(
    path.join(root, 'README.md'),
    `# ${options.displayName}\n\nFlowit Studio package ${options.id}.\n`,
  )
  return loadStudioPackage(root)
}

export async function validateStudioProject(
  rootDir: string,
): Promise<StudioValidationResult> {
  const descriptor = await loadStudioPackage(rootDir)
  await assertSafePackageTree(descriptor.rootDir)
  const loaded = await loadDeclarativeStudioPreset(descriptor)
  const sampleBindings = Object.fromEntries(
    loaded.definition.roles.map(role => [
      role.id,
      {
        roleId: role.id,
        adapterId: descriptor.manifest.supportedHosts[0]!,
        sessionId: 'studio-validation-session',
        skills: [],
      },
    ]),
  )
  const pipeline = loaded.definition.render({
    pipelineName: 'Studio validation',
    workspace: path.join(descriptor.rootDir, '.flowit-validation'),
    ...(loaded.definition.inputRequired ? { input: 'Studio validation input' } : {}),
    bindings: sampleBindings,
  })
  return {
    valid: true,
    descriptor,
    presetId: loaded.definition.id,
    roles: loaded.definition.roles.map(role => role.id),
    nodes: pipeline.nodes.map(node => node.id),
  }
}

export async function packStudioProject(
  rootDir: string,
  outputDir: string,
): Promise<{ outputPath: string; validation: StudioValidationResult }> {
  const validation = await validateStudioProject(rootDir)
  const sourceRoot = validation.descriptor.rootDir
  const safeName = `${validation.descriptor.manifest.id}-${validation.descriptor.manifest.version}.flowit`
  const outputPath = path.resolve(outputDir, safeName)
  await assertOutputOutsideSource(sourceRoot, outputPath, 'Studio pack output')
  await mkdir(path.dirname(outputPath), { recursive: true })
  await rm(outputPath, { recursive: true, force: true })
  await cp(sourceRoot, outputPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
  })
  await validateStudioProject(outputPath)
  return { outputPath, validation }
}

/**
 * Refuse destructive/self-recursive artifact layouts before any rm/cp mutation.
 * The canonical source and output trees must be disjoint in both directions.
 * Existing symlink aliases in either path prefix are resolved before comparison.
 */
export async function assertOutputOutsideSource(
  sourceRoot: string,
  outputPath: string,
  label = 'Studio output',
): Promise<void> {
  const source = await canonicalPotentialPath(sourceRoot)
  const output = await canonicalPotentialPath(outputPath)
  if (sameOrDescendant(source, output) || sameOrDescendant(output, source)) {
    throw new Error(`${label} must be disjoint from the Studio source tree: ${output}`)
  }
}

/**
 * Preserve the convenient `cd studio && flowit-studio pack .` path while
 * keeping generated artifacts lexically outside the source tree. The SDK
 * still performs the canonical/realpath disjointness fence before mutation.
 */
export function defaultStudioArtifactOutputDir(
  _cwd: string,
  sourceRoot: string,
  kind: string,
): string {
  return path.join(`${path.resolve(sourceRoot)}.dist`, kind)
}

async function canonicalPotentialPath(value: string): Promise<string> {
  let cursor = path.resolve(value)
  const suffix: string[] = []
  while (true) {
    try {
      const canonical = await realpath(cursor)
      return normalizeForComparison(path.join(canonical, ...suffix.reverse()))
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(path.basename(cursor))
      cursor = parent
    }
  }
}

function sameOrDescendant(parentValue: string, childValue: string): boolean {
  const relative = path.relative(parentValue, childValue)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isMissingPath(error: unknown): boolean {
  const code =
    error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function directoryEntries(root: string): Promise<string[]> {
  try {
    return await readdir(root)
  } catch (error: unknown) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function packageLeaf(id: string): string {
  const leaf = id
    .split('.')
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^a-z0-9-]/g, '-') ?? ''
  if (!leaf) throw new Error('Studio id must contain a usable package name')
  return leaf
}
