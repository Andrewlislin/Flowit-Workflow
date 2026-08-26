import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentEvent, AgentSessionDescriptor } from '../core/types.js'

export interface ClaudeSessionRecord extends AgentSessionDescriptor { adapterId: 'claude-code'; transcriptPath?: string; lastAssistantMessage?: string; lastHookEvent?: string }
interface ClaudeSessionCatalogFile { version: 1; sessions: ClaudeSessionRecord[] }
export interface ClaudeStatePaths { catalogFile: string; eventJournalFile: string; eventCursorFile: string }
export function defaultClaudeStatePaths(): ClaudeStatePaths { const root = path.join(os.homedir(), '.flowit-workflow', 'claude'); return { catalogFile: path.join(root, 'sessions.json'), eventJournalFile: path.join(root, 'events.jsonl'), eventCursorFile: path.join(root, 'events.cursor') } }

export class ClaudeSessionCatalog {
  constructor(readonly filePath: string) {}
  async list(): Promise<ClaudeSessionRecord[]> { return (await this.read()).sessions }
  async get(sessionId: string): Promise<ClaudeSessionRecord | undefined> { return (await this.read()).sessions.find(session => session.sessionId === sessionId) }
  async upsert(record: ClaudeSessionRecord): Promise<void> { await withFileLock(this.filePath, async () => { const file = await this.read(); const index = file.sessions.findIndex(session => session.sessionId === record.sessionId); if (index >= 0) file.sessions[index] = record; else file.sessions.push(record); await atomicWriteJson(this.filePath, file) }) }
  private async read(): Promise<ClaudeSessionCatalogFile> { try { const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ClaudeSessionCatalogFile; if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error('unsupported Claude session catalog'); return parsed } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { version: 1, sessions: [] } } }
}

export class ClaudeEventJournal {
  constructor(readonly filePath: string) {}
  async append(event: AgentEvent): Promise<void> { await mkdir(path.dirname(this.filePath), { recursive: true }); await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8') }
  async readAfter(lineOffset: number): Promise<{ events: AgentEvent[]; nextOffset: number }> { try { const lines = (await readFile(this.filePath, 'utf8')).split('\n').filter(Boolean); const events = lines.slice(lineOffset).flatMap(line => { try { return [JSON.parse(line) as AgentEvent] } catch { return [] } }); return { events, nextOffset: lines.length } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], nextOffset: 0 }; throw error } }
}

export class ClaudeEventCursor {
  constructor(readonly filePath: string) {}
  async read(): Promise<number> { try { const value = Number((await readFile(this.filePath, 'utf8')).trim()); return Number.isSafeInteger(value) && value >= 0 ? value : 0 } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error } }
  async write(offset: number): Promise<void> { if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Claude event cursor must be a non-negative integer'); await mkdir(path.dirname(this.filePath), { recursive: true }); const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${offset}\n`, 'utf8'); await rename(temporary, this.filePath) }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> { await mkdir(path.dirname(filePath), { recursive: true }); const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, filePath) }
async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> { await mkdir(path.dirname(filePath), { recursive: true }); const lockPath = `${filePath}.lock`; const deadline = Date.now() + 5_000; while (true) { try { const handle = await open(lockPath, 'wx'); try { return await operation() } finally { await handle.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined) } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; try { const age = Date.now() - (await stat(lockPath)).mtimeMs; if (age > 30_000) await rm(lockPath, { force: true }) } catch {} if (Date.now() >= deadline) throw new Error(`timed out waiting for Claude session catalog lock: ${lockPath}`); await new Promise(resolve => setTimeout(resolve, 25)) } } }
