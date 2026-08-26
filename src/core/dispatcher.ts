import { randomUUID } from 'node:crypto'
import type { AgentDispatchResult, AdapterContextRef, AutomationTarget, SessionContextRef } from './types.js'
import { AgentAdapterRegistry } from './adapter.js'
import { ContextGraph } from './context-graph.js'
import { SkillBinder } from './skill-binding.js'
import { adapterIdOf } from './domain.js'

export interface DispatchResult extends AgentDispatchResult { adapterId: string }

export class OrchestrationDispatcher {
  private readonly sessionTails = new Map<string, Promise<void>>()
  constructor(private readonly adapters: AgentAdapterRegistry, private readonly contextGraph: ContextGraph, private readonly skillBinder: SkillBinder, private readonly defaultAdapterId: string) {}

  dispatch(target: AutomationTarget, extraRefs: readonly SessionContextRef[] = [], signal?: AbortSignal): Promise<DispatchResult> {
    const adapterId = adapterIdOf(target, this.defaultAdapterId); const sessionId = target.sessionId.trim()
    if (!sessionId) return Promise.reject(new Error('target.sessionId must be a non-empty string'))
    return this.serializeTarget(`${adapterId}\u0000${sessionId}`, async () => {
      signal?.throwIfAborted(); const adapter = this.adapters.require(adapterId)
      const refs = this.contextGraph.normalize([...target.contextRefs, ...extraRefs], this.defaultAdapterId, { adapterId, sessionId })
      const contextRefs: AdapterContextRef[] = refs.map(ref => ({ adapterId: ref.adapterId ?? this.defaultAdapterId, sessionId: ref.sessionId, ...(ref.label ? { label: ref.label } : {}) }))
      const result = await adapter.dispatch({ correlationId: randomUUID(), sessionId, prompt: target.prompt, skills: this.skillBinder.normalize(target.skills), contextRefs }, signal)
      return { adapterId, ...result }
    })
  }

  private async serializeTarget<T>(key: string, operation: () => Promise<T>): Promise<T> { const previous = this.sessionTails.get(key) ?? Promise.resolve(); const current = previous.then(operation, operation); const tail = current.then(() => undefined, () => undefined); this.sessionTails.set(key, tail); try { return await current } finally { if (this.sessionTails.get(key) === tail) this.sessionTails.delete(key) } }
}
