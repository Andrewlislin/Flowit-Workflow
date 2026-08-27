import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent, AgentSessionDescriptor } from '../core/types.js'
import {
  durableAppendText,
  durableReplaceText,
  withGenerationFileLock,
} from '../internal/file-lock.js'

export interface BridgeStatePaths {
  root: string
  sessionsFile: string
  eventsFile: string
  cursorFile: string
  legacyCursorFile: string
  inboxDir: string
  processingDir: string
  outboxDir: string
  cancelledDir: string
  deadLetterDir: string
  cancellationsDir: string
  receiptsDir: string
  claimsDir: string
}
export interface BridgeSessionRecord extends AgentSessionDescriptor {
  lastAssistantMessage?: string
}

export function bridgeStatePaths(
  adapterId: string,
  root?: string,
  consumerId?: string,
): BridgeStatePaths {
  const base =
    root ?? path.join(process.env.HOME ?? process.cwd(), '.flowit-workflow', 'bridges', adapterId)
  const legacyCursorFile = path.join(base, 'events.cursor')
  const cursorFile = consumerId?.trim()
    ? path.join(base, 'cursors', `${createHash('sha256').update(consumerId).digest('hex')}.cursor`)
    : legacyCursorFile
  return {
    root: base,
    sessionsFile: path.join(base, 'sessions.json'),
    eventsFile: path.join(base, 'events.jsonl'),
    cursorFile,
    legacyCursorFile,
    inboxDir: path.join(base, 'inbox'),
    processingDir: path.join(base, 'processing'),
    outboxDir: path.join(base, 'outbox'),
    cancelledDir: path.join(base, 'cancelled'),
    deadLetterDir: path.join(base, 'dead-letter'),
    cancellationsDir: path.join(base, 'cancellations'),
    receiptsDir: path.join(base, 'receipts'),
    claimsDir: path.join(base, 'claims'),
  }
}

export async function readBridgeSessions(paths: BridgeStatePaths): Promise<BridgeSessionRecord[]> {
  try {
    const value = JSON.parse(await readFile(paths.sessionsFile, 'utf8')) as unknown
    return Array.isArray(value) ? value.filter(isSession) : []
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
export async function upsertBridgeSession(
  paths: BridgeStatePaths,
  session: BridgeSessionRecord,
): Promise<void> {
  await withGenerationFileLock(paths.sessionsFile, async () => {
    const sessions = await readBridgeSessions(paths)
    const index = sessions.findIndex(
      item => item.adapterId === session.adapterId && item.sessionId === session.sessionId,
    )
    if (index >= 0) sessions[index] = { ...sessions[index]!, ...session }
    else sessions.push(session)
    await durableReplaceText(paths.sessionsFile, `${JSON.stringify(sessions, null, 2)}\n`)
  })
}
export async function appendBridgeEvent(paths: BridgeStatePaths, event: AgentEvent): Promise<void> {
  await withGenerationFileLock(paths.eventsFile, () =>
    durableAppendText(paths.eventsFile, `${JSON.stringify(event)}\n`),
  )
}
export async function readBridgeEventsAfter(
  paths: BridgeStatePaths,
  offset: number,
): Promise<{ events: AgentEvent[]; nextOffset: number }> {
  let text = ''
  try {
    text = await readFile(paths.eventsFile, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const lines = text.split('\n').filter(Boolean)
  const events = lines.slice(offset).map(line => JSON.parse(line) as AgentEvent)
  return { events, nextOffset: lines.length }
}
export async function readBridgeCursor(paths: BridgeStatePaths): Promise<number> {
  const current = await readCursor(paths.cursorFile)
  if (current !== undefined) return current
  if (paths.cursorFile !== paths.legacyCursorFile) {
    const legacy = await readCursor(paths.legacyCursorFile)
    if (legacy !== undefined) {
      await writeBridgeCursor(paths, legacy)
      return legacy
    }
  }
  return 0
}
export async function writeBridgeCursor(paths: BridgeStatePaths, value: number): Promise<void> {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('bridge event cursor must be a non-negative integer')
  await durableReplaceText(paths.cursorFile, `${value}\n`)
  if (paths.cursorFile !== paths.legacyCursorFile) {
    await advanceSharedCursor(paths.legacyCursorFile, value)
  }
}

async function advanceSharedCursor(file: string, value: number): Promise<void> {
  await withGenerationFileLock(file, async () => {
    const current = (await readCursor(file)) ?? 0
    if (value > current) await durableReplaceText(file, `${value}\n`)
  })
}

async function readCursor(file: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(file, 'utf8')).trim())
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function isSession(value: unknown): value is BridgeSessionRecord {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.adapterId === 'string' &&
    typeof row.sessionId === 'string' &&
    typeof row.status === 'string'
  )
}
