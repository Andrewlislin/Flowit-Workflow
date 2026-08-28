import { randomUUID } from 'node:crypto'
import { assertNoAutonomousSessionCycle, adapterIdOf, normalizePipeline, normalizeTrigger, predecessorIds, topologicalOrder } from './domain.js'
import type { AgentAdapter, AgentEvent, AutomationRunNodeResult, AutomationRunRecord, CreatePipelineInput, PipelineDefinition, PipelineEventAdmission, SessionContextRef } from './types.js'
import { AgentAdapterRegistry } from './adapter.js'
import { ContextGraph } from './context-graph.js'
import { JsonWorkflowStore } from './store.js'
import { OrchestrationDispatcher } from './dispatcher.js'
import { startLeaseHeartbeat } from './lease.js'

const DEFAULT_RECONCILE_MS = 1_000
const DISPOSE_QUEUE_GRACE_MS = 3_000
const EXTERNAL_TRIGGER_RECHECK_MS = 50
export interface PipelineRuntimeOptions { workerId: string; leaseDurationMs: number; retryDelayMs: number; maxAttempts: number }
type PipelineExecutionOutcome = 'completed' | 'dead_letter' | 'busy'

export class PipelineRuntime {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly queuedTriggers = new Map<string, Promise<PipelineExecutionOutcome>>()
  private readonly eventStops = new Map<string, { adapter: AgentAdapter; stop: () => void }>()
  private readonly disposeController = new AbortController()
  private definitionMutationTail: Promise<void> = Promise.resolve()
  private stopAdapterRegistration: (() => void) | undefined
  private stopAdapterUnregistration: (() => void) | undefined
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(private readonly adapters: AgentAdapterRegistry, private readonly store: JsonWorkflowStore, private readonly dispatcher: OrchestrationDispatcher, private readonly contextGraph: ContextGraph, private readonly defaultAdapterId: string, private readonly options: PipelineRuntimeOptions) {}

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.stopAdapterRegistration = this.adapters.onRegistered(adapter => { void this.attachAdapter(adapter).catch(() => undefined) })
    this.stopAdapterUnregistration = this.adapters.onUnregistered(adapter => this.detachAdapter(adapter))
    await Promise.all(this.adapters.list().map(adapter => this.attachAdapter(adapter, signal)))
    signal?.throwIfAborted()
    this.reconcileTimer = setInterval(() => void this.reconcileRecoverable().catch(() => undefined), DEFAULT_RECONCILE_MS)
    await this.reconcileRecoverable()
  }

  create(input: CreatePipelineInput): Promise<PipelineDefinition> { return this.serializeDefinitionMutation(async () => { const pipeline = normalizePipeline(randomUUID(), input, new Date(), this.defaultAdapterId); return this.store.transact(state => { assertNoAutonomousSessionCycle([...state.pipelines, pipeline], this.defaultAdapterId); state.pipelines.push(pipeline); return pipeline }) }) }
  async list(): Promise<PipelineDefinition[]> { return (await this.store.snapshot()).pipelines }
  async run(id: string): Promise<void> { const pipeline = await this.requireActive(id); await this.enqueue(pipeline, `manual:${randomUUID()}`) }
  async runWithTrigger(id: string, triggerKey: string, signal?: AbortSignal): Promise<void> {
    const normalized = triggerKey.trim()
    if (!normalized || normalized.startsWith('manual:')) throw new Error('external pipeline triggerKey must be stable and must not use the manual: namespace')
    for (;;) {
      signal?.throwIfAborted()
      const pipeline = await this.requireActive(id)
      const outcome = await this.enqueue(pipeline, normalized, signal)
      if (outcome === 'completed') return
      if (outcome === 'dead_letter') throw new Error(`pipeline ${id} trigger ${normalized} is dead-lettered`)
      await delay(EXTERNAL_TRIGGER_RECHECK_MS, signal)
    }
  }
  setStatus(id: string, status: 'active' | 'paused'): Promise<PipelineDefinition> { return this.serializeDefinitionMutation(async () => this.store.transact(state => { const index = state.pipelines.findIndex(candidate => candidate.id === id); if (index < 0) throw new Error(`unknown pipeline ${id}`); const current = state.pipelines[index]!; const updated: PipelineDefinition = { ...current, status, updatedAt: new Date().toISOString() }; if (status === 'active') { const candidates = state.pipelines.map((candidate, candidateIndex) => candidateIndex === index ? updated : candidate); assertNoAutonomousSessionCycle(candidates, this.defaultAdapterId) } state.pipelines[index] = updated; return updated })) }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.disposeController.abort(new Error('pipeline runtime disposed'))
    this.stopAdapterRegistration?.(); this.stopAdapterRegistration = undefined
    this.stopAdapterUnregistration?.(); this.stopAdapterUnregistration = undefined
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = undefined
    for (const entry of this.eventStops.values()) entry.stop()
    this.eventStops.clear()
    const pending = [...new Set([...this.queues.values(), ...this.queuedTriggers.values()])]
    await settleAllWithin(pending, DISPOSE_QUEUE_GRACE_MS)
  }

  private async requireActive(id: string): Promise<PipelineDefinition> {
    const pipeline = (await this.store.snapshot()).pipelines.find(candidate => candidate.id === id)
    if (!pipeline) throw new Error(`unknown pipeline ${id}`)
    if (pipeline.status !== 'active') throw new Error(`pipeline ${id} is ${pipeline.status}`)
    return pipeline
  }

  private async attachAdapter(adapter: AgentAdapter, signal?: AbortSignal): Promise<void> {
    if (!adapter.capabilities.eventSubscription || !adapter.subscribe || this.disposed) return
    const existing = this.eventStops.get(adapter.id)
    if (existing?.adapter === adapter) return
    if (existing) { existing.stop(); this.eventStops.delete(adapter.id) }
    await this.adapters.start(adapter, signal)
    if (this.disposed || this.adapters.get(adapter.id) !== adapter) return
    const stop = adapter.subscribe(event => this.onAgentEvent(event))
    this.eventStops.set(adapter.id, { adapter, stop })
  }

  private detachAdapter(adapter: AgentAdapter): void {
    const entry = this.eventStops.get(adapter.id)
    if (entry?.adapter !== adapter) return
    entry.stop()
    this.eventStops.delete(adapter.id)
  }

  private async onAgentEvent(event: AgentEvent): Promise<void> {
    if (this.disposed) return
    const triggerKey = `agent:${event.adapterId}:${event.sessionId}:${event.kind}:${event.eventId}`
    const snapshot = await this.store.snapshot()
    const pipelines = snapshot.pipelines.filter(pipeline => {
      if (pipeline.status !== 'active' || pipeline.trigger.kind === 'manual') return false
      const trigger = normalizeTrigger(pipeline.trigger, this.defaultAdapterId)
      return trigger.kind === 'agent_event' && adapterIdOf(trigger, this.defaultAdapterId) === event.adapterId && trigger.sessionId === event.sessionId && trigger.event === event.kind
    })
    const admissions = await this.store.admitPipelineTriggers(pipelines.map(pipeline => ({ pipelineId: pipeline.id, triggerKey, event })))
    const byId = new Map(pipelines.map(pipeline => [pipeline.id, pipeline]))
    for (const admission of admissions) {
      const pipeline = byId.get(admission.pipelineId)
      if (pipeline && !this.disposed) void this.enqueue(pipeline, admission.triggerKey).catch(() => undefined)
    }
  }

  private async reconcileRecoverable(): Promise<void> {
    if (this.disposed) return
    const state = await this.store.snapshot(); const now = Date.now(); const pipelines = new Map(state.pipelines.map(pipeline => [pipeline.id, pipeline]))
    for (const admission of state.eventInbox) {
      const pipeline = pipelines.get(admission.pipelineId)
      if (pipeline?.status === 'active') void this.enqueueAdmission(pipeline, admission).catch(() => undefined)
    }
    for (const pipeline of state.pipelines) {
      if (pipeline.status !== 'active') continue
      const runs = state.runs.filter(run => run.kind === 'pipeline' && run.definitionId === pipeline.id && !run.triggerKey.startsWith('manual:') && !run.triggerKey.startsWith('schedule:'))
      const latestByTrigger = new Map<string, AutomationRunRecord>(); for (const run of runs) latestByTrigger.set(run.triggerKey, run)
      for (const run of latestByTrigger.values()) {
        if (run.status === 'completed' || run.status === 'dead_letter') continue
        if (run.status === 'failed') { const retryAt = Date.parse(run.retryNotBefore ?? ''); if (Number.isFinite(retryAt) && retryAt > now) continue }
        if (run.status === 'running') { const expiry = Date.parse(run.leaseExpiresAt ?? ''); if (Number.isFinite(expiry) && expiry > now) continue }
        void this.enqueue(pipeline, run.triggerKey).catch(() => undefined)
      }
    }
  }

  private enqueueAdmission(pipeline: PipelineDefinition, admission: PipelineEventAdmission): Promise<PipelineExecutionOutcome> { return this.enqueue(pipeline, admission.triggerKey) }
  private async serializeDefinitionMutation<T>(operation: () => Promise<T>): Promise<T> { const current = this.definitionMutationTail.then(operation, operation); this.definitionMutationTail = current.then(() => undefined, () => undefined); return current }

  private enqueue(pipeline: PipelineDefinition, triggerKey: string, externalSignal?: AbortSignal): Promise<PipelineExecutionOutcome> {
    if (this.disposed) return Promise.resolve('busy')
    const triggerIdentity = `${pipeline.id}\u0000${triggerKey}`
    const existing = this.queuedTriggers.get(triggerIdentity)
    if (existing) return existing
    const previous = this.queues.get(pipeline.id) ?? Promise.resolve()
    const next = previous.then(() => this.execute(pipeline, triggerKey, externalSignal), () => this.execute(pipeline, triggerKey, externalSignal))
    const tail = next.then(() => undefined, () => undefined)
    this.queues.set(pipeline.id, tail)
    this.queuedTriggers.set(triggerIdentity, next)
    void tail.then(() => {
      if (this.queuedTriggers.get(triggerIdentity) === next) this.queuedTriggers.delete(triggerIdentity)
      if (this.queues.get(pipeline.id) === tail) this.queues.delete(pipeline.id)
    })
    return next
  }

  private async execute(pipeline: PipelineDefinition, triggerKey: string, externalSignal?: AbortSignal): Promise<PipelineExecutionOutcome> {
    if (this.disposed) return 'busy'
    const current = (await this.store.snapshot()).pipelines.find(candidate => candidate.id === pipeline.id); if (!current || current.status !== 'active' || this.disposed) return 'busy'; pipeline = current
    const manual = triggerKey.startsWith('manual:')
    const claim = manual
      ? await this.store.claimRun({ kind: 'pipeline', definitionId: pipeline.id, triggerKey, owner: this.options.workerId, leaseDurationMs: this.options.leaseDurationMs, maxAttempts: this.options.maxAttempts, permanentDedupe: false })
      : await this.store.claimPipelineTrigger({ pipelineId: pipeline.id, triggerKey, owner: this.options.workerId, leaseDurationMs: this.options.leaseDurationMs, maxAttempts: this.options.maxAttempts })
    if (claim.kind === 'completed') return 'completed'
    if (claim.kind === 'dead_letter') return 'dead_letter'
    if (claim.kind === 'busy') return 'busy'
    let running = claim.run
    const heartbeat = startLeaseHeartbeat(this.store, running.id, this.options.workerId, this.options.leaseDurationMs, { kind: 'pipeline', definitionId: pipeline.id })
    const signals = [heartbeat.signal, this.disposeController.signal]
    if (externalSignal) signals.push(externalSignal)
    const signal = AbortSignal.any(signals)
    try {
      signal.throwIfAborted()
      const order = topologicalOrder(pipeline.nodes, pipeline.edges); const nodes = new Map(pipeline.nodes.map(node => [node.id, node])); const completedNodes = new Set((running.nodeResults ?? []).map(result => result.nodeId))
      for (const nodeId of order) {
        if (completedNodes.has(nodeId)) continue; signal.throwIfAborted()
        const node = nodes.get(nodeId); if (!node) throw new Error(`pipeline node ${nodeId} disappeared`)
        const upstreamRefs: SessionContextRef[] = []
        if (node.inheritUpstreamContext) { upstreamRefs.push(...this.contextGraph.inheritedFromResults(running.nodeResults ?? [], predecessorIds(nodeId, pipeline.edges))); if (predecessorIds(nodeId, pipeline.edges).length === 0 && pipeline.trigger.kind !== 'manual') { const trigger = normalizeTrigger(pipeline.trigger, this.defaultAdapterId); if (trigger.kind === 'agent_event') upstreamRefs.push({ adapterId: adapterIdOf(trigger, this.defaultAdapterId), sessionId: trigger.sessionId, label: 'Trigger session' }) } }
        const result = await this.dispatcher.dispatchWithCorrelation({ ...node.target }, upstreamRefs, `pipeline:${pipeline.id}:${triggerKey}:${nodeId}`, running.attempt, signal); signal.throwIfAborted()
        const checkpoint: AutomationRunNodeResult = { nodeId, adapterId: result.adapterId, sessionId: result.sessionId, loadedSkills: result.loadedSkills, referencedSessions: result.referencedSessions, ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}) }
        running = await this.store.checkpointRun(running.id, this.options.workerId, checkpoint, this.options.leaseDurationMs)
      }
      await this.store.completeRun(running.id, this.options.workerId)
      return 'completed'
    } catch (error: unknown) { const message = error instanceof Error ? error.message : String(error); try { await this.store.failRun(running.id, this.options.workerId, message, { retryDelayMs: this.options.retryDelayMs, deadLetter: running.attempt >= this.options.maxAttempts }) } catch {} throw error }
    finally { heartbeat.stop() }
  }
}

async function settleAllWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (!promises.length) return
  await Promise.race([
    Promise.allSettled(promises).then(() => undefined),
    new Promise<void>(resolve => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.() }),
  ])
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => signal?.removeEventListener('abort', abort)
    const abort = (): void => {
      if (timer) clearTimeout(timer)
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    timer.unref?.()
  })
}
