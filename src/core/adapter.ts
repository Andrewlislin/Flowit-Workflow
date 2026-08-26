import type { AgentAdapter, AdapterId } from './types.js'

export class AgentAdapterRegistry {
  private readonly adapters = new Map<AdapterId, AgentAdapter>()
  private readonly listeners = new Set<(adapter: AgentAdapter) => void>()

  register(adapter: AgentAdapter): () => void {
    if (!adapter.id.trim()) throw new Error('adapter id must be non-empty')
    if (this.adapters.has(adapter.id)) throw new Error(`adapter ${adapter.id} is already registered`)
    this.adapters.set(adapter.id, adapter)
    for (const listener of this.listeners) listener(adapter)
    return () => {
      if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id)
    }
  }

  require(id: AdapterId): AgentAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new Error(`agent adapter ${id} is not registered`)
    return adapter
  }

  get(id: AdapterId): AgentAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()]
  }

  onRegistered(listener: (adapter: AgentAdapter) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    const adapters = this.list()
    this.adapters.clear()
    await Promise.allSettled(adapters.map(adapter => Promise.resolve(adapter.dispose?.())))
  }
}
