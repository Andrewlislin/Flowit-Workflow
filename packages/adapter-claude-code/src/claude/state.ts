import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
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
    await withGenerationFileLock(this.filePath, async () => {
      if (await hasIncompleteJournalTail(this.filePath)) {
        throw new Error(
          `Claude event journal ${this.filePath} has an incomplete tail; ` +
            'refusing to append until the journal is recovered',
        )
      }
      await durableAppendText(this.filePath, `${JSON.stringify(event)}\n`)
    })
  }
  async readAfter(lineOffset: number): Promise<{ events: AgentEvent[]; nextOffset: number }> {
    return withGenerationFileLock(this.filePath, async () => {
      const text = await readJournalText(this.filePath)
      const lines = completeJournalLines(text)
      const events: AgentEvent[] = []
      for (let index = lineOffset; index < lines.length; index += 1) {
        try {
          events.push(JSON.parse(lines[index]!) as AgentEvent)
        } catch (error: unknown) {
          if (events.length > 0) return { events, nextOffset: index }
          throw new Error(
            `Claude event journal ${this.filePath} contains a malformed record at line ${index + 1}; ` +
              'cursor advancement is blocked until the journal is recovered',
            { cause: error },
          )
        }
      }
      return { events, nextOffset: lines.length }
    })
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
    if (!this.legacyFilePath || this.legacyFilePath === this.filePath) return 0

    const baseline = await ensureMigrationBaseline(this.legacyFilePath)
    return withGenerationFileLock(this.filePath, async () => {
      const initialized = await readCursor(this.filePath)
      if (initialized !== undefined) return initialized
      await durableReplaceText(this.filePath, `${baseline}\n`)
      return baseline
    })
  }
  async write(offset: number): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error('Claude event cursor must be a non-negative integer')
    if (!this.legacyFilePath || this.legacyFilePath === this.filePath) {
      await withGenerationFileLock(this.filePath, () =>
        durableReplaceText(this.filePath, `${offset}\n`),
      )
      return
    }

    await ensureMigrationBaseline(this.legacyFilePath)
    await withGenerationFileLock(this.filePath, () =>
      durableReplaceText(this.filePath, `${offset}\n`),
    )
    await advanceSharedCursor(this.legacyFilePath, offset)
  }
}

function completeJournalLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  lines.pop()
  return lines
}

async function hasIncompleteJournalTail(filePath: string): Promise<boolean> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const info = await handle.stat()
    if (info.size === 0) return false
    const tail = Buffer.allocUnsafe(1)
    await handle.read(tail, 0, 1, info.size - 1)
    return tail[0] !== 0x0a
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readJournalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function ensureMigrationBaseline(legacyFile: string): Promise<number> {
  const migrationFile = `${legacyFile}.migration-baseline`
  return withGenerationFileLock(migrationFile, async () => {
    const current = await readCursor(migrationFile)
    if (current !== undefined) return current
    return withGenerationFileLock(legacyFile, async () => {
      const baseline = (await readCursor(legacyFile)) ?? 0
      await durableReplaceText(migrationFile, `${baseline}\n`)
      return baseline
    })
  })
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
