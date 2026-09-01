export type McpJsonRpcId = string | number

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

export interface McpPeerOptions {
  readonly defaultTimeoutMs?: number
  readonly idPrefix?: string
}

/**
 * Minimal bidirectional JSON-RPC peer for the stdio MCP transport.
 *
 * Flowit historically only answered Host requests. Elicitation requires the
 * MCP server to issue a request back to the Host and consume its response on
 * the same stream, so responses must be separated from incoming requests
 * before the tool dispatcher sees them.
 */
export class McpPeer {
  private readonly pending = new Map<McpJsonRpcId, PendingRequest>()
  private readonly defaultTimeoutMs: number
  private readonly idPrefix: string
  private nextId = 1
  private disposedError: Error | undefined

  constructor(
    private readonly sendMessage: (message: unknown) => void,
    options: McpPeerOptions = {},
  ) {
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? 120_000,
      'defaultTimeoutMs',
    )
    this.idPrefix = nonEmpty(options.idPrefix ?? 'flowit', 'idPrefix')
  }

  /**
   * Consume a JSON-RPC response. Unknown response IDs are intentionally
   * swallowed: they are responses, not Host requests, and must never reach the
   * MCP method dispatcher.
   */
  acceptResponse(message: unknown): boolean {
    if (!isRecord(message) || !isJsonRpcId(message.id)) return false
    if (!('result' in message) && !('error' in message)) return false
    const pending = this.pending.get(message.id)
    if (!pending) return true
    this.pending.delete(message.id)
    pending.cleanup()
    if (message.error !== undefined && message.error !== null) {
      const detail = isRecord(message.error)
        ? message.error.message ?? JSON.stringify(message.error)
        : String(message.error)
      pending.reject(new Error(`${pending.method} failed: ${String(detail)}`))
    } else {
      pending.resolve(message.result)
    }
    return true
  }

  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<unknown> {
    if (this.disposedError) return Promise.reject(this.disposedError)
    signal?.throwIfAborted()
    const normalizedMethod = nonEmpty(method, 'method')
    const timeout = positiveInteger(timeoutMs, 'timeoutMs')
    const id = `${this.idPrefix}:${this.nextId++}`
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = (): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.cleanup()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      this.pending.set(id, {
        method: normalizedMethod,
        resolve,
        reject,
        cleanup,
      })
      timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.cleanup()
        reject(new Error(`${normalizedMethod} timed out after ${timeout}ms`))
      }, timeout)
      timer.unref?.()
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.sendMessage({ jsonrpc: '2.0', id, method: normalizedMethod, params })
      } catch (error: unknown) {
        this.pending.delete(id)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  dispose(reason: Error = new Error('MCP peer disposed')): void {
    if (this.disposedError) return
    this.disposedError = reason
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.cleanup()
      pending.reject(reason)
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} must be non-empty`)
  return normalized
}

function isJsonRpcId(value: unknown): value is McpJsonRpcId {
  return typeof value === 'string' || typeof value === 'number'
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
