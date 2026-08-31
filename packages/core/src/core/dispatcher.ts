import { randomUUID } from 'node:crypto'
import type {
  AgentDispatchResult,
  AdapterContextRef,
  AutomationTarget,
  SessionContextRef,
} from './types.js'
import { AgentAdapterRegistry } from './adapter.js'
import { ContextGraph } from './context-graph.js'
import { SkillBinder } from './skill-binding.js'
import { AgentExecutionError } from './execution-error.js'
import {
  adapterIdOf,
  assertExecutionPreflightReady,
  normalizeExecutionRequirement,
  requiresExecutionPreflight,
} from './domain.js'

export interface DispatchResult extends AgentDispatchResult { adapterId: string }

export class OrchestrationDispatcher {
  private readonly sessionTails = new Map<string, Promise<void>>()
  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly contextGraph: ContextGraph,
    private readonly skillBinder: SkillBinder,
    private readonly defaultAdapterId: string,
  ) {}

  dispatch(
    target: AutomationTarget,
    extraRefs: readonly SessionContextRef[] = [],
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    return this.dispatchWithCorrelation(target, extraRefs, randomUUID(), 1, signal)
  }

  dispatchWithCorrelation(
    target: AutomationTarget,
    extraRefs: readonly SessionContextRef[],
    correlationId: string,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    const adapterId = adapterIdOf(target, this.defaultAdapterId)
    const sessionId = target.sessionId.trim()
    if (!sessionId) return Promise.reject(new Error('target.sessionId must be a non-empty string'))
    return this.serializeTarget(`${adapterId}\u0000${sessionId}`, async () => {
      signal?.throwIfAborted()
      const adapter = await this.adapters.requireStarted(adapterId, signal)
      const skills = this.skillBinder.normalize(target.skills)
      const execution = target.execution
        ? normalizeExecutionRequirement(target.execution)
        : undefined
      if (requiresExecutionPreflight(execution)) {
        if (adapter.capabilities.executionPreflight !== true || !adapter.preflightExecution) {
          throw new AgentExecutionError(
            'UNSUPPORTED',
            `Adapter ${adapterId} cannot verify the requested execution contract`,
            false,
          )
        }
        const preflight = await adapter.preflightExecution(
          {
            correlationId: `dispatch-preflight:${correlationId}`,
            session: { kind: 'existing', sessionId },
            requirement: structuredClone(execution ?? {}),
            skills: [...skills],
          },
          signal,
        )
        assertExecutionPreflightReady(adapterId, execution, preflight)
      }
      signal?.throwIfAborted()
      const refs = this.contextGraph.normalize(
        [...target.contextRefs, ...extraRefs],
        this.defaultAdapterId,
        { adapterId, sessionId },
      )
      const contextRefs: AdapterContextRef[] = refs.map(ref => ({
        adapterId: ref.adapterId ?? this.defaultAdapterId,
        sessionId: ref.sessionId,
        ...(ref.label ? { label: ref.label } : {}),
      }))
      const result = await adapter.dispatch(
        {
          correlationId,
          attempt,
          sessionId,
          prompt: target.prompt,
          skills,
          contextRefs,
          ...(execution ? { execution: structuredClone(execution) } : {}),
        },
        signal,
      )
      return { adapterId, ...result }
    })
  }

  private async serializeTarget<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(key) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.then(() => undefined, () => undefined)
    this.sessionTails.set(key, tail)
    try {
      return await current
    } finally {
      if (this.sessionTails.get(key) === tail) this.sessionTails.delete(key)
    }
  }
}
