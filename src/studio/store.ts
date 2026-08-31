import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadStudioPackage } from './validate.js'
import type { StudioPackageDescriptor } from './types.js'

export interface StudioPackageStoreOptions {
  readonly rootDir?: string
}

export interface InstalledStudioPackage extends StudioPackageDescriptor {
  readonly installDir: string
}

export class StudioPackageStore {
  readonly rootDir: string

  constructor(options: StudioPackageStoreOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? path.join(os.homedir(), '.flowit-workflow', 'studios'))
  }

  async installFromDirectory(sourceRoot: string): Promise<InstalledStudioPackage> {
    const descriptor = await loadStudioPackage(sourceRoot)
    await assertSafePackageTree(descriptor.rootDir)
    const targetDir = this.installDirFor(descriptor)

    const existing = await this.tryLoadInstalled(targetDir)
    if (existing) {
      if (stableManifest(existing.manifest) !== stableManifest(descriptor.manifest)) {
        throw new Error(`Studio ${descriptor.manifest.id}@${descriptor.manifest.version} already exists with different metadata`)
      }
      return existing
    }

    await mkdir(path.dirname(targetDir), { recursive: true })
    const stagingDir = `${targetDir}.install-${randomUUID()}`
    try {
      await cp(descriptor.rootDir, stagingDir, { recursive: true, force: false, errorOnExist: true })
      try {
        await rename(stagingDir, targetDir)
      } catch (error: unknown) {
        const raced = await this.tryLoadInstalled(targetDir)
        if (!raced || stableManifest(raced.manifest) !== stableManifest(descriptor.manifest)) throw error
        return raced
      }
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
    const installed = await this.tryLoadInstalled(targetDir)
    if (!installed) throw new Error(`Studio installation disappeared before verification: ${targetDir}`)
    return installed
  }

  async listInstalled(): Promise<InstalledStudioPackage[]> {
    const results: InstalledStudioPackage[] = []
    for (const publisher of await safeDirectoryNames(this.rootDir)) {
      const publisherDir = path.join(this.rootDir, publisher)
      for (const packageId of await safeDirectoryNames(publisherDir)) {
        const packageDir = path.join(publisherDir, packageId)
        for (const version of await safeDirectoryNames(packageDir)) {
          const descriptor = await this.tryLoadInstalled(path.join(packageDir, version))
          if (descriptor) results.push(descriptor)
        }
      }
    }
    return results.sort((a, b) =>
      `${a.manifest.publisher.id}/${a.manifest.id}@${a.manifest.version}`.localeCompare(
        `${b.manifest.publisher.id}/${b.manifest.id}@${b.manifest.version}`,
      ),
    )
  }

  installDirFor(descriptor: StudioPackageDescriptor): string {
    const publisher = safeSegment(descriptor.manifest.publisher.id, 'publisher id')
    const packageId = safeSegment(descriptor.manifest.id, 'Studio id')
    const version = safeSegment(descriptor.manifest.version, 'Studio version')
    return path.join(this.rootDir, publisher, packageId, version)
  }

  private async tryLoadInstalled(installDir: string): Promise<InstalledStudioPackage | undefined> {
    try {
      const descriptor = await loadStudioPackage(installDir)
      return { ...descriptor, installDir }
    } catch (error: unknown) {
      if (isMissing(error)) return undefined
      throw error
    }
  }
}

export async function assertSafePackageTree(rootDir: string): Promise<void> {
  const root = path.resolve(rootDir)
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      const stat = await lstat(fullPath)
      if (stat.isSymbolicLink()) throw new Error(`Studio package must not contain symbolic links: ${path.relative(root, fullPath)}`)
      if (stat.isDirectory()) await visit(fullPath)
    }
  }
  await visit(root)
}

function stableManifest(value: unknown): string {
  return JSON.stringify(value)
}

function safeSegment(value: string, label: string): string {
  const segment = value.trim()
  if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
    throw new Error(`${label} is not safe for package storage`)
  }
  return segment
}

async function safeDirectoryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error: unknown) {
    if (isMissing(error)) return []
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
}
