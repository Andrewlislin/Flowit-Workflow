import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withFailClosedMutex } from '@coaseedge/flowit-core/internal/file-lock'

const INITIALIZATION_GRACE_MS = 2_000

export interface DaemonLeaseMetadata {
  version: 1
  ownerToken: string
  pid: number
  instanceId: string
  storageFile: string
  startedAt: string
}

export interface DaemonLease {
  ownerToken: string
  lockDir: string
  storageFile: string
  release(): Promise<boolean>
}

export interface AcquireDaemonLeaseOptions {
  root?: string
  initializationGraceMs?: number
  acquisitionTimeoutMs?: number
}

export async function canonicalStorageIdentity(storageFile: string): Promise<string> {
  const resolved = path.resolve(storageFile)
  try {
    return await realpath(resolved)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(path.dirname(resolved), { recursive: true })
  const canonicalParent = await realpath(path.dirname(resolved))
  return path.join(canonicalParent, path.basename(resolved))
}

export async function acquireDaemonLease(
  instanceId: string,
  storageFile: string,
  options: AcquireDaemonLeaseOptions = {},
): Promise<DaemonLease> {
  const canonicalStorageFile = await canonicalStorageIdentity(storageFile)
  const root = options.root ?? path.join(os.homedir(), '.flowit-workflow', 'leases')
  const key = createHash('sha256').update(canonicalStorageFile).digest('hex')
  const lockDir = path.join(root, `${key}.lock`)
  const mutationDir = path.join(root, '.mutation', `${key}.lock`)
  const initializationGraceMs = options.initializationGraceMs ?? INITIALIZATION_GRACE_MS
  const deadline = Date.now() + (options.acquisitionTimeoutMs ?? 10_000)
  await mkdir(root, { recursive: true })

  while (Date.now() < deadline) {
    const ownerToken = randomUUID()
    try {
      await mkdir(lockDir)
      const metadata: DaemonLeaseMetadata = {
        version: 1,
        ownerToken,
        pid: process.pid,
        instanceId,
        storageFile: canonicalStorageFile,
        startedAt: new Date().toISOString(),
      }
      // Do not rm(lockDir) if owner metadata publication fails: the path may already
      // have been moved aside and replaced by another contender. An incomplete lock
      // is recovered only through the initialization-grace / stale-lock path below.
      await writeOwner(lockDir, metadata)
      return createLease(lockDir, mutationDir, metadata)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const recovered = await withFailClosedMutex(
      mutationDir,
      async () => {
        const metadata = await readOwner(lockDir)
        if (!metadata) {
          const age = await stat(lockDir)
            .then(value => Date.now() - value.mtimeMs)
            .catch(() => 0)
          if (age < initializationGraceMs) return false
          return moveAside(lockDir, 'uninitialized')
        }
        if (isProcessAlive(metadata.pid))
          throw new Error(
            `Flowit Workflow worker already owns storage ${canonicalStorageFile} (pid ${metadata.pid}, instance ${metadata.instanceId})`,
          )
        return moveAside(lockDir, `stale.${metadata.ownerToken}`)
      },
      Math.max(1, deadline - Date.now()),
    )
    if (recovered) continue
    await sleep(25)
  }
  throw new Error(`timed out acquiring Flowit Workflow worker lease for ${canonicalStorageFile}`)
}

function createLease(
  lockDir: string,
  mutationDir: string,
  metadata: DaemonLeaseMetadata,
): DaemonLease {
  return {
    ownerToken: metadata.ownerToken,
    lockDir,
    storageFile: metadata.storageFile,
    async release(): Promise<boolean> {
      return withFailClosedMutex(mutationDir, async () => {
        const current = await readOwner(lockDir)
        if (!current || current.ownerToken !== metadata.ownerToken) return false
        const releasing = `${lockDir}.release.${metadata.ownerToken}`
        try {
          await rename(lockDir, releasing)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
        await rm(releasing, { recursive: true, force: true })
        return true
      })
    },
  }
}

async function readOwner(lockDir: string): Promise<DaemonLeaseMetadata | undefined> {
  try {
    const value = JSON.parse(
      await readFile(path.join(lockDir, 'owner.json'), 'utf8'),
    ) as DaemonLeaseMetadata
    if (
      value.version !== 1 ||
      typeof value.ownerToken !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.storageFile !== 'string'
    )
      return undefined
    return value
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
      return undefined
    throw error
  }
}

async function writeOwner(lockDir: string, metadata: DaemonLeaseMetadata): Promise<void> {
  const temporary = path.join(lockDir, `.owner.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  await rename(temporary, path.join(lockDir, 'owner.json'))
}

async function moveAside(lockDir: string, reason: string): Promise<boolean> {
  const stale = `${lockDir}.${reason}.${randomUUID()}`
  try {
    await rename(lockDir, stale)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  await rm(stale, { recursive: true, force: true })
  return true
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}
