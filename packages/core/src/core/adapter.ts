import type { AgentAdapter, AdapterId } from './types.js'

const ADAPTER_DISPOSE_TIMEOUT_MS = 3_000

interface AdapterLifecycle {
  controller: AbortController
  started: boolean
  starting?: Promise<void>
  predecessorDisposal?: Promise<void>
}

export class AgentAdapterRegistry {
  private readonly adapters = new Map<AdapterId, AgentAdapter>()
  private readonly lifecycles = new Map<AgentAdapter, AdapterLifecycle>()
  private readonly disposalFences = new Map<AdapterId, Promise<void>>()
  private readonly registeredListeners = new Set<(adapter: AgentAdapter) => void>()
  private readonly unregisteredListeners = new Set<(adapter: AgentAdapter) => void>()

  register(adapter: AgentAdapter): () => void {
    if (!adapter.id.trim()) throw new Error('adapter id must be non-empty')
    if (this.adapters.has(adapter.id))
      throw new Error(`adapter ${adapter.id} is already registered`)
    const predecessorDisposal = this.disposalFences.get(adapter.id)
    this.adapters.set(adapter.id, adapter)
    this.lifecycles.set(adapter, {
      controller: new AbortController(),
      started: false,
      ...(predecessorDisposal ? { predecessorDisposal } : {}),
    })
    for (const listener of this.registeredListeners) listener(adapter)
    return () => {
      if (this.adapters.get(adapter.id) !== adapter) return
      this.adapters.delete(adapter.id)
      const lifecycle = this.lifecycles.get(adapter)
      lifecycle?.controller.abort(new Error(`adapter ${adapter.id} was unregistered`))
      this.lifecycles.delete(adapter)
      for (const listener of this.unregisteredListeners) listener(adapter)
      this.beginDisposal(adapter, lifecycle?.starting)
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
    if (this.adapters.get(id) !== adapter)
      throw new Error(`agent adapter ${id} changed while starting`)
    return adapter
  }

  get(id: AdapterId): AgentAdapter | undefined {
    return this.adapters.get(id)
  }
  list(): AgentAdapter[] {
    return [...this.adapters.values()]
  }
  async startAll(signal?: AbortSignal): Promise<void> {
    await Promise.all(this.list().map(adapter => this.start(adapter, signal)))
  }

  async start(adapter: AgentAdapter, signal?: AbortSignal): Promise<void> {
    if (this.adapters.get(adapter.id) !== adapter)
      throw new Error(`agent adapter ${adapter.id} is no longer registered`)
    const lifecycle = this.lifecycles.get(adapter)
    if (!lifecycle) throw new Error(`agent adapter ${adapter.id} has no active lifecycle`)
    if (lifecycle.started) return
    const waitSignal = signal
      ? AbortSignal.any([lifecycle.controller.signal, signal])
      : lifecycle.controller.signal

    const predecessorDisposal = lifecycle.predecessorDisposal
    if (predecessorDisposal) {
      await waitForPromise(predecessorDisposal, waitSignal)
      waitSignal.throwIfAborted()
      if (this.adapters.get(adapter.id) !== adapter)
        throw new Error(`agent adapter ${adapter.id} changed while awaiting predecessor disposal`)
      if (lifecycle.predecessorDisposal === predecessorDisposal)
        delete lifecycle.predecessorDisposal
    }

    if (lifecycle.starting) return waitForPromise(lifecycle.starting, waitSignal)

    const startup = (async () => {
      waitSignal.throwIfAborted()
      await adapter.start?.(waitSignal)
      waitSignal.throwIfAborted()
      if (this.adapters.get(adapter.id) !== adapter)
        throw new Error(`agent adapter ${adapter.id} was replaced while starting`)
      lifecycle.started = true
    })()
    lifecycle.starting = startup
    void startup
      .finally(() => {
        if (lifecycle.starting === startup) delete lifecycle.starting
      })
      .catch(() => undefined)
    return waitForPromise(startup, waitSignal)
  }

  onRegistered(listener: (adapter: AgentAdapter) => void): () => void {
    this.registeredListeners.add(listener)
    return () => this.registeredListeners.delete(listener)
  }
  onUnregistered(listener: (adapter: AgentAdapter) => void): () => void {
    this.unregisteredListeners.add(listener)
    return () => this.unregisteredListeners.delete(listener)
  }

  async dispose(): Promise<void> {
    const generations = this.list().map(adapter => ({
      adapter,
      startup: this.lifecycles.get(adapter)?.starting,
    }))
    for (const { adapter } of generations)
      this.lifecycles.get(adapter)?.controller.abort(new Error('adapter registry disposed'))
    this.adapters.clear()
    this.lifecycles.clear()
    this.registeredListeners.clear()
    this.unregisteredListeners.clear()
    const activeDisposals = generations.map(({ adapter, startup }) =>
      this.beginDisposal(adapter, startup),
    )
    const pending = new Set([...this.disposalFences.values(), ...activeDisposals])
    await Promise.allSettled([...pending])
  }

  private beginDisposal(adapter: AgentAdapter, startup?: Promise<void>): Promise<void> {
    const predecessor = this.disposalFences.get(adapter.id)
    const ownDisposal = disposeAdapter(adapter, ADAPTER_DISPOSE_TIMEOUT_MS)
    const startupSettlement = startup
      ? settleStartup(adapter.id, startup, ADAPTER_DISPOSE_TIMEOUT_MS)
      : Promise.resolve()
    const disposal = (async () => {
      const outcomes = await Promise.allSettled([
        ...(predecessor ? [predecessor] : []),
        startupSettlement,
        ownDisposal,
      ])
      const errors = outcomes.flatMap(outcome =>
        outcome.status === 'rejected' ? [outcome.reason] : [],
      )
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `adapter ${adapter.id} disposal fence failed across generations`,
        )
      }
    })()
    this.disposalFences.set(adapter.id, disposal)
    void disposal.then(
      () => {
        if (this.disposalFences.get(adapter.id) === disposal)
          this.disposalFences.delete(adapter.id)
      },
      () => undefined,
    )
    return disposal
  }
}

async function disposeAdapter(adapter: AgentAdapter, timeoutMs: number): Promise<void> {
  await raceWithTimeout(
    Promise.resolve().then(() => adapter.dispose?.()),
    timeoutMs,
    `adapter ${adapter.id} disposal timed out after ${timeoutMs}ms`,
  )
}

async function settleStartup(
  adapterId: AdapterId,
  startup: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  await raceWithTimeout(
    startup.then(
      () => undefined,
      () => undefined,
    ),
    timeoutMs,
    `adapter ${adapterId} startup did not settle during disposal after ${timeoutMs}ms`,
  )
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    const resolveOnce = (value: T): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = (): void =>
      rejectOnce(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolveOnce, rejectOnce)
  })
}
