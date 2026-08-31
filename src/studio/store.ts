import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadStudioPackage } from './validate.js'
import type { StudioPackageDescriptor } from './types.js'

export interface StudioPackageStoreOptions {
  readonly rootDir?: string
}

export interface InstalledStudioPackage extends StudioPackageDescriptor {
  readonly installDir: string
  readonly digest: string
}

export interface StudioPackageSnapshot extends StudioPackageDescriptor {
  readonly snapshotDir: string
  readonly digest: string
}

export class StudioPackageStore {
  readonly rootDir: string

  constructor(options: StudioPackageStoreOptions = {}) {
    this.rootDir = path.resolve(
      options.rootDir ?? path.join(os.homedir(), '.flowit-workflow', 'studios'),
    )
  }

  async stageFromDirectory(sourceRoot: string): Promise<StudioPackageSnapshot> {
    const stagingRoot = this.stagingRoot()
    await mkdir(stagingRoot, { recursive: true })
    const snapshotDir = path.join(stagingRoot, randomUUID())
    try {
      await cp(path.resolve(sourceRoot), snapshotDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
      })
      await assertSafePackageTree(snapshotDir)
      const descriptor = await loadStudioPackage(snapshotDir)
      const digest = await computeStudioTreeDigest(snapshotDir)
      return { ...descriptor, snapshotDir, digest }
    } catch (error: unknown) {
      await rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async commitSnapshot(snapshot: StudioPackageSnapshot): Promise<InstalledStudioPackage> {
    this.assertOwnedSnapshot(snapshot)
    await assertSafePackageTree(snapshot.snapshotDir)
    const descriptor = await loadStudioPackage(snapshot.snapshotDir)
    if (stableManifest(descriptor.manifest) !== stableManifest(snapshot.manifest)) {
      throw new Error('Studio staging snapshot manifest changed after review')
    }
    const digest = await computeStudioTreeDigest(snapshot.snapshotDir)
    if (digest !== snapshot.digest) {
      throw new Error('Studio staging snapshot changed after review')
    }

    const targetDir = this.installDirFor(descriptor)
    const existing = await this.tryLoadInstalled(targetDir)
    if (existing) {
      if (existing.digest !== digest) {
        throw new Error(
          `Studio ${descriptor.manifest.id}@${descriptor.manifest.version} already exists with different content`,
        )
      }
      await this.discardSnapshot(snapshot)
      return existing
    }

    await mkdir(path.dirname(targetDir), { recursive: true })
    try {
      await rename(snapshot.snapshotDir, targetDir)
    } catch (error: unknown) {
      const raced = await this.tryLoadInstalled(targetDir)
      if (!raced || raced.digest !== digest) throw error
      await this.discardSnapshot(snapshot)
      return raced
    }

    const installed = await this.tryLoadInstalled(targetDir)
    if (!installed) {
      throw new Error(`Studio installation disappeared before verification: ${targetDir}`)
    }
    if (installed.digest !== digest) {
      throw new Error('Studio installed bytes differ from the reviewed staging snapshot')
    }
    return installed
  }

  async installFromDirectory(sourceRoot: string): Promise<InstalledStudioPackage> {
    const snapshot = await this.stageFromDirectory(sourceRoot)
    try {
      return await this.commitSnapshot(snapshot)
    } catch (error: unknown) {
      await this.discardSnapshot(snapshot)
      throw error
    }
  }

  async discardSnapshot(snapshot: StudioPackageSnapshot): Promise<void> {
    this.assertOwnedSnapshot(snapshot)
    await rm(snapshot.snapshotDir, { recursive: true, force: true })
  }

  async listInstalled(): Promise<InstalledStudioPackage[]> {
    const results: InstalledStudioPackage[] = []
    for (const publisher of await safeDirectoryNames(this.rootDir)) {
      if (publisher === '.staging') continue
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

  private stagingRoot(): string {
    return path.join(this.rootDir, '.staging')
  }

  private assertOwnedSnapshot(snapshot: StudioPackageSnapshot): void {
    const stagingRoot = path.resolve(this.stagingRoot())
    const snapshotDir = path.resolve(snapshot.snapshotDir)
    if (
      snapshot.rootDir !== snapshotDir ||
      !snapshotDir.startsWith(`${stagingRoot}${path.sep}`)
    ) {
      throw new Error('Studio snapshot is not owned by this Flowit package store')
    }
  }

  private async tryLoadInstalled(
    installDir: string,
  ): Promise<InstalledStudioPackage | undefined> {
    try {
      await assertSafePackageTree(installDir)
      const descriptor = await loadStudioPackage(installDir)
      return {
        ...descriptor,
        installDir,
        digest: await computeStudioTreeDigest(installDir),
      }
    } catch (error: unknown) {
      if (isMissing(error)) return undefined
      throw error
    }
  }
}

export async function assertSafePackageTree(rootDir: string): Promise<void> {
  const root = path.resolve(rootDir)
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Studio package root must be a real directory, not a symbolic link')
  }

  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      const stat = await lstat(fullPath)
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Studio package must not contain symbolic links: ${path.relative(root, fullPath)}`,
        )
      }
      if (stat.isDirectory()) {
        await visit(fullPath)
        continue
      }
      if (!stat.isFile()) {
        throw new Error(
          `Studio package may contain only regular files and directories: ${path.relative(root, fullPath)}`,
        )
      }
    }
  }
  await visit(root)
}

export async function computeStudioTreeDigest(rootDir: string): Promise<string> {
  const root = path.resolve(rootDir)
  await assertSafePackageTree(root)
  const files: string[] = []
  const collect = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await collect(fullPath)
      } else if (entry.isFile()) {
        files.push(path.relative(root, fullPath).split(path.sep).join('/'))
      }
    }
  }
  await collect(root)
  files.sort()

  const hash = createHash('sha256')
  for (const relative of files) {
    const bytes = await readFile(path.join(root, ...relative.split('/')))
    hash.update(relative, 'utf8')
    hash.update('\0')
    hash.update(String(bytes.length), 'utf8')
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function stableManifest(value: unknown): string {
  return JSON.stringify(value)
}

function safeSegment(value: string, label: string): string {
  const segment = value.trim()
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\')
  ) {
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
  if (!error || typeof error !== 'object') return false
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
  const cause = (error as Error & { cause?: unknown }).cause
  return cause !== undefined ? isMissing(cause) : false
}
