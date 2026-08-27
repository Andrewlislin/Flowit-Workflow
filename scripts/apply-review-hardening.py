from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace(path: str, old: str, new: str) -> None:
    text = read(path)
    if old not in text:
        raise RuntimeError(f'expected snippet not found in {path}: {old[:120]!r}')
    write(path, text.replace(old, new, 1))


file_lock = r'''import { randomUUID } from 'node:crypto'
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
    const candidate: FileLockOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }
    try {
      await mkdir(lockDir)
      try {
        await writeOwner(lockDir, candidate)
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      owner = candidate
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const remaining = Math.max(1, deadline - Date.now())
    const recovered = await withFailClosedMutex(
      mutationDir,
      async () => {
        const descriptor = await inspectLock(lockDir)
        if (descriptor.kind === 'missing') return true
        if (descriptor.kind === 'legacy-file') return false
        if (descriptor.owner) {
          if (isProcessAlive(descriptor.owner.pid)) return false
          return moveAside(lockDir, `stale.${descriptor.owner.token}`)
        }
        if (descriptor.ageMs < INITIALIZATION_GRACE_MS) return false
        return moveAside(lockDir, 'uninitialized')
      },
      remaining,
    )
    if (recovered) continue
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

async function releaseGeneration(lockDir: string, mutationDir: string, owner: FileLockOwner): Promise<void> {
  await withFailClosedMutex(mutationDir, async () => {
    const descriptor = await inspectLock(lockDir)
    if (descriptor.kind !== 'directory' || descriptor.owner?.token !== owner.token) return
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

async function inspectLock(lockDir: string): Promise<
  | { kind: 'missing' }
  | { kind: 'legacy-file' }
  | { kind: 'directory'; owner?: FileLockOwner; ageMs: number }
> {
  try {
    const info = await stat(lockDir)
    if (!info.isDirectory()) return { kind: 'legacy-file' }
    return {
      kind: 'directory',
      ...(await readOwner(lockDir).then(owner => (owner ? { owner } : {}))),
      ageMs: Date.now() - info.mtimeMs,
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
}

async function readOwner(lockDir: string): Promise<FileLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8')) as Partial<FileLockOwner>
    if (
      value.version !== 1 ||
      typeof value.token !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.acquiredAt !== 'string'
    ) {
      return undefined
    }
    return value as FileLockOwner
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
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
    if (process.platform === 'win32' && (code === 'EACCES' || code === 'EPERM' || code === 'EINVAL')) return
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
'''
write('packages/core/src/internal/file-lock.ts', file_lock)

# Make the first-party filesystem primitive available to first-party adapter packages.
replace(
    'packages/core/package.json',
    '''    "./bridge/*": {\n      "types": "./dist/bridge/*.d.ts",\n      "default": "./dist/bridge/*.js"\n    }''',
    '''    "./bridge/*": {\n      "types": "./dist/bridge/*.d.ts",\n      "default": "./dist/bridge/*.js"\n    },\n    "./internal/file-lock": {\n      "types": "./dist/internal/file-lock.d.ts",\n      "default": "./dist/internal/file-lock.js"\n    }''',
)

# Core store: generation-safe locking, bounded inbox and durable fsync-backed replacement.
replace(
    'packages/core/src/core/store.ts',
    "import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'",
    "import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'",
)
replace(
    'packages/core/src/core/store.ts',
    "import { isDeepStrictEqual } from 'node:util'",
    "import { isDeepStrictEqual } from 'node:util'\nimport { durableReplaceText, withGenerationFileLock } from '../internal/file-lock.js'",
)
replace(
    'packages/core/src/core/store.ts',
    "    private readonly terminalReceiptRetentionMs = 90 * 24 * 60 * 60 * 1_000,\n  ) {}",
    "    private readonly terminalReceiptRetentionMs = 90 * 24 * 60 * 60 * 1_000,\n    private readonly maxEventInbox = 10_000,\n  ) {}",
)
replace(
    'packages/core/src/core/store.ts',
    "        const receivedAt = (input.receivedAt ?? new Date()).toISOString()\n        const row: PipelineEventAdmission = {",
    "        if (state.eventInbox.length >= this.maxEventInbox) {\n          throw new Error(`pipeline event inbox capacity exceeded (${this.maxEventInbox}); event admission is fail-closed`)\n        }\n        const receivedAt = (input.receivedAt ?? new Date()).toISOString()\n        const row: PipelineEventAdmission = {",
)
replace('packages/core/src/core/store.ts', 'this.mutationTail.then(() => withFileLock(this.filePath, async () => {', 'this.mutationTail.then(() => withGenerationFileLock(this.filePath, async () => {')
replace('packages/core/src/core/store.ts', 'await withFileLock(this.filePath, async () => {', 'await withGenerationFileLock(this.filePath, async () => {')
replace(
    'packages/core/src/core/store.ts',
    "  private async persist(state: WorkflowState): Promise<void> { await mkdir(path.dirname(this.filePath), { recursive: true }); const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`; await writeFile(temporary, `${JSON.stringify(state, null, 2)}\\n`, 'utf8'); await rename(temporary, this.filePath) }",
    "  private async persist(state: WorkflowState): Promise<void> { await durableReplaceText(this.filePath, `${JSON.stringify(state, null, 2)}\\n`) }",
)
replace(
    'packages/core/src/core/store.ts',
    "function normalizeState(parsed: WorkflowState): WorkflowState {\n  if (parsed.version !== 1 || !Array.isArray(parsed.schedules) || !Array.isArray(parsed.pipelines) || !Array.isArray(parsed.runs)) throw new Error('unsupported Flowit Workflow state')\n  parsed.eventInbox = Array.isArray(parsed.eventInbox) ? parsed.eventInbox : []\n  parsed.terminalReceipts = Array.isArray(parsed.terminalReceipts) ? parsed.terminalReceipts : []\n  parsed.runs = parsed.runs.map(run => ({ ...run, attempt: run.attempt ?? 1, updatedAt: run.updatedAt ?? run.completedAt ?? run.startedAt }))\n  return parsed\n}",
    "function normalizeState(parsed: WorkflowState): WorkflowState {\n  if (parsed.version !== 1 || !Array.isArray(parsed.schedules) || !Array.isArray(parsed.pipelines) || !Array.isArray(parsed.runs)) throw new Error('unsupported Flowit Workflow state')\n  parsed.eventInbox = Array.isArray(parsed.eventInbox) ? parsed.eventInbox : []\n  parsed.terminalReceipts = Array.isArray(parsed.terminalReceipts) ? parsed.terminalReceipts : []\n  parsed.runs = parsed.runs.map(run => ({ ...run, attempt: run.attempt ?? 1, updatedAt: run.updatedAt ?? run.completedAt ?? run.startedAt }))\n  const receiptKeys = new Set(parsed.terminalReceipts.map(receipt => `${receipt.kind}\\u0000${receipt.definitionId}\\u0000${receipt.triggerKey}`))\n  for (const run of parsed.runs) {\n    const automatic = run.kind === 'schedule' || !run.triggerKey.startsWith('manual:')\n    if (!automatic) continue\n    run.permanentDedupe ??= true\n    if (run.status !== 'completed' && run.status !== 'dead_letter') continue\n    const key = `${run.kind}\\u0000${run.definitionId}\\u0000${run.triggerKey}`\n    if (receiptKeys.has(key)) continue\n    parsed.terminalReceipts.push({ kind: run.kind, definitionId: run.definitionId, triggerKey: run.triggerKey, status: run.status, recordedAt: run.completedAt ?? run.updatedAt ?? run.startedAt })\n    receiptKeys.add(key)\n  }\n  return parsed\n}",
)
replace(
    'packages/core/src/core/store.ts',
    "  const enter = async (index: number): Promise<T> => index >= paths.length ? operation() : withFileLock(paths[index]!, () => enter(index + 1))",
    "  const enter = async (index: number): Promise<T> => index >= paths.length ? operation() : withGenerationFileLock(paths[index]!, () => enter(index + 1))",
)
old_lock = "async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> { await mkdir(path.dirname(filePath), { recursive: true }); const lockPath = `${filePath}.lock`; const deadline = Date.now() + 10_000; while (true) { try { const handle = await open(lockPath, 'wx'); try { return await operation() } finally { await handle.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined) } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; try { const age = Date.now() - (await stat(lockPath)).mtimeMs; if (age > 60_000) await rm(lockPath, { force: true }) } catch {} if (Date.now() >= deadline) throw new Error(`timed out waiting for workflow store lock: ${lockPath}`); await sleep(25) } } }\n"
replace('packages/core/src/core/store.ts', old_lock, '')

replace(
    'packages/core/src/core/types.ts',
    "  terminalReceiptRetentionMs?: number\n  activeWorkers?: boolean",
    "  terminalReceiptRetentionMs?: number\n  maxEventInbox?: number\n  activeWorkers?: boolean",
)
replace(
    'packages/core/src/core/runtime.ts',
    "    const terminalReceiptRetentionMs = integerAtLeast(config.terminalReceiptRetentionMs ?? 90 * 24 * 60 * 60 * 1_000, 60_000, 'terminalReceiptRetentionMs')",
    "    const terminalReceiptRetentionMs = integerAtLeast(config.terminalReceiptRetentionMs ?? 90 * 24 * 60 * 60 * 1_000, 60_000, 'terminalReceiptRetentionMs')\n    const maxEventInbox = positiveInteger(config.maxEventInbox ?? 10_000, 'maxEventInbox')",
)
replace(
    'packages/core/src/core/runtime.ts',
    "    this.store = new JsonWorkflowStore(storageFile, maxRunHistory, config.legacyStorageFiles ?? [], maxTerminalReceipts, terminalReceiptRetentionMs)",
    "    this.store = new JsonWorkflowStore(storageFile, maxRunHistory, config.legacyStorageFiles ?? [], maxTerminalReceipts, terminalReceiptRetentionMs, maxEventInbox)",
)

# Adapter unregister now owns resource disposal, not only logical fencing.
replace(
    'packages/core/src/core/adapter.ts',
    "      for (const listener of this.unregisteredListeners) listener(adapter)\n    }",
    "      for (const listener of this.unregisteredListeners) listener(adapter)\n      void settleDispose(adapter, ADAPTER_DISPOSE_TIMEOUT_MS)\n    }",
)

# Bridge state uses the generation-safe lock and durable event/cursor writes.
write('packages/core/src/bridge/state.ts', r'''import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent, AgentSessionDescriptor } from '../core/types.js'
import { durableAppendText, durableReplaceText, withGenerationFileLock } from '../internal/file-lock.js'

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
export interface BridgeSessionRecord extends AgentSessionDescriptor { lastAssistantMessage?: string }

export function bridgeStatePaths(adapterId: string, root?: string, consumerId?: string): BridgeStatePaths {
  const base = root ?? path.join(process.env.HOME ?? process.cwd(), '.flowit-workflow', 'bridges', adapterId)
  const legacyCursorFile = path.join(base, 'events.cursor')
  const cursorFile = consumerId?.trim()
    ? path.join(base, 'cursors', `${createHash('sha256').update(consumerId).digest('hex')}.cursor`)
    : legacyCursorFile
  return {
    root: base,
    sessionsFile: path.join(base, 'sessions.json'), eventsFile: path.join(base, 'events.jsonl'), cursorFile, legacyCursorFile,
    inboxDir: path.join(base, 'inbox'), processingDir: path.join(base, 'processing'), outboxDir: path.join(base, 'outbox'),
    cancelledDir: path.join(base, 'cancelled'), deadLetterDir: path.join(base, 'dead-letter'), cancellationsDir: path.join(base, 'cancellations'), receiptsDir: path.join(base, 'receipts'), claimsDir: path.join(base, 'claims'),
  }
}

export async function readBridgeSessions(paths: BridgeStatePaths): Promise<BridgeSessionRecord[]> {
  try { const value = JSON.parse(await readFile(paths.sessionsFile, 'utf8')) as unknown; return Array.isArray(value) ? value.filter(isSession) : [] }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
export async function upsertBridgeSession(paths: BridgeStatePaths, session: BridgeSessionRecord): Promise<void> {
  await withGenerationFileLock(paths.sessionsFile, async () => {
    const sessions = await readBridgeSessions(paths)
    const index = sessions.findIndex(item => item.adapterId === session.adapterId && item.sessionId === session.sessionId)
    if (index >= 0) sessions[index] = { ...sessions[index]!, ...session }; else sessions.push(session)
    await durableReplaceText(paths.sessionsFile, `${JSON.stringify(sessions, null, 2)}\n`)
  })
}
export async function appendBridgeEvent(paths: BridgeStatePaths, event: AgentEvent): Promise<void> {
  await withGenerationFileLock(paths.eventsFile, () => durableAppendText(paths.eventsFile, `${JSON.stringify(event)}\n`))
}
export async function readBridgeEventsAfter(paths: BridgeStatePaths, offset: number): Promise<{ events: AgentEvent[]; nextOffset: number }> {
  let text = ''
  try { text = await readFile(paths.eventsFile, 'utf8') } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const lines = text.split('\n').filter(Boolean)
  const events = lines.slice(offset).map(line => JSON.parse(line) as AgentEvent)
  return { events, nextOffset: lines.length }
}
export async function readBridgeCursor(paths: BridgeStatePaths): Promise<number> {
  const current = await readCursor(paths.cursorFile)
  if (current !== undefined) return current
  if (paths.cursorFile !== paths.legacyCursorFile) {
    const legacy = await readCursor(paths.legacyCursorFile)
    if (legacy !== undefined) { await writeBridgeCursor(paths, legacy); return legacy }
  }
  return 0
}
export async function writeBridgeCursor(paths: BridgeStatePaths, value: number): Promise<void> {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('bridge event cursor must be a non-negative integer')
  await durableReplaceText(paths.cursorFile, `${value}\n`)
}

async function readCursor(file: string): Promise<number | undefined> {
  try { const value = Number((await readFile(file, 'utf8')).trim()); return Number.isSafeInteger(value) && value >= 0 ? value : 0 }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
function isSession(value: unknown): value is BridgeSessionRecord { if (!value || typeof value !== 'object') return false; const row = value as Record<string, unknown>; return typeof row.adapterId === 'string' && typeof row.sessionId === 'string' && typeof row.status === 'string' }
''')

# Receipt corruption is now fail-closed. Automatic quarantine can race an external publisher.
replace(
    'packages/core/src/bridge/receipt.ts',
    "import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'",
    "import { link, mkdir, open, readFile, rm } from 'node:fs/promises'",
)
replace(
    'packages/core/src/bridge/receipt.ts',
    "    if (error instanceof SyntaxError || error instanceof InvalidBridgeReceiptError) {\n      await quarantineReceipt(file)\n      return undefined\n    }",
    "    if (error instanceof SyntaxError || error instanceof InvalidBridgeReceiptError) {\n      throw new InvalidBridgeReceiptError(`bridge receipt ${file} is malformed; automatic quarantine is disabled to avoid racing a concurrent publisher`)\n    }",
)
start = read('packages/core/src/bridge/receipt.ts')
q_start = start.find('async function quarantineReceipt(')
q_end = start.find('\nasync function syncDirectory(', q_start)
if q_start < 0 or q_end < 0:
    raise RuntimeError('quarantineReceipt function not found')
write('packages/core/src/bridge/receipt.ts', start[:q_start] + start[q_end + 1:])

# Claude state: shared journal/catalog, per-consumer cursor, safe lock and durable writes.
write('packages/adapter-claude-code/src/claude/state.ts', r'''import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentEvent, AgentSessionDescriptor } from '@coaseedge/flowit-core'
import { durableAppendText, durableReplaceText, withGenerationFileLock } from '@coaseedge/flowit-core/internal/file-lock'

export interface ClaudeSessionRecord extends AgentSessionDescriptor { adapterId: 'claude-code'; transcriptPath?: string; lastAssistantMessage?: string; lastHookEvent?: string }
interface ClaudeSessionCatalogFile { version: 1; sessions: ClaudeSessionRecord[] }
export interface ClaudeStatePaths { catalogFile: string; eventJournalFile: string; eventCursorFile: string; legacyEventCursorFile?: string }
export function defaultClaudeStatePaths(consumerId?: string): ClaudeStatePaths {
  const root = path.join(os.homedir(), '.flowit-workflow', 'claude')
  const legacyEventCursorFile = path.join(root, 'events.cursor')
  const eventCursorFile = consumerId?.trim()
    ? path.join(root, 'cursors', `${createHash('sha256').update(consumerId).digest('hex')}.cursor`)
    : legacyEventCursorFile
  return { catalogFile: path.join(root, 'sessions.json'), eventJournalFile: path.join(root, 'events.jsonl'), eventCursorFile, ...(eventCursorFile !== legacyEventCursorFile ? { legacyEventCursorFile } : {}) }
}

export class ClaudeSessionCatalog {
  constructor(readonly filePath: string) {}
  async list(): Promise<ClaudeSessionRecord[]> { return (await this.read()).sessions }
  async get(sessionId: string): Promise<ClaudeSessionRecord | undefined> { return (await this.read()).sessions.find(session => session.sessionId === sessionId) }
  async upsert(record: ClaudeSessionRecord): Promise<void> {
    await withGenerationFileLock(this.filePath, async () => {
      const file = await this.read()
      const index = file.sessions.findIndex(session => session.sessionId === record.sessionId)
      if (index >= 0) file.sessions[index] = record; else file.sessions.push(record)
      await durableReplaceText(this.filePath, `${JSON.stringify(file, null, 2)}\n`)
    })
  }
  private async read(): Promise<ClaudeSessionCatalogFile> {
    try { const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ClaudeSessionCatalogFile; if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error('unsupported Claude session catalog'); return parsed }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { version: 1, sessions: [] } }
  }
}

export class ClaudeEventJournal {
  constructor(readonly filePath: string) {}
  async append(event: AgentEvent): Promise<void> { await withGenerationFileLock(this.filePath, () => durableAppendText(this.filePath, `${JSON.stringify(event)}\n`)) }
  async readAfter(lineOffset: number): Promise<{ events: AgentEvent[]; nextOffset: number }> {
    try { const lines = (await readFile(this.filePath, 'utf8')).split('\n').filter(Boolean); const events = lines.slice(lineOffset).flatMap(line => { try { return [JSON.parse(line) as AgentEvent] } catch { return [] } }); return { events, nextOffset: lines.length } }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], nextOffset: 0 }; throw error }
  }
}

export class ClaudeEventCursor {
  constructor(readonly filePath: string, readonly legacyFilePath?: string) {}
  async read(): Promise<number> {
    const current = await readCursor(this.filePath)
    if (current !== undefined) return current
    if (this.legacyFilePath) {
      const legacy = await readCursor(this.legacyFilePath)
      if (legacy !== undefined) { await this.write(legacy); return legacy }
    }
    return 0
  }
  async write(offset: number): Promise<void> { if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Claude event cursor must be a non-negative integer'); await durableReplaceText(this.filePath, `${offset}\n`) }
}

async function readCursor(filePath: string): Promise<number | undefined> {
  try { const value = Number((await readFile(filePath, 'utf8')).trim()); return Number.isSafeInteger(value) && value >= 0 ? value : 0 }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
''')
replace(
    'packages/adapter-claude-code/src/adapters/claude-code.ts',
    "export interface ClaudeCodeAdapterConfig { executable?: string; pluginDir?: string; wrapperSkill?: string; statePaths?: ClaudeStatePaths; pollIntervalMs?: number; contextSummaryMaxChars?: number; allowResumeLiveSession?: boolean }",
    "export interface ClaudeCodeAdapterConfig { executable?: string; pluginDir?: string; wrapperSkill?: string; statePaths?: ClaudeStatePaths; consumerId?: string; pollIntervalMs?: number; contextSummaryMaxChars?: number; allowResumeLiveSession?: boolean }",
)
replace(
    'packages/adapter-claude-code/src/adapters/claude-code.ts',
    "this.statePaths = config.statePaths ?? defaultClaudeStatePaths();",
    "this.statePaths = config.statePaths ?? defaultClaudeStatePaths(config.consumerId);",
)
replace(
    'packages/adapter-claude-code/src/adapters/claude-code.ts',
    "this.cursor = new ClaudeEventCursor(this.statePaths.eventCursorFile)",
    "this.cursor = new ClaudeEventCursor(this.statePaths.eventCursorFile, this.statePaths.legacyEventCursorFile)",
)

# File bridge supports an explicit consumer identity for independent durable cursors.
replace(
    'packages/adapter-file-bridge/src/index.ts',
    "export interface FileBridgeAdapterConfig { adapterId: string; root?: string; pollIntervalMs?: number; dispatchTimeoutMs?: number; executionLeaseMs?: number; capabilities?: Partial<AgentAdapterCapabilities> }",
    "export interface FileBridgeAdapterConfig { adapterId: string; root?: string; consumerId?: string; pollIntervalMs?: number; dispatchTimeoutMs?: number; executionLeaseMs?: number; capabilities?: Partial<AgentAdapterCapabilities> }",
)
replace(
    'packages/adapter-file-bridge/src/index.ts',
    "    this.paths = bridgeStatePaths(this.id, config.root)",
    "    this.paths = bridgeStatePaths(this.id, config.root, config.consumerId)",
)

# Codex must restart its app-server generation after a spontaneous child exit.
replace(
    'packages/adapter-codex/src/index.ts',
    "child.on('close', (code, closeSignal) => { const error = new Error(`Codex app-server exited (${code ?? 'null'}, ${closeSignal ?? 'no-signal'})`); this.closedError = error; this.rejectAll(error); if (this.process === child) this.process = undefined })",
    "child.on('close', (code, closeSignal) => { const error = new Error(`Codex app-server exited (${code ?? 'null'}, ${closeSignal ?? 'no-signal'})`); this.closedError = error; this.rejectAll(error); this.notificationBuffer.length = 0; if (this.process === child) { this.process = undefined; this.started = undefined } })",
)

# Root compatibility distribution delegates to workspace packages instead of maintaining duplicate implementations.
core_wrappers = ['adapter', 'context-graph', 'dispatcher', 'domain', 'lease', 'pipeline', 'runtime', 'scheduler', 'skill-binding', 'store', 'types', 'utils']
for name in core_wrappers:
    write(f'src/core/{name}.ts', f"export * from '@coaseedge/flowit-core/core/{name}'\n")
write('src/core/index.ts', "export * from '@coaseedge/flowit-core'\n")
for name in ['execution-lease', 'hook', 'receipt', 'state']:
    write(f'src/bridge/{name}.ts', f"export * from '@coaseedge/flowit-core/bridge/{name}'\n")
adapter_packages = {
    'claude-code': '@coaseedge/flowit-adapter-claude-code',
    'opencode': '@coaseedge/flowit-adapter-opencode',
    'codex': '@coaseedge/flowit-adapter-codex',
    'dsh': '@coaseedge/flowit-adapter-dsh',
    'file-bridge': '@coaseedge/flowit-adapter-file-bridge',
    'workbuddy': '@coaseedge/flowit-adapter-workbuddy',
    'doubao-office': '@coaseedge/flowit-adapter-doubao-office',
}
for name, package in adapter_packages.items():
    write(f'src/adapters/{name}.ts', f"export * from '{package}'\n")
write('src/claude/state.ts', "export * from '@coaseedge/flowit-adapter-claude-code/state'\n")
write('src/claude/hook.ts', "export * from '@coaseedge/flowit-adapter-claude-code/hook'\n")
write('src/claude/runtime.ts', "export * from '@coaseedge/flowit-adapter-claude-code/runtime'\n")
write('src/claude/index.ts', "export * from '@coaseedge/flowit-adapter-claude-code/claude'\n")
write('src/dsh/plugin.ts', "export * from '@coaseedge/flowit-adapter-dsh/plugin'\n")
write('src/dsh/tools.ts', "export * from '@coaseedge/flowit-adapter-dsh/tools'\n")

# Daemon takeover/release is serialized by a fail-closed mutation mutex.
replace(
    'src/daemon-lease.ts',
    "import path from 'node:path'",
    "import path from 'node:path'\nimport { withFailClosedMutex } from '@coaseedge/flowit-core/internal/file-lock'",
)
replace(
    'src/daemon-lease.ts',
    "  const lockDir = path.join(root, `${key}.lock`)\n  const initializationGraceMs",
    "  const lockDir = path.join(root, `${key}.lock`)\n  const mutationDir = path.join(root, '.mutation', `${key}.lock`)\n  const initializationGraceMs",
)
old_block = """    const metadata = await readOwner(lockDir)\n    if (!metadata) {\n      const age = await stat(lockDir).then(value => Date.now() - value.mtimeMs).catch(() => 0)\n      if (age < initializationGraceMs) { await sleep(25); continue }\n      if (await moveAside(lockDir, 'uninitialized')) continue\n      await sleep(25); continue\n    }\n    if (isProcessAlive(metadata.pid)) throw new Error(`Flowit Workflow worker already owns storage ${canonicalStorageFile} (pid ${metadata.pid}, instance ${metadata.instanceId})`)\n    if (await moveAside(lockDir, 'stale')) continue\n    await sleep(25)"""
new_block = """    const recovered = await withFailClosedMutex(mutationDir, async () => {\n      const metadata = await readOwner(lockDir)\n      if (!metadata) {\n        const age = await stat(lockDir).then(value => Date.now() - value.mtimeMs).catch(() => 0)\n        if (age < initializationGraceMs) return false\n        return moveAside(lockDir, 'uninitialized')\n      }\n      if (isProcessAlive(metadata.pid)) throw new Error(`Flowit Workflow worker already owns storage ${canonicalStorageFile} (pid ${metadata.pid}, instance ${metadata.instanceId})`)\n      return moveAside(lockDir, `stale.${metadata.ownerToken}`)\n    }, Math.max(1, deadline - Date.now()))\n    if (recovered) continue\n    await sleep(25)"""
replace('src/daemon-lease.ts', old_block, new_block)
replace(
    'src/daemon-lease.ts',
    "      return createLease(lockDir, metadata)",
    "      return createLease(lockDir, mutationDir, metadata)",
)
replace(
    'src/daemon-lease.ts',
    "function createLease(lockDir: string, metadata: DaemonLeaseMetadata): DaemonLease {",
    "function createLease(lockDir: string, mutationDir: string, metadata: DaemonLeaseMetadata): DaemonLease {",
)
replace(
    'src/daemon-lease.ts',
    "    async release(): Promise<boolean> {\n      const current = await readOwner(lockDir)\n      if (!current || current.ownerToken !== metadata.ownerToken) return false\n      const releasing = `${lockDir}.release.${metadata.ownerToken}`\n      try { await rename(lockDir, releasing) }\n      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }\n      await rm(releasing, { recursive: true, force: true })\n      return true\n    },",
    "    async release(): Promise<boolean> {\n      return withFailClosedMutex(mutationDir, async () => {\n        const current = await readOwner(lockDir)\n        if (!current || current.ownerToken !== metadata.ownerToken) return false\n        const releasing = `${lockDir}.release.${metadata.ownerToken}`\n        try { await rename(lockDir, releasing) }\n        catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }\n        await rm(releasing, { recursive: true, force: true })\n        return true\n      })\n    },",
)

# Aggregate runtime exposes event-inbox capacity and gives host journals a storage-scoped consumer identity.
replace('src/runtime-factory.ts', '  terminalReceiptRetentionMs?: number\n  leaseDurationMs?: number', '  terminalReceiptRetentionMs?: number\n  maxEventInbox?: number\n  leaseDurationMs?: number')
replace('src/runtime-factory.ts', '  terminalReceiptRetentionMs: number\n  leaseDurationMs: number', '  terminalReceiptRetentionMs: number\n  maxEventInbox: number\n  leaseDurationMs: number')
replace('src/runtime-factory.ts', '    terminalReceiptRetentionMs: options.terminalReceiptRetentionMs ?? 90 * 24 * 60 * 60 * 1_000,\n    leaseDurationMs:', '    terminalReceiptRetentionMs: options.terminalReceiptRetentionMs ?? 90 * 24 * 60 * 60 * 1_000,\n    maxEventInbox: options.maxEventInbox ?? 10_000,\n    leaseDurationMs:')
replace('src/runtime-factory.ts', '  const resolved = resolveConfiguredRuntime(options); const adapters = resolved.adapterIds.map(createBuiltInAdapter)', '  const resolved = resolveConfiguredRuntime(options); const adapters = resolved.adapterIds.map(id => createBuiltInAdapter(id, resolved.storageFile))')
replace('src/runtime-factory.ts', '    maxTerminalReceipts: resolved.maxTerminalReceipts, terminalReceiptRetentionMs: resolved.terminalReceiptRetentionMs,\n    activeWorkers:', '    maxTerminalReceipts: resolved.maxTerminalReceipts, terminalReceiptRetentionMs: resolved.terminalReceiptRetentionMs, maxEventInbox: resolved.maxEventInbox,\n    activeWorkers:')
replace('src/runtime-factory.ts', 'export function createBuiltInAdapter(id: BuiltInAdapterId): AgentAdapter {', 'export function createBuiltInAdapter(id: BuiltInAdapterId, consumerId?: string): AgentAdapter {')
replace('src/runtime-factory.ts', "case CLAUDE_CODE_ADAPTER_ID: return new ClaudeCodeAgentAdapter({ ...(process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT ? { pluginDir: process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT } : {}),", "case CLAUDE_CODE_ADAPTER_ID: return new ClaudeCodeAgentAdapter({ ...(consumerId ? { consumerId } : {}), ...(process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT ? { pluginDir: process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT } : {}),")
replace('src/runtime-factory.ts', "case WORKBUDDY_ADAPTER_ID: { const dispatchCommand = parseCommand(process.env.FLOWIT_WORKFLOW_WORKBUDDY_DRIVER); return new WorkBuddyAgentAdapter({ ...(dispatchCommand ? { dispatchCommand } : {}),", "case WORKBUDDY_ADAPTER_ID: { const dispatchCommand = parseCommand(process.env.FLOWIT_WORKFLOW_WORKBUDDY_DRIVER); return new WorkBuddyAgentAdapter({ ...(consumerId ? { consumerId } : {}), ...(dispatchCommand ? { dispatchCommand } : {}),")
replace('src/runtime-factory.ts', "case DOUBAO_OFFICE_ADAPTER_ID: return new DoubaoOfficeAgentAdapter()", "case DOUBAO_OFFICE_ADAPTER_ID: return new DoubaoOfficeAgentAdapter(consumerId ? { consumerId } : {})")
replace('src/runtime-factory.ts', "function envAdapter(): BuiltInAdapterId | undefined { const value = process.env.FLOWIT_WORKFLOW_ADAPTER; return isBuiltInAdapterId(value) ? value : undefined }", "function envAdapter(): BuiltInAdapterId | undefined { const value = process.env.FLOWIT_WORKFLOW_ADAPTER; if (!value?.trim()) return undefined; return requireBuiltInAdapterId(value, 'FLOWIT_WORKFLOW_ADAPTER') }")
replace('src/runtime-factory.ts', "function envAdapters(): BuiltInAdapterId[] | undefined { const value = process.env.FLOWIT_WORKFLOW_ADAPTERS; if (!value) return undefined; const result = value.split(',').map(item => item.trim()).filter(isBuiltInAdapterId); return result.length ? result : undefined }", "function envAdapters(): BuiltInAdapterId[] | undefined { const value = process.env.FLOWIT_WORKFLOW_ADAPTERS; if (!value?.trim()) return undefined; return value.split(',').map(item => requireBuiltInAdapterId(item.trim(), 'FLOWIT_WORKFLOW_ADAPTERS')) }")

# Pack gate inspects the packed manifests, not only tarball count.
replace(
    'scripts/check-package-packs.mjs',
    "import { spawnSync } from 'node:child_process'",
    "import { spawnSync } from 'node:child_process'\nimport path from 'node:path'",
)
replace(
    'scripts/check-package-packs.mjs',
    "if (tarballs.length !== packages.length + 1) {\n  throw new Error(`expected ${packages.length + 1} package tarballs, found ${tarballs.length}`)\n}\nconsole.log(`Package pack smoke test passed for ${tarballs.length} tarballs.`)",
    "if (tarballs.length !== packages.length + 1) {\n  throw new Error(`expected ${packages.length + 1} package tarballs, found ${tarballs.length}`)\n}\nfor (const tarball of tarballs) {\n  const packed = spawnSync('tar', ['-xOzf', path.join(out, tarball), 'package/package.json'], { encoding: 'utf8' })\n  if (packed.status !== 0) throw new Error(`cannot inspect packed manifest for ${tarball}: ${packed.stderr}`)\n  const manifest = JSON.parse(packed.stdout)\n  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {\n    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {\n      if (typeof specifier === 'string' && specifier.startsWith('workspace:')) throw new Error(`${tarball} leaked workspace protocol for ${section}.${name}`)\n    }\n  }\n}\nconsole.log(`Package pack smoke test passed for ${tarballs.length} tarballs with publishable manifests.`)",
)

# Package-boundary gate also prevents the compatibility layer from drifting into duplicate implementations again.
replace(
    'scripts/check-package-boundaries.mjs',
    "console.log(`Package boundary policy passed for ${manifests.size} workspace packages.`)",
    "const compatibilityWrappers = [\n  ...['adapter','context-graph','dispatcher','domain','lease','pipeline','runtime','scheduler','skill-binding','store','types','utils'].map(name => `src/core/${name}.ts`),\n  ...['execution-lease','hook','receipt','state'].map(name => `src/bridge/${name}.ts`),\n  ...['claude-code','opencode','codex','dsh','file-bridge','workbuddy','doubao-office'].map(name => `src/adapters/${name}.ts`),\n]\nfor (const filename of compatibilityWrappers) {\n  const source = (await readFile(filename, 'utf8')).trim()\n  if (!source.startsWith('export * from')) throw new Error(`compatibility wrapper ${filename} must delegate to its workspace package`)\n}\n\nconsole.log(`Package boundary policy passed for ${manifests.size} workspace packages.`)",
)

# Documentation follows the post-monorepo source layout and fail-closed receipt behavior.
replace('docs/adapter-contract.md', '`src/core/types.ts` is the host boundary.', '`packages/core/src/core/types.ts` is the host boundary. The root `src/core/*` files are compatibility re-exports only.')
replace('docs/adapter-contract.md', 'should be added under `src/adapters/` with:', 'should be added as a dedicated `packages/adapter-*/` workspace package with:')
replace(
    'integrations/bridge/PROTOCOL.md',
    '5. If `receiptPath` contains malformed JSON, the wrong idempotency key, or a non-completed/unknown schema, move it to `receipts/quarantine/` and treat the logical task as not yet completed.',
    '5. If `receiptPath` contains malformed JSON, the wrong idempotency key, or a non-completed/unknown schema, fail closed. Flowit readers do not automatically move a malformed stable receipt because renaming by path can race a concurrent publisher. Quarantine/removal requires an explicit Worker/operator recovery step after verifying no active publisher owns that logical key.',
)

# Tests: daemon stale-generation race.
with open(ROOT / 'tests/daemon-lease.test.ts', 'a') as handle:
    handle.write(r'''

test('two contenders cannot both take over the same stale daemon generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-daemon-stale-race-'))
  const storage = path.join(root, 'state', 'workflow.json')
  const leaseRoot = path.join(root, 'leases')
  const gate = path.join(root, 'go')
  const fixture = fileURLToPath(new URL('./fixtures/daemon-lease-child.ts', import.meta.url))
  try {
    const canonical = await canonicalStorageIdentity(storage)
    const key = createHash('sha256').update(canonical).digest('hex')
    const lockDir = path.join(leaseRoot, `${key}.lock`)
    await mkdir(lockDir, { recursive: true })
    await writeFile(path.join(lockDir, 'owner.json'), `${JSON.stringify({ version: 1, ownerToken: 'dead-generation', pid: 2_147_483_647, instanceId: 'dead', storageFile: canonical, startedAt: new Date().toISOString() })}\n`, 'utf8')
    const first = runContender(fixture, storage, leaseRoot, gate, 'contender-a')
    const second = runContender(fixture, storage, leaseRoot, gate, 'contender-b')
    await writeFile(gate, 'go\n', 'utf8')
    const results = await Promise.all([first, second])
    const parsed = results.map(result => JSON.parse(result.stdout.trim()) as { acquired: boolean; error?: string })
    assert.equal(parsed.filter(row => row.acquired).length, 1, results.map(row => row.stderr).join('\n'))
    assert.equal(parsed.filter(row => !row.acquired).length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
''')

# Store lock serialization and inbox/backfill coverage.
write('tests/file-lock-race.test.ts', r'''import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withGenerationFileLock } from '@coaseedge/flowit-core/internal/file-lock'

function deadPid(): number { return 2_147_483_647 }

test('generation file lock serializes contenders after stale recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-file-lock-race-'))
  const file = path.join(root, 'state.json')
  const lockDir = `${file}.lock`
  let active = 0
  let maxActive = 0
  try {
    await mkdir(lockDir, { recursive: true })
    await writeFile(path.join(lockDir, 'owner.json'), `${JSON.stringify({ version: 1, token: 'dead', pid: deadPid(), acquiredAt: new Date().toISOString() })}\n`, 'utf8')
    const operation = () => withGenerationFileLock(file, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 40))
      active -= 1
    })
    await Promise.all([operation(), operation()])
    assert.equal(maxActive, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
''')

with open(ROOT / 'tests/durable-claims.test.ts', 'a') as handle:
    handle.write(r'''

test('event inbox capacity fails closed without partially admitting a batch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-inbox-cap-')); const file = path.join(root, 'workflow.json')
  const store = new JsonWorkflowStore(file, 500, [], 100_000, TEST_RETENTION_MS, 1)
  const now = new Date().toISOString()
  try {
    await store.putPipeline({ id: 'p-cap', name: 'cap', trigger: { kind: 'manual' }, nodes: [], edges: [], status: 'active', createdAt: now, updatedAt: now })
    const event = { adapterId: 'test', sessionId: 's1', kind: 'turn_completed' as const, eventId: 'e1', at: now }
    await assert.rejects(store.admitPipelineTriggers([
      { pipelineId: 'p-cap', triggerKey: 'event:1', event },
      { pipelineId: 'p-cap', triggerKey: 'event:2', event: { ...event, eventId: 'e2' } },
    ]), /event inbox capacity exceeded/)
    assert.equal((await store.snapshot()).eventInbox.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('legacy automatic terminal runs backfill receipts before run-history pruning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-receipt-backfill-')); const file = path.join(root, 'workflow.json')
  const at = new Date().toISOString()
  try {
    await import('node:fs/promises').then(fs => fs.writeFile(file, `${JSON.stringify({ version: 1, schedules: [], pipelines: [], eventInbox: [], terminalReceipts: [], runs: [{ id: 'legacy-run', kind: 'pipeline', definitionId: 'p', triggerKey: 'agent:test:s:turn_completed:e', status: 'completed', attempt: 1, startedAt: at, updatedAt: at, completedAt: at }] }, null, 2)}\n`, 'utf8'))
    const store = new JsonWorkflowStore(file, 1, [], 100_000, TEST_RETENTION_MS)
    const initial = await store.snapshot()
    assert.equal(initial.terminalReceipts.some(receipt => receipt.triggerKey === 'agent:test:s:turn_completed:e' && receipt.status === 'completed'), true)
    const other = await store.claimRun({ kind: 'schedule', definitionId: 'other', triggerKey: 'other', owner: 'worker', leaseDurationMs: 1000, maxAttempts: 1 })
    if (other.kind === 'claimed') await store.completeRun(other.run.id, 'worker')
    const duplicate = await store.claimRun({ kind: 'pipeline', definitionId: 'p', triggerKey: 'agent:test:s:turn_completed:e', owner: 'worker-2', leaseDurationMs: 1000, maxAttempts: 1, permanentDedupe: true })
    assert.equal(duplicate.kind, 'completed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
''')

# Adapter unregister disposal coverage.
replace('tests/adapter-readiness.test.ts', '  aborted = false\n  private resolveStart?', '  aborted = false\n  disposals = 0\n  private resolveStart?')
replace('tests/adapter-readiness.test.ts', '  subscribe(_listener: (event: AgentEvent) => Promise<void> | void): () => void { this.subscriptions += 1; return () => { this.subscriptions -= 1 } }\n}', '  subscribe(_listener: (event: AgentEvent) => Promise<void> | void): () => void { this.subscriptions += 1; return () => { this.subscriptions -= 1 } }\n  async dispose(): Promise<void> { this.disposals += 1 }\n}')
with open(ROOT / 'tests/adapter-readiness.test.ts', 'a') as handle:
    handle.write(r'''

test('unregister disposes the removed adapter generation', async () => {
  const registry = new AgentAdapterRegistry()
  const adapter = new StartupAdapter('disposable')
  adapter.succeed()
  const unregister = registry.register(adapter)
  await registry.start(adapter)
  unregister()
  await waitUntil(() => adapter.disposals === 1)
  assert.equal(registry.get(adapter.id), undefined)
  await registry.dispose()
  assert.equal(adapter.disposals, 1)
})
''')

# Codex restart coverage with one intentional crash generation.
with open(ROOT / 'tests/contracts/codex-app-server.test.ts', 'a') as handle:
    handle.write(r'''

async function restartableCodex(root: string): Promise<string> {
  const file = path.join(root, 'codex-restartable')
  const marker = path.join(root, 'crashed-once')
  const source = `#!/usr/bin/env node
const fs = require('node:fs'); const readline = require('node:readline'); const marker = ${JSON.stringify(marker)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity }); const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => { const msg = JSON.parse(line); if (msg.method === 'initialized') return; if (msg.id === undefined || msg.id === null) return;
 if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'fake'}});
 if (msg.method === 'thread/resume') return send({id:msg.id,result:{thread:{id:'thr-1',status:'idle',cwd:process.cwd()}}});
 if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
 if (msg.method === 'turn/start') { send({id:msg.id,result:{turn:{id:'turn-1',status:'inProgress'}}}); if (!fs.existsSync(marker)) { fs.writeFileSync(marker,'1'); return setTimeout(() => process.exit(2), 5); } return send({method:'turn/completed',params:{threadId:'thr-1',turn:{id:'turn-1',status:'completed',error:null}}}); }
 if (msg.method === 'thread/read') return send({id:msg.id,result:{thread:{id:'thr-1'},turns:[{id:'turn-1'}]}});
});
`
  await writeFile(file, source, 'utf8'); await chmod(file, 0o755); return file
}

test('Codex adapter restarts app-server after a spontaneous child exit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-restart-'))
  const adapter = new CodexAgentAdapter({ executable: await restartableCodex(root), requestTimeoutMs: 500, turnTimeoutMs: 1_000 })
  try {
    await assert.rejects(adapter.dispatch(request()), /exited/)
    const result = await adapter.dispatch(request())
    assert.equal(result.runId, 'turn-1')
  } finally { await adapter.dispose(); await rm(root, { recursive: true, force: true }) }
})
''')

# Corrupt receipt now fails closed instead of moving a path that a concurrent publisher may replace.
old_corrupt = r'''test('a half-written receipt is quarantined and a new transport attempt can complete', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-corrupt-')); const adapter = new WorkBuddyAgentAdapter({ root, pollIntervalMs: 5, dispatchTimeoutMs: 2_000 }); const paths = bridgeStatePaths('workbuddy', root)
  const correlationId = 'corrupt-receipt'
  try {
    await mkdir(paths.receiptsDir, { recursive: true })
    const digest = createHash('sha256').update(correlationId).digest('hex')
    const receiptFile = path.join(paths.receiptsDir, `${digest}.json`)
    await writeFile(receiptFile, '{"version":1,"idempotencyKey":', 'utf8')

    const pending = adapter.dispatch({ correlationId, sessionId: 'target', prompt: 'work', skills: [], contextRefs: [] })
    const inboxName = await waitForInbox(paths.inboxDir)
    const envelope = JSON.parse(await readFile(path.join(paths.inboxDir, inboxName), 'utf8')) as { requestId:string }
    await writeFile(path.join(paths.outboxDir, `${envelope.requestId}.json`), `${JSON.stringify({ sessionId: 'target', loadedSkills: [], referencedSessions: [], outputSummary: 'recovered' })}\n`, 'utf8')
    const result = await pending
    assert.equal(result.outputSummary, 'recovered')
    assert.equal((await readdir(path.join(paths.receiptsDir, 'quarantine'))).filter(name => name.endsWith('.corrupt')).length, 1)
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as {status:string;idempotencyKey:string}
    assert.equal(receipt.status, 'completed')
    assert.equal(receipt.idempotencyKey, correlationId)
  } finally { await rm(root, { recursive: true, force: true }) }
})'''
new_corrupt = r'''test('a malformed stable receipt fails closed without moving or re-executing it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-bridge-corrupt-')); const adapter = new WorkBuddyAgentAdapter({ root, pollIntervalMs: 5, dispatchTimeoutMs: 2_000 }); const paths = bridgeStatePaths('workbuddy', root)
  const correlationId = 'corrupt-receipt'
  try {
    await mkdir(paths.receiptsDir, { recursive: true })
    const digest = createHash('sha256').update(correlationId).digest('hex')
    const receiptFile = path.join(paths.receiptsDir, `${digest}.json`)
    const corrupt = '{"version":1,"idempotencyKey":'
    await writeFile(receiptFile, corrupt, 'utf8')
    await assert.rejects(adapter.dispatch({ correlationId, sessionId: 'target', prompt: 'work', skills: [], contextRefs: [] }), /malformed|quarantine is disabled/)
    assert.equal(await readFile(receiptFile, 'utf8'), corrupt)
    assert.equal((await readdir(paths.inboxDir).catch(() => [] as string[])).filter(name => name.endsWith('.json')).length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})'''
replace('tests/bridge-cancellation.test.ts', old_corrupt, new_corrupt)

# Consumer cursor isolation and legacy seeding.
write('tests/cursor-isolation.test.ts', r'''import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { bridgeStatePaths, readBridgeCursor } from '../src/bridge/state.js'
import { ClaudeEventCursor, defaultClaudeStatePaths } from '../src/claude/state.js'

test('workflow consumers use independent Claude and bridge cursors', () => {
  const claudeA = defaultClaudeStatePaths('/tmp/workflow-a.json')
  const claudeB = defaultClaudeStatePaths('/tmp/workflow-b.json')
  assert.equal(claudeA.eventJournalFile, claudeB.eventJournalFile)
  assert.notEqual(claudeA.eventCursorFile, claudeB.eventCursorFile)

  const bridgeA = bridgeStatePaths('workbuddy', '/tmp/bridge', '/tmp/workflow-a.json')
  const bridgeB = bridgeStatePaths('workbuddy', '/tmp/bridge', '/tmp/workflow-b.json')
  assert.equal(bridgeA.eventsFile, bridgeB.eventsFile)
  assert.notEqual(bridgeA.cursorFile, bridgeB.cursorFile)
})

test('new consumer cursors seed once from the legacy shared cursor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-cursor-seed-'))
  try {
    const bridge = bridgeStatePaths('workbuddy', root, 'consumer-a')
    await mkdir(path.dirname(bridge.legacyCursorFile), { recursive: true })
    await writeFile(bridge.legacyCursorFile, '17\n', 'utf8')
    assert.equal(await readBridgeCursor(bridge), 17)

    const claudePrimary = path.join(root, 'claude', 'cursors', 'a.cursor')
    const claudeLegacy = path.join(root, 'claude', 'events.cursor')
    await mkdir(path.dirname(claudeLegacy), { recursive: true })
    await writeFile(claudeLegacy, '23\n', 'utf8')
    assert.equal(await new ClaudeEventCursor(claudePrimary, claudeLegacy).read(), 23)
  } finally { await rm(root, { recursive: true, force: true }) }
})
''')

print('Review hardening patch prepared.')
