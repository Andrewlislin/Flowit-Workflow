import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentAdapter,
  AgentAdapterCapabilities,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentEvent,
  AgentSessionDescriptor,
} from '@coaseedge/flowit-core'
import {
  bridgeStatePaths,
  readBridgeCursor,
  readBridgeEventsAfter,
  readBridgeSessions,
  upsertBridgeSession,
  writeBridgeCursor,
  type BridgeStatePaths,
} from '@coaseedge/flowit-core/bridge/state'
import {
  publishCompletedBridgeReceipt,
  readCompletedBridgeReceipt,
} from '@coaseedge/flowit-core/bridge/receipt'

export interface FileBridgeAdapterConfig {
  adapterId: string
  root?: string
  consumerId?: string
  pollIntervalMs?: number
  dispatchTimeoutMs?: number
  executionLeaseMs?: number
  capabilities?: Partial<AgentAdapterCapabilities>
}
export interface BridgeDispatchEnvelope {
  version: 2
  requestId: string
  idempotencyKey: string
  adapterId: string
  createdAt: string
  expiresAt: string
  attempt: number
  cancellationPath: string
  receiptPath: string
  executionClaimPath: string
  executionLeaseMs: number
  request: AgentDispatchRequest
  context: Array<{ adapterId: string; sessionId: string; label: string; summary: string }>
}

export class FileBridgeAgentAdapter implements AgentAdapter {
  readonly id: string
  readonly capabilities: AgentAdapterCapabilities
  protected readonly paths: BridgeStatePaths
  private readonly pollIntervalMs: number
  private readonly dispatchTimeoutMs: number
  private readonly executionLeaseMs: number

  constructor(config: FileBridgeAdapterConfig) {
    this.id = config.adapterId
    this.paths = bridgeStatePaths(this.id, config.root, config.consumerId)
    this.pollIntervalMs = config.pollIntervalMs ?? 1000
    this.dispatchTimeoutMs = config.dispatchTimeoutMs ?? 30 * 60_000
    this.executionLeaseMs = config.executionLeaseMs ?? 30_000
    if (!Number.isSafeInteger(this.executionLeaseMs) || this.executionLeaseMs < 1_000)
      throw new Error('bridge executionLeaseMs must be an integer >= 1000')
    this.capabilities = {
      coldResume: false,
      liveDispatch: false,
      skillBinding: true,
      contextReference: 'summary',
      eventSubscription: true,
      ...config.capabilities,
    }
  }
  async listSessions(query = ''): Promise<AgentSessionDescriptor[]> {
    const needle = query.trim().toLocaleLowerCase()
    return (await readBridgeSessions(this.paths)).filter(
      item =>
        !needle ||
        item.sessionId.toLocaleLowerCase().includes(needle) ||
        item.name?.toLocaleLowerCase().includes(needle) === true ||
        item.cwd?.toLocaleLowerCase().includes(needle) === true,
    )
  }

  async dispatch(
    request: AgentDispatchRequest,
    signal?: AbortSignal,
  ): Promise<AgentDispatchResult> {
    signal?.throwIfAborted()
    const context = await this.resolveContext(request.contextRefs)
    await Promise.all(
      [
        this.paths.inboxDir,
        this.paths.processingDir,
        this.paths.outboxDir,
        this.paths.cancelledDir,
        this.paths.deadLetterDir,
        this.paths.cancellationsDir,
        this.paths.receiptsDir,
        this.paths.claimsDir,
      ].map(directory => mkdir(directory, { recursive: true })),
    )
    const keyDigest = digest(request.correlationId)
    const receiptFile = path.join(this.paths.receiptsDir, `${keyDigest}.json`)
    const existingReceipt = await readCompletedBridgeReceipt(receiptFile, request.correlationId)
    if (existingReceipt) {
      const result = this.validateResult(request, existingReceipt)
      await this.recordResult(request, result)
      return result
    }

    const requestId = `${Date.now()}-${randomUUID()}`
    const createdAt = new Date()
    const expiresAt = new Date(createdAt.getTime() + this.dispatchTimeoutMs)
    const inbox = path.join(this.paths.inboxDir, `${requestId}.json`)
    const cancellationPath = path.join(this.paths.cancellationsDir, `${requestId}.json`)
    const tmp = `${inbox}.tmp`
    const envelope: BridgeDispatchEnvelope = {
      version: 2,
      requestId,
      idempotencyKey: request.correlationId,
      adapterId: this.id,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      attempt: request.attempt ?? 1,
      cancellationPath,
      receiptPath: receiptFile,
      executionClaimPath: path.join(this.paths.claimsDir, `${keyDigest}.lock`),
      executionLeaseMs: this.executionLeaseMs,
      request,
      context,
    }
    await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    await rename(tmp, inbox)

    const resultFile = path.join(this.paths.outboxDir, `${requestId}.json`)
    try {
      while (Date.now() < expiresAt.getTime()) {
        signal?.throwIfAborted()
        const outbox = await readOutboxIfReady(resultFile)
        if (outbox) {
          const value = this.validateResult(request, outbox)
          const receiptResult = this.validateResult(
            request,
            await publishCompletedBridgeReceipt(receiptFile, request.correlationId, value),
          )
          await this.recordResult(request, receiptResult)
          return receiptResult
        }

        const receipt = await readCompletedBridgeReceipt(receiptFile, request.correlationId)
        if (receipt) {
          const value = this.validateResult(request, receipt)
          await this.recordResult(request, value)
          return value
        }
        await delay(this.pollIntervalMs, signal)
      }
      throw new Error(`${this.id} bridge timed out waiting for ${resultFile}`)
    } catch (error: unknown) {
      await this.cancelBridgeRequest(
        requestId,
        inbox,
        cancellationPath,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
    let stopped = false,
      busy = false,
      cursor = 0,
      initialized = false
    const poll = async (): Promise<void> => {
      if (stopped || busy) return
      busy = true
      try {
        if (!initialized) {
          cursor = await readBridgeCursor(this.paths)
          initialized = true
        }
        const batch = await readBridgeEventsAfter(this.paths, cursor)
        for (const event of batch.events) {
          if (stopped) return
          await listener(event)
          cursor += 1
          await writeBridgeCursor(this.paths, cursor)
        }
        if (cursor < batch.nextOffset) {
          cursor = batch.nextOffset
          await writeBridgeCursor(this.paths, cursor)
        }
      } finally {
        busy = false
      }
    }
    const timer = setInterval(() => void poll().catch(() => undefined), this.pollIntervalMs)
    void poll().catch(() => undefined)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  protected async recordResult(
    request: AgentDispatchRequest,
    result: AgentDispatchResult,
  ): Promise<void> {
    await upsertBridgeSession(this.paths, {
      adapterId: this.id,
      sessionId: result.sessionId || request.sessionId,
      status: 'idle',
      updatedAt: new Date().toISOString(),
      ...(result.outputSummary ? { lastAssistantMessage: result.outputSummary } : {}),
    })
  }
  private validateResult(
    request: AgentDispatchRequest,
    value: AgentDispatchResult & { error?: string },
  ): AgentDispatchResult {
    if (value.error) throw new Error(value.error)
    if (
      !value ||
      typeof value.sessionId !== 'string' ||
      !Array.isArray(value.loadedSkills) ||
      !Array.isArray(value.referencedSessions)
    )
      throw new Error(`${this.id} bridge returned an invalid result`)
    const missing = request.skills.filter(skill => !value.loadedSkills.includes(skill))
    if (missing.length)
      throw new Error(
        `${this.id} bridge did not attest requested Skill bindings: ${missing.join(', ')}`,
      )
    return value
  }
  private async cancelBridgeRequest(
    requestId: string,
    inbox: string,
    cancellationPath: string,
    reason: string,
  ): Promise<void> {
    await writeFile(
      cancellationPath,
      `${JSON.stringify({ version: 1, requestId, cancelledAt: new Date().toISOString(), reason }, null, 2)}\n`,
      'utf8',
    ).catch(() => undefined)
    await rename(inbox, path.join(this.paths.cancelledDir, path.basename(inbox))).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
  private async resolveContext(
    refs: AgentDispatchRequest['contextRefs'],
  ): Promise<Array<{ adapterId: string; sessionId: string; label: string; summary: string }>> {
    if (refs.length === 0) return []
    const sessions = await readBridgeSessions(this.paths)
    return refs.map(ref => {
      if (ref.adapterId !== this.id)
        throw new Error(
          `${this.id} bridge cannot import ${ref.adapterId} context without a cross-adapter Context Bridge`,
        )
      const source = sessions.find(
        session => session.adapterId === this.id && session.sessionId === ref.sessionId,
      )
      if (!source?.lastAssistantMessage)
        throw new Error(
          `${this.id} bridge has no captured summary for referenced session ${ref.sessionId}`,
        )
      return {
        adapterId: this.id,
        sessionId: ref.sessionId,
        label: ref.label ?? source.name ?? ref.sessionId,
        summary: source.lastAssistantMessage,
      }
    })
  }
}

async function readOutboxIfReady(
  file: string,
): Promise<(AgentDispatchResult & { error?: string }) | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as AgentDispatchResult & { error?: string }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
      return undefined
    throw error
  }
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    const abort = (): void =>
      finish(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    const timer = setTimeout(() => finish(), ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}
