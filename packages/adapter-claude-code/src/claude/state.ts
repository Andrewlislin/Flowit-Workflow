import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentEvent, AgentSessionDescriptor } from '@coaseedge/flowit-core'
import {
  durableAppendText,
  durableReplaceText,
  withGenerationFileLock,
} from '@coaseedge/flowit-core/internal/file-lock'

export interface ClaudeSessionRecord extends AgentSessionDescriptor {
  adapterId: 'claude-code'
  transcriptPath?: string
  lastAssistantMessage?: string
  lastHookEvent?: string
}
interface ClaudeSessionCatalogFile {
  version: 1
  sessions: ClaudeSessionRecord[]
}
export interface ClaudeStatePaths {
  catalogFile: string
  eventJournalFile: string
  eventCursorFile: string
  legacyEventCursorFile?: string
}
export function defaultClaudeStatePaths(consumerId?: string): ClaudeStatePaths {
  const root = path.join(os.homedir(), '.flowit-workflow', 'claude')
  const legacyEventCursorFile = path.join(root, 'events.cursor')
  const eventCursorFile = consumerId?.trim()
    ? path.join(root, 'cursors', `${createHash('sha256').update(consumerId).digest('hex')}.cursor`)
    : legacyEventCursorFile
  return {
    catalogFile: path.join(root, 'sessions.json'),
    eventJournalFile: path.join(root, 'events.jsonl'),
    eventCursorFile,
    ...(eventCursorFile !== legacyEventCursorFile ? { legacyEventCursorFile } : {}),
  }
}

export class ClaudeSessionCatalog {
  constructor(readonly filePath: string) {}
  async list(): Promise<ClaudeSessionRecord[]> {
    return (await this.read()).sessions
  }
  async get(sessionId: string): Promise<ClaudeSessionRecord | undefined> {
    return (await this.read()).sessions.find(session => session.sessionId === sessionId)
  }
  async upsert(record: ClaudeSessionRecord): Promise<void> {
    await withGenerationFileLock(this.filePath, async () => {
      const file = await this.read()
      const index = file.sessions.findIndex(session => session.sessionId === record.sessionId)
      if (index >= 0) file.sessions[index] = record
      else file.sessions.push(record)
      await durableReplaceText(this.filePath, `${JSON.stringify(file, null, 2)}\n`)
    })
  }
  private async read(): Promise<ClaudeSessionCatalogFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ClaudeSessionCatalogFile
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions))
        throw new Error('unsupported Claude session catalog')
      return parsed
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1, sessions: [] }
    }
  }
}

export class ClaudeEventJournal {
  constructor(readonly filePath: string) {}
  async append(event: AgentEvent): Promise<void> {
    await withGenerationFileLock(this.filePath, () =>
      durableAppendText(this.filePath, `${JSON.stringify(event)}\n`),
    )
  }
  async readAfter(lineOffset: number): Promise<{ events: AgentEvent[]; nextOffset: number }> {
    try {
      const lines = (await readFile(this.filePath, 'utf8')).split('\n').filter(Boolean)
      const events = lines.slice(lineOffset).flatMap(line => {
        try {
          return [JSON.parse(line) as AgentEvent]
        } catch {
          return []
        }
      })
      return { events, nextOffset: lines.length }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], nextOffset: 0 }
      throw error
    }
  }
}

export class ClaudeEventCursor {
  constructor(
    readonly filePath: string,
    readonly legacyFilePath?: string,
  ) {}
  async read(): Promise<number> {
    const current = await readCursor(this.filePath)
    if (current !== undefined) return current
    if (this.legacyFilePath) {
      const legacy = await readCursor(this.legacyFilePath)
      if (legacy !== undefined) {
        await this.write(legacy)
        return legacy
      }
    }
    return 0
  }
  async write(offset: number): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error('Claude event cursor must be a non-negative integer')
    await durableReplaceText(this.filePath, `${offset}\n`)
    if (this.legacyFilePath && this.legacyFilePath !== this.filePath) {
      await advanceSharedCursor(this.legacyFilePath, offset)
    }
  }
}

async function advanceSharedCursor(filePath: string, offset: number): Promise<void> {
  await withGenerationFileLock(filePath, async () => {
    const current = (await readCursor(filePath)) ?? 0
    if (offset > current) await durableReplaceText(filePath, `${offset}\n`)
  })
}

async function readCursor(filePath: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(filePath, 'utf8')).trim())
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
