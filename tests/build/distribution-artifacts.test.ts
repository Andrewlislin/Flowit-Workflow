import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

type PackageManifest = {
  name?: string
  private?: boolean
  main?: unknown
  types?: unknown
  bin?: unknown
  exports?: unknown
}

async function discoverPackageDirectories(): Promise<string[]> {
  const directories = ['.']
  const entries = await readdir('packages', { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const directory = path.join('packages', entry.name)
    try {
      const manifest = JSON.parse(
        await readFile(path.join(directory, 'package.json'), 'utf8'),
      ) as PackageManifest
      if (manifest.private !== true) directories.push(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  return directories
}

function collectExportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(collectExportTargets)
}

function collectBinTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.values(value).filter(
    (target): target is string => typeof target === 'string',
  )
}

function resolveWithinPackage(
  directory: string,
  target: string,
  packageName: string,
): string {
  const packageRoot = path.resolve(directory)
  const relativeTarget = target.replace(/^\.\//, '')
  const resolvedTarget = path.resolve(packageRoot, relativeTarget)
  const withinPackage =
    resolvedTarget === packageRoot || resolvedTarget.startsWith(`${packageRoot}${path.sep}`)

  assert.ok(
    withinPackage,
    `${packageName} public entrypoint escapes its package root: ${target}`,
  )

  return resolvedTarget
}

async function assertTargetExists(
  directory: string,
  target: string,
  packageName: string,
): Promise<void> {
  if (!target.includes('*')) {
    const filename = resolveWithinPackage(directory, target, packageName)
    await assert.doesNotReject(
      access(filename),
      `${packageName} is missing built entrypoint ${target}`,
    )
    return
  }

  const firstWildcard = target.indexOf('*')
  assert.equal(
    target.indexOf('*', firstWildcard + 1),
    -1,
    `${packageName} uses an unsupported multi-wildcard entrypoint ${target}`,
  )

  const relativeTarget = target.replace(/^\.\//, '')
  const parent = path.dirname(relativeTarget)
  assert.ok(
    !parent.includes('*'),
    `${packageName} uses an unsupported wildcard directory entrypoint ${target}`,
  )

  const basename = path.basename(relativeTarget)
  const [prefix = '', suffix = ''] = basename.split('*')
  const targetDirectory = resolveWithinPackage(directory, parent, packageName)
  const entries = await readdir(targetDirectory, { withFileTypes: true })
  const hasMatch = entries.some(
    entry => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix),
  )

  assert.ok(
    hasMatch,
    `${packageName} wildcard entrypoint has no built matches: ${target}`,
  )
}

test('build emits every declared public package entrypoint', async () => {
  const packageDirectories = await discoverPackageDirectories()
  assert.ok(packageDirectories.length > 1, 'no workspace packages were discovered')

  for (const directory of packageDirectories) {
    const manifest = JSON.parse(
      await readFile(path.join(directory, 'package.json'), 'utf8'),
    ) as PackageManifest
    const packageName = manifest.name ?? directory

    const targets = new Set<string>(
      [
        manifest.main,
        manifest.types,
        ...collectBinTargets(manifest.bin),
        ...collectExportTargets(manifest.exports),
      ].filter((target): target is string => typeof target === 'string'),
    )

    assert.ok(targets.size > 0, `${packageName} has no public entrypoints`)

    for (const target of targets) {
      await assertTargetExists(directory, target, packageName)
    }
  }
})
