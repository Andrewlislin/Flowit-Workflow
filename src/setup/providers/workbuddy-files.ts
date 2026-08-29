import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export type JsonRecord = Record<string, unknown>

export interface JsonSnapshot {
  readonly exists: boolean
  readonly hash: string | null
  readonly value: JsonRecord
}

export interface TextSnapshot {
  readonly exists: boolean
  readonly content?: string
  readonly hash: string | null
}

export const WORKBUDDY_BRIDGE_DIRS = [
  'inbox', 'processing', 'outbox', 'cancellations',
  'cancelled', 'dead-letter', 'receipts', 'claims',
] as const

export async function readJsonSnapshot(file: string): Promise<JsonSnapshot> {
  try {
    const raw = await readFile(file, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error: unknown) {
      throw new Error(
        `cannot safely merge invalid JSON configuration ${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!isRecord(value)) throw new Error(`configuration ${file} must contain a JSON object`)
    return { exists: true, hash: digest(raw), value }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, hash: null, value: {} }
    throw error
  }
}

export async function readTextSnapshot(file: string): Promise<TextSnapshot> {
  try {
    const content = await readFile(file, 'utf8')
    return { exists: true, content, hash: digest(content) }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, hash: null }
    throw error
  }
}

export async function writeJson(file: string, value: JsonRecord): Promise<void> {
  await durableWriteText(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function durableWriteText(file: string, content: string): Promise<void> {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  try {
    await rename(temporary, file)
    await syncDirectory(directory)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function ensureBridgeDirectories(root: string): Promise<void> {
  await Promise.all(
    WORKBUDDY_BRIDGE_DIRS.map(name => mkdir(path.join(root, name), { recursive: true })),
  )
}

export async function missingBridgeDirectories(root: string): Promise<string[]> {
  const missing: string[] = []
  for (const name of WORKBUDDY_BRIDGE_DIRS) {
    const directory = path.join(root, name)
    try {
      const info = await stat(directory)
      if (!info.isDirectory()) missing.push(directory)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(directory)
      else throw error
    }
  }
  return missing
}

export async function removeEmptyParents(start: string, stopAt: string): Promise<void> {
  let current = start
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      await rm(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

export async function assertDirectory(directory: string): Promise<void> {
  const info = await stat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`project directory does not exist: ${directory}`)
    }
    throw error
  })
  if (!info.isDirectory()) throw new Error(`project directory is not a directory: ${directory}`)
}

export async function assertReadable(file: string, label: string): Promise<void> {
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a regular file')
  } catch (error: unknown) {
    throw new Error(`${label} is missing at ${file}; run Flowit Workflow from a built installation`, {
      cause: error,
    })
  }
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
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
    if (process.platform === 'win32' && (code === 'EACCES' || code === 'EPERM' || code === 'EINVAL')) return
    throw error
  }
}
