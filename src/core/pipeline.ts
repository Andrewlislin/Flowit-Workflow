import { randomUUID } from 'node:crypto'
import { assertNoAutonomousSessionCycle, adapterIdOf, normalizePipeline, normalizeTrigger, predecessorIds, topologicalOrder } from './domain.js'
import type { AgentAdapter, AgentEvent, AutomationRunRecord, CreatePipelineInput, PipelineDefinition, SessionContextRef } from './types.js'
import { AgentAdapterRegistry } from './adapter.js'
import { ContextGraph } from './context-graph.js'
import { JsonWorkflowStore } from './store.js'
import { OrchestrationDispatcher } from './dispatcher.js'

export class PipelineRuntime {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly eventStops = new Map<string, () => void>()
  private definitionMutationTail: Promise<void> = Promise.resolve()
  private stopAdapterRegistration: (() => void) | undefined
  private disposed = false

  constructor(private readonly adapters: AgentAdapterRegistry, private readonly store: JsonWorkflowStore, private readonly dispatcher: OrchestrationDispatcher, private readonly contextGraph: ContextGraph, private readonly defaultAdapterId: string) {}
  start(): void { for (const adapter of this.adapters.list()) this.attachAdapter(adapter); this.stopAdapterRegistration = this.adapters.onRegistered(adapter => this.attachAdapter(adapter)) }
  create(input: CreatePipelineInput): Promise<PipelineDefinition> { return this.serializeDefinitionMutation(async () => { const pipeline = normalizePipeline(randomUUID(), input, new Date(), this.defaultAdapterId); return this.store.transact(state => { assertNoAutonomousSessionCycle([...state.pipelines, pipeline], this.defaultAdapterId); state.pipelines.push(pipeline); return pipeline }) }) }
  async list(): Promise<PipelineDefinition[]> { return (await this.store.snapshot()).pipelines }
  async run(id: string): Promise<void> { const pipeline = (await this.store.snapshot()).pipelines.find(candidate => candidate.id === id); if (!pipeline) throw new Error(`unknown pipeline ${id}`); if (pipeline.status !== 'active') throw new Error(`pipeline ${id} is ${pipeline.status}`); await this.enqueue(pipeline, `manual:${randomUUID()}`) }
  setStatus(id: string, status: 'active' | 'paused'): Promise<PipelineDefinition> { return this.serializeDefinitionMutation(async () => this.store.transact(state => { const index = state.pipelines.findIndex(candidate => candidate.id === id); if (index < 0) throw new Error(`unknown pipeline ${id}`); const current = state.pipelines[index]!; const updated: PipelineDefinition = { ...current, status, updatedAt: new Date().toISOString() }; if (status === 'active') { const candidates = state.pipelines.map((candidate, candidateIndex) => candidateIndex === index ? updated : candidate); assertNoAutonomousSessionCycle(candidates, this.defaultAdapterId) } state.pipelines[index] = updated; return updated })) }
  dispose(): void { this.disposed = true; this.stopAdapterRegistration?.(); this.stopAdapterRegistration = undefined; for (const stop of this.eventStops.values()) stop(); this.eventStops.clear() }
  private attachAdapter(adapter: AgentAdapter): void { if (!adapter.capabilities.eventSubscription || !adapter.subscribe || this.eventStops.has(adapter.id)) return; const stop = adapter.subscribe(event => this.onAgentEvent(event)); this.eventStops.set(adapter.id, stop) }
  private async onAgentEvent(event: AgentEvent): Promise<void> { if (this.disposed) return; const triggerKey = `agent:${event.adapterId}:${event.sessionId}:${event.kind}:${event.eventId}`; const pipelines = (await this.store.snapshot()).pipelines.filter(pipeline => { if (pipeline.status !== 'active' || pipeline.trigger.kind === 'manual') return false; const trigger = normalizeTrigger(pipeline.trigger, this.defaultAdapterId); return trigger.kind === 'agent_event' && adapterIdOf(trigger, this.defaultAdapterId) === event.adapterId && trigger.sessionId === event.sessionId && trigger.event === event.kind }); for (const pipeline of pipelines) await this.enqueue(pipeline, triggerKey) }
  private async serializeDefinitionMutation<T>(operation: () => Promise<T>): Promise<T> { const current = this.definitionMutationTail.then(operation, operation); this.definitionMutationTail = current.then(() => undefined, () => undefined); return current }
  private enqueue(pipeline: PipelineDefinition, triggerKey: string): Promise<void> { const previous = this.queues.get(pipeline.id) ?? Promise.resolve(); const next = previous.then(() => this.execute(pipeline, triggerKey), () => this.execute(pipeline, triggerKey)); this.queues.set(pipeline.id, next.catch(() => undefined)); return next }

  private async execute(pipeline: PipelineDefinition, triggerKey: string): Promise<void> {
    const snapshot = await this.store.snapshot(); if (snapshot.runs.some(run => run.kind === 'pipeline' && run.definitionId === pipeline.id && run.triggerKey === triggerKey)) return
    const current = snapshot.pipelines.find(candidate => candidate.id === pipeline.id); if (!current || current.status !== 'active') return; pipeline = current
    const runId = randomUUID(); const startedAt = new Date().toISOString(); const running: AutomationRunRecord = { id: runId, kind: 'pipeline', definitionId: pipeline.id, triggerKey, status: 'running', startedAt, nodeResults: [] }; await this.store.putRun(running)
    try {
      const order = topologicalOrder(pipeline.nodes, pipeline.edges); const nodes = new Map(pipeline.nodes.map(node => [node.id, node]))
      for (const nodeId of order) {
        const node = nodes.get(nodeId); if (!node) throw new Error(`pipeline node ${nodeId} disappeared`); const upstreamRefs: SessionContextRef[] = []
        if (node.inheritUpstreamContext) { upstreamRefs.push(...this.contextGraph.inheritedFromResults(running.nodeResults ?? [], predecessorIds(nodeId, pipeline.edges))); if (predecessorIds(nodeId, pipeline.edges).length === 0 && pipeline.trigger.kind !== 'manual') { const trigger = normalizeTrigger(pipeline.trigger, this.defaultAdapterId); if (trigger.kind === 'agent_event') upstreamRefs.push({ adapterId: adapterIdOf(trigger, this.defaultAdapterId), sessionId: trigger.sessionId, label: 'Trigger session' }) } }
        const result = await this.dispatcher.dispatch(node.target, upstreamRefs); running.nodeResults?.push({ nodeId, adapterId: result.adapterId, sessionId: result.sessionId, loadedSkills: result.loadedSkills, referencedSessions: result.referencedSessions, ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}) }); await this.store.putRun(running)
      }
      await this.store.putRun({ ...running, status: 'completed', completedAt: new Date().toISOString() })
    } catch (error: unknown) { await this.store.putRun({ ...running, status: 'failed', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }); throw error }
  }
}
