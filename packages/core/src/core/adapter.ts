import type { AgentAdapter, AdapterId } from './types.js'

const ADAPTER_DISPOSE_TIMEOUT_MS = 3_000

interface AdapterLifecycle {
  controller: AbortController
  started: boolean
  starting?: Promise<void>
}

export class AgentAdapterRegistry {
  private readonly adapters = new Map<AdapterId, AgentAdapter>()
  private readonly lifecycles = new Map<AgentAdapter, AdapterLifecycle>()
  private readonly registeredListeners = new Set<(adapter: AgentAdapter) => void>()
  private readonly unregisteredListeners = new Set<(adapter: AgentAdapter) => void>()

  register(adapter: AgentAdapter): () => void {
    if (!adapter.id.trim()) throw new Error('adapter id must be non-empty')
    if (this.adapters.has(adapter.id)) throw new Error(`adapter ${adapter.id} is already registered`)
    this.adapters.set(adapter.id, adapter)
    this.lifecycles.set(adapter, { controller: new AbortController(), started: false })
    for (const listener of this.registeredListeners) listener(adapter)
    return () => {
      if (this.adapters.get(adapter.id) !== adapter) return
      this.adapters.delete(adapter.id)
      const lifecycle = this.lifecycles.get(adapter)
      lifecycle?.controller.abort(new Error(`adapter ${adapter.id} was unregistered`))
      this.lifecycles.delete(adapter)
      for (const listener of this.unregisteredListeners) listener(adapter)
    }
  }

  require(id: AdapterId): AgentAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new Error(`agent adapter ${id} is not registered`)
    return adapter
  }

  async requireStarted(id: AdapterId, signal?: AbortSignal): Promise<AgentAdapter> {
    const adapter = this.require(id)
    await this.start(adapter, signal)
    if (this.adapters.get(id) !== adapter) throw new Error(`agent adapter ${id} changed while starting`)
    return adapter
  }

  get(id: AdapterId): AgentAdapter | undefined { return this.adapters.get(id) }
  list(): AgentAdapter[] { return [...this.adapters.values()] }
  async startAll(signal?: AbortSignal): Promise<void> { await Promise.all(this.list().map(adapter => this.start(adapter, signal))) }

  async start(adapter: AgentAdapter, signal?: AbortSignal): Promise<void> {
    if (this.adapters.get(adapter.id) !== adapter) throw new Error(`agent adapter ${adapter.id} is no longer registered`)
    const lifecycle = this.lifecycles.get(adapter)
    if (!lifecycle) throw new Error(`agent adapter ${adapter.id} has no active lifecycle`)
    if (lifecycle.started) return
    const waitSignal = signal ? AbortSignal.any([lifecycle.controller.signal, signal]) : lifecycle.controller.signal
    if (lifecycle.starting) return waitForPromise(lifecycle.starting, waitSignal)

    const startup = (async () => {
      waitSignal.throwIfAborted()
      await adapter.start?.(waitSignal)
      waitSignal.throwIfAborted()
      if (this.adapters.get(adapter.id) !== adapter) throw new Error(`agent adapter ${adapter.id} was replaced while starting`)
      lifecycle.started = true
    })()
    lifecycle.starting = startup
    void startup.finally(() => { if (lifecycle.starting === startup) delete lifecycle.starting }).catch(() => undefined)
    return waitForPromise(startup, waitSignal)
  }

  onRegistered(listener: (adapter: AgentAdapter) => void): () => void { this.registeredListeners.add(listener); return () => this.registeredListeners.delete(listener) }
  onUnregistered(listener: (adapter: AgentAdapter) => void): () => void { this.unregisteredListeners.add(listener); return () => this.unregisteredListeners.delete(listener) }

  async dispose(): Promise<void> {
    const adapters = this.list()
    for (const adapter of adapters) this.lifecycles.get(adapter)?.controller.abort(new Error('adapter registry disposed'))
    this.adapters.clear()
    this.lifecycles.clear()
    this.registeredListeners.clear()
    this.unregisteredListeners.clear()
    await Promise.all(adapters.map(adapter => settleDispose(adapter, ADAPTER_DISPOSE_TIMEOUT_MS)))
  }
}

async function settleDispose(adapter: AgentAdapter, timeoutMs: number): Promise<void> {
  try {
    await Promise.race([
      Promise.resolve(adapter.dispose?.()).then(() => undefined, () => undefined),
      new Promise<void>(resolve => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.() }),
    ])
  } catch {}
}

async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    const resolveOnce = (value: T): void => { if (settled) return; settled = true; cleanup(); resolve(value) }
    const rejectOnce = (error: unknown): void => { if (settled) return; settled = true; cleanup(); reject(error) }
    const abort = (): void => rejectOnce(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolveOnce, rejectOnce)
  })
}
