import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent, AgentSessionDescriptor } from '../core/types.js'

export interface BridgeStatePaths {
  root: string
  sessionsFile: string
  eventsFile: string
  cursorFile: string
  inboxDir: string
  processingDir: string
  outboxDir: string
  cancelledDir: string
  deadLetterDir: string
  cancellationsDir: string
  receiptsDir: string
  claimsDir: string
}
export interface BridgeSessionRecord extends AgentSessionDescriptor { lastAssistantMessage?: string }

export function bridgeStatePaths(adapterId: string, root?: string): BridgeStatePaths {
  const base = root ?? path.join(process.env.HOME ?? process.cwd(), '.flowit-workflow', 'bridges', adapterId)
  return {
    root: base,
    sessionsFile: path.join(base, 'sessions.json'), eventsFile: path.join(base, 'events.jsonl'), cursorFile: path.join(base, 'events.cursor'),
    inboxDir: path.join(base, 'inbox'), processingDir: path.join(base, 'processing'), outboxDir: path.join(base, 'outbox'),
    cancelledDir: path.join(base, 'cancelled'), deadLetterDir: path.join(base, 'dead-letter'), cancellationsDir: path.join(base, 'cancellations'), receiptsDir: path.join(base, 'receipts'), claimsDir: path.join(base, 'claims'),
  }
}

export async function readBridgeSessions(paths: BridgeStatePaths): Promise<BridgeSessionRecord[]> { try { const value = JSON.parse(await readFile(paths.sessionsFile, 'utf8')) as unknown; return Array.isArray(value) ? value.filter(isSession) : [] } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error } }
export async function upsertBridgeSession(paths: BridgeStatePaths, session: BridgeSessionRecord): Promise<void> { await withFileLock(paths.sessionsFile, async () => { const sessions = await readBridgeSessions(paths); const index = sessions.findIndex(item => item.adapterId === session.adapterId && item.sessionId === session.sessionId); if (index >= 0) sessions[index] = { ...sessions[index]!, ...session }; else sessions.push(session); await atomicJson(paths.sessionsFile, sessions) }) }
export async function appendBridgeEvent(paths: BridgeStatePaths, event: AgentEvent): Promise<void> { await withFileLock(paths.eventsFile, async () => { await mkdir(path.dirname(paths.eventsFile), { recursive: true }); await appendFile(paths.eventsFile, `${JSON.stringify(event)}\n`, 'utf8') }) }
export async function readBridgeEventsAfter(paths: BridgeStatePaths, offset: number): Promise<{ events: AgentEvent[]; nextOffset: number }> { let text = ''; try { text = await readFile(paths.eventsFile, 'utf8') } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } const lines = text.split('\n').filter(Boolean); const events = lines.slice(offset).map(line => JSON.parse(line) as AgentEvent); return { events, nextOffset: lines.length } }
export async function readBridgeCursor(paths: BridgeStatePaths): Promise<number> { try { const value = Number((await readFile(paths.cursorFile, 'utf8')).trim()); return Number.isSafeInteger(value) && value >= 0 ? value : 0 } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error } }
export async function writeBridgeCursor(paths: BridgeStatePaths, value: number): Promise<void> { await mkdir(path.dirname(paths.cursorFile), { recursive: true }); await writeFile(paths.cursorFile, `${value}\n`, 'utf8') }

async function atomicJson(file: string, value: unknown): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, file) }
async function withFileLock<T>(file: string, operation: () => Promise<T>): Promise<T> { await mkdir(path.dirname(file), { recursive: true }); const lock = `${file}.lock`; const deadline = Date.now() + 10_000; while (true) { try { const handle = await open(lock, 'wx'); try { return await operation() } finally { await handle.close().catch(() => undefined); await rm(lock, { force: true }).catch(() => undefined) } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; try { if (Date.now() - (await stat(lock)).mtimeMs > 60_000) await rm(lock, { force: true }) } catch {} if (Date.now() >= deadline) throw new Error(`timed out waiting for bridge state lock: ${lock}`); await new Promise(resolve => setTimeout(resolve, 25)) } } }
function isSession(value: unknown): value is BridgeSessionRecord { if (!value || typeof value !== 'object') return false; const row = value as Record<string, unknown>; return typeof row.adapterId === 'string' && typeof row.sessionId === 'string' && typeof row.status === 'string' }
