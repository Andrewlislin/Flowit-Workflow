import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_LOCK_TIMEOUT_MS = 10_000
const INITIALIZATION_GRACE_MS = 2_000
const POLL_MS = 25

interface FileLockOwner {
  version: 1
  token: string
  pid: number
  acquiredAt: string
}

type OwnerInspection =
  | { kind: 'missing' }
  | { kind: 'valid'; owner: FileLockOwner }
  | { kind: 'unknown-version'; version: unknown }
  | { kind: 'malformed' }

type LockInspection =
  | { kind: 'missing' }
  | { kind: 'legacy-file' }
  | { kind: 'directory'; owner: OwnerInspection; ageMs: number }

type AcquisitionResult =
  | { kind: 'acquired'; owner: FileLockOwner }
  | { kind: 'busy' }
  | { kind: 'retry' }

export async function withFailClosedMutex<T>(
  lockDir: string,
  operation: () => Promise<T>,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  await mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for fail-closed filesystem mutex ${lockDir}; ` +
            'manual recovery is required if its prior owner crashed',
        )
      }
      await sleep(POLL_MS)
    }
  }
  try {
    return await operation()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

export async function withGenerationFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const lockDir = `${filePath}.lock`
  const mutationDir = `${filePath}.lock-mutation`
  const deadline = Date.now() + timeoutMs
  let owner: FileLockOwner | undefined

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const result = await withFailClosedMutex(
      mutationDir,
      async (): Promise<AcquisitionResult> => {
        const descriptor = await inspectLock(lockDir)
        if (descriptor.kind === 'missing') {
          const candidate: FileLockOwner = {
            version: 1,
            token: randomUUID(),
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          }
          try {
            await mkdir(lockDir)
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { kind: 'retry' }
            throw error
          }
          try {
            await writeOwner(lockDir, candidate)
          } catch (error) {
            await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
            throw error
          }
          return { kind: 'acquired', owner: candidate }
        }
        if (descriptor.kind === 'legacy-file') return { kind: 'busy' }

        switch (descriptor.owner.kind) {
          case 'valid':
            if (isProcessAlive(descriptor.owner.owner.pid)) return { kind: 'busy' }
            await moveAside(lockDir, `stale.${descriptor.owner.owner.token}`)
            return { kind: 'retry' }
          case 'missing':
            if (descriptor.ageMs < INITIALIZATION_GRACE_MS) return { kind: 'busy' }
            await moveAside(lockDir, 'uninitialized')
            return { kind: 'retry' }
          case 'unknown-version':
            throw new Error(
              `filesystem lock ${lockDir} uses unknown owner version ${String(descriptor.owner.version)}; ` +
                'refusing automatic recovery; manual recovery is required',
            )
          case 'malformed':
            throw new Error(
              `filesystem lock ${lockDir} has malformed owner metadata; ` +
                'refusing automatic recovery; manual recovery is required',
            )
        }
      },
      remaining,
    )
    if (result.kind === 'acquired') {
      owner = result.owner
      break
    }
    if (result.kind === 'retry') continue
    await sleep(POLL_MS)
  }

  if (!owner) throw new Error(`timed out waiting for filesystem lock: ${lockDir}`)
  try {
    return await operation()
  } finally {
    await releaseGeneration(lockDir, mutationDir, owner)
  }
}

export async function durableReplaceText(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  try {
    await rename(temporary, filePath)
    await syncDirectory(directory)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function durableAppendText(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true })
  const handle = await open(filePath, 'a')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  await syncDirectory(directory)
}

async function releaseGeneration(
  lockDir: string,
  mutationDir: string,
  owner: FileLockOwner,
): Promise<void> {
  await withFailClosedMutex(mutationDir, async () => {
    const descriptor = await inspectLock(lockDir)
    if (
      descriptor.kind !== 'directory' ||
      descriptor.owner.kind !== 'valid' ||
      descriptor.owner.owner.token !== owner.token
    )
      return
    const releasing = `${lockDir}.release.${owner.token}`
    try {
      await rename(lockDir, releasing)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await rm(releasing, { recursive: true, force: true })
  })
}

async function inspectLock(lockDir: string): Promise<LockInspection> {
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

async function inspectOwner(lockDir: string): Promise<OwnerInspection> {
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
    typeof row.token !== 'string' ||
    !Number.isSafeInteger(row.pid) ||
    typeof row.acquiredAt !== 'string'
  )
    return { kind: 'malformed' }

  return { kind: 'valid', owner: row as unknown as FileLockOwner }
}

async function writeOwner(lockDir: string, owner: FileLockOwner): Promise<void> {
  const file = path.join(lockDir, 'owner.json')
  const temporary = path.join(lockDir, `.owner.${process.pid}.${owner.token}.tmp`)
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  await rename(temporary, file)
  await syncDirectory(lockDir)
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

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      process.platform === 'win32' &&
      (code === 'EACCES' || code === 'EPERM' || code === 'EINVAL')
    )
      return
    throw error
  }
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
