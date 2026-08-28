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

type DaemonOwnerInspection =
  | { kind: 'missing' }
  | { kind: 'valid'; metadata: DaemonLeaseMetadata }
  | { kind: 'unknown-version'; version: unknown }
  | { kind: 'malformed' }

type DaemonLeaseInspection =
  | { kind: 'missing' }
  | { kind: 'legacy-file' }
  | { kind: 'directory'; owner: DaemonOwnerInspection; ageMs: number }

type AcquisitionResult =
  | { kind: 'acquired'; lease: DaemonLease }
  | { kind: 'busy' }
  | { kind: 'retry' }

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
    const result = await withFailClosedMutex(
      mutationDir,
      async (): Promise<AcquisitionResult> => {
        const descriptor = await inspectLease(lockDir)
        if (descriptor.kind === 'missing') {
          const ownerToken = randomUUID()
          try {
            await mkdir(lockDir)
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { kind: 'retry' }
            throw error
          }
          const fresh: DaemonLeaseMetadata = {
            version: 1,
            ownerToken,
            pid: process.pid,
            instanceId,
            storageFile: canonicalStorageFile,
            startedAt: new Date().toISOString(),
          }
          try {
            await writeOwner(lockDir, fresh)
          } catch (error) {
            await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
            throw error
          }
          return { kind: 'acquired', lease: createLease(lockDir, mutationDir, fresh) }
        }
        if (descriptor.kind === 'legacy-file') {
          throw new Error(
            `Flowit Workflow lease ${lockDir} is not a directory; ` +
              'refusing automatic recovery; manual recovery is required',
          )
        }

        switch (descriptor.owner.kind) {
          case 'missing':
            if (descriptor.ageMs < initializationGraceMs) return { kind: 'busy' }
            await moveAside(lockDir, 'uninitialized')
            return { kind: 'retry' }
          case 'unknown-version':
            throw new Error(
              `Flowit Workflow lease ${lockDir} uses unknown owner version ${String(descriptor.owner.version)}; ` +
                'refusing automatic recovery; manual recovery is required',
            )
          case 'malformed':
            throw new Error(
              `Flowit Workflow lease ${lockDir} has malformed owner metadata; ` +
                'refusing automatic recovery; manual recovery is required',
            )
          case 'valid': {
            const metadata = descriptor.owner.metadata
            if (isProcessAlive(metadata.pid)) {
              throw new Error(
                `Flowit Workflow worker already owns storage ${canonicalStorageFile} (pid ${metadata.pid}, instance ${metadata.instanceId})`,
              )
            }
            await moveAside(lockDir, `stale.${metadata.ownerToken}`)
            return { kind: 'retry' }
          }
        }
      },
      Math.max(1, deadline - Date.now()),
    )
    if (result.kind === 'acquired') return result.lease
    if (result.kind === 'retry') continue
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
        const descriptor = await inspectLease(lockDir)
        if (
          descriptor.kind !== 'directory' ||
          descriptor.owner.kind !== 'valid' ||
          descriptor.owner.metadata.ownerToken !== metadata.ownerToken
        )
          return false
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

async function inspectLease(lockDir: string): Promise<DaemonLeaseInspection> {
  try {
    const info = await stat(lockDir)
    if (!info.isDirectory()) return { kind: 'legacy-file' }
    return {
      kind: 'directory',
      owner: await inspectOwner(lockDir),
      ageMs: Date.now() - info.mtimeMs,
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
}

async function inspectOwner(lockDir: string): Promise<DaemonOwnerInspection> {
  let text: string
  try {
    text = await readFile(path.join(lockDir, 'owner.json'), 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return { kind: 'malformed' }
    throw error
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'malformed' }

  const row = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(row, 'version')) return { kind: 'malformed' }
  if (row.version !== 1) return { kind: 'unknown-version', version: row.version }
  if (
    typeof row.ownerToken !== 'string' ||
    !Number.isSafeInteger(row.pid) ||
    typeof row.instanceId !== 'string' ||
    typeof row.storageFile !== 'string' ||
    typeof row.startedAt !== 'string'
  )
    return { kind: 'malformed' }

  return { kind: 'valid', metadata: row as unknown as DaemonLeaseMetadata }
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
