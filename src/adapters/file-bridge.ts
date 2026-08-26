import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentAdapter, AgentAdapterCapabilities, AgentDispatchRequest, AgentDispatchResult, AgentEvent, AgentSessionDescriptor } from '../core/types.js'
import { bridgeStatePaths, readBridgeCursor, readBridgeEventsAfter, readBridgeSessions, upsertBridgeSession, writeBridgeCursor, type BridgeStatePaths } from '../bridge/state.js'

export interface FileBridgeAdapterConfig { adapterId: string; root?: string; pollIntervalMs?: number; dispatchTimeoutMs?: number; capabilities?: Partial<AgentAdapterCapabilities> }

export class FileBridgeAgentAdapter implements AgentAdapter {
  readonly id: string
  readonly capabilities: AgentAdapterCapabilities
  protected readonly paths: BridgeStatePaths
  private readonly pollIntervalMs: number
  private readonly dispatchTimeoutMs: number

  constructor(config: FileBridgeAdapterConfig) {
    this.id = config.adapterId
    this.paths = bridgeStatePaths(this.id, config.root)
    this.pollIntervalMs = config.pollIntervalMs ?? 1000
    this.dispatchTimeoutMs = config.dispatchTimeoutMs ?? 30 * 60_000
    this.capabilities = { coldResume: false, liveDispatch: false, skillBinding: true, contextReference: 'summary', eventSubscription: true, ...config.capabilities }
  }

  async listSessions(query = ''): Promise<AgentSessionDescriptor[]> {
    const needle = query.trim().toLocaleLowerCase()
    return (await readBridgeSessions(this.paths)).filter(item => !needle || item.sessionId.toLocaleLowerCase().includes(needle) || item.name?.toLocaleLowerCase().includes(needle) === true || item.cwd?.toLocaleLowerCase().includes(needle) === true)
  }

  async dispatch(request: AgentDispatchRequest, signal?: AbortSignal): Promise<AgentDispatchResult> {
    signal?.throwIfAborted()
    const context = await this.resolveContext(request.contextRefs)
    await mkdir(this.paths.inboxDir, { recursive: true })
    await mkdir(this.paths.outboxDir, { recursive: true })
    const requestId = `${Date.now()}-${randomUUID()}`
    const inbox = path.join(this.paths.inboxDir, `${requestId}.json`)
    const tmp = `${inbox}.tmp`
    await writeFile(tmp, `${JSON.stringify({ version: 1, requestId, adapterId: this.id, request, context }, null, 2)}\n`, 'utf8')
    await rename(tmp, inbox)

    const deadline = Date.now() + this.dispatchTimeoutMs
    const resultFile = path.join(this.paths.outboxDir, `${requestId}.json`)
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      try {
        const value = JSON.parse(await readFile(resultFile, 'utf8')) as AgentDispatchResult & { error?: string }
        if (value.error) throw new Error(value.error)
        if (!value || typeof value.sessionId !== 'string' || !Array.isArray(value.loadedSkills) || !Array.isArray(value.referencedSessions)) throw new Error(`${this.id} bridge returned an invalid result`)
        const missing = request.skills.filter(skill => !value.loadedSkills.includes(skill))
        if (missing.length) throw new Error(`${this.id} bridge did not attest requested Skill bindings: ${missing.join(', ')}`)
        await this.recordResult(request, value)
        return value
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await delay(this.pollIntervalMs, signal)
    }
    throw new Error(`${this.id} bridge timed out waiting for ${resultFile}. Keep the host-native Flowit bridge Skill/automation running.`)
  }

  subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
    let stopped = false, busy = false, cursor = 0, initialized = false
    const poll = async (): Promise<void> => {
      if (stopped || busy) return
      busy = true
      try {
        if (!initialized) { cursor = await readBridgeCursor(this.paths); initialized = true }
        const batch = await readBridgeEventsAfter(this.paths, cursor)
        for (const event of batch.events) {
          if (stopped) return
          await listener(event)
          cursor += 1
          await writeBridgeCursor(this.paths, cursor)
        }
        if (cursor < batch.nextOffset) { cursor = batch.nextOffset; await writeBridgeCursor(this.paths, cursor) }
      } finally { busy = false }
    }
    const timer = setInterval(() => void poll().catch(() => undefined), this.pollIntervalMs)
    void poll().catch(() => undefined)
    return () => { stopped = true; clearInterval(timer) }
  }

  protected async recordResult(request: AgentDispatchRequest, result: AgentDispatchResult): Promise<void> {
    await upsertBridgeSession(this.paths, {
      adapterId: this.id,
      sessionId: result.sessionId || request.sessionId,
      status: 'idle',
      updatedAt: new Date().toISOString(),
      ...(result.outputSummary ? { lastAssistantMessage: result.outputSummary } : {}),
    })
  }

  private async resolveContext(refs: AgentDispatchRequest['contextRefs']): Promise<Array<{ adapterId: string; sessionId: string; label: string; summary: string }>> {
    if (refs.length === 0) return []
    const sessions = await readBridgeSessions(this.paths)
    return refs.map(ref => {
      if (ref.adapterId !== this.id) throw new Error(`${this.id} bridge cannot import ${ref.adapterId} context without a cross-adapter Context Bridge`)
      const source = sessions.find(session => session.adapterId === this.id && session.sessionId === ref.sessionId)
      if (!source?.lastAssistantMessage) throw new Error(`${this.id} bridge has no captured summary for referenced session ${ref.sessionId}`)
      return { adapterId: this.id, sessionId: ref.sessionId, label: ref.label ?? source.name ?? ref.sessionId, summary: source.lastAssistantMessage }
    })
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    const abort = (): void => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
