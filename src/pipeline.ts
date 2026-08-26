import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { assertNoAutonomousSessionCycle, normalizePipeline, predecessorIds, topologicalOrder } from './domain.js'
import type { AutomationRunRecord, CreatePipelineInput, PipelineDefinition, SessionContextRef } from './types.js'
import { JsonWorkflowStore } from './store.js'
import { DshTargetDispatcher } from './dispatcher.js'

export class PipelineRuntime {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly seenTriggers = new Set<string>()
  private definitionMutationTail: Promise<void> = Promise.resolve()
  private stopEvents: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly store: JsonWorkflowStore,
    private readonly dispatcher: DshTargetDispatcher,
  ) {}

  start(): void {
    this.stopEvents = this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
      const sourceSessionId = String(session.header.id)
      const triggerKey = `session:${sourceSessionId}:turn:${event.data.turn}`
      void this.triggerFromSession(sourceSessionId, triggerKey).catch(() => undefined)
    })
  }

  create(input: CreatePipelineInput): Promise<PipelineDefinition> {
    return this.serializeDefinitionMutation(async () => {
      const pipeline = normalizePipeline(randomUUID(), input, new Date())
      const existing = (await this.store.snapshot()).pipelines
      assertNoAutonomousSessionCycle([...existing, pipeline])
      await this.store.putPipeline(pipeline)
      return pipeline
    })
  }

  async list(): Promise<PipelineDefinition[]> {
    return (await this.store.snapshot()).pipelines
  }

  async run(id: string): Promise<void> {
    const pipeline = (await this.store.snapshot()).pipelines.find(candidate => candidate.id === id)
    if (!pipeline) throw new Error(`unknown pipeline ${id}`)
    if (pipeline.status !== 'active') throw new Error(`pipeline ${id} is ${pipeline.status}`)
    await this.enqueue(pipeline, `manual:${randomUUID()}`)
  }

  setStatus(id: string, status: 'active' | 'paused'): Promise<PipelineDefinition> {
    return this.serializeDefinitionMutation(async () => {
      const state = await this.store.snapshot()
      const current = state.pipelines.find(candidate => candidate.id === id)
      if (!current) throw new Error(`unknown pipeline ${id}`)
      const updated: PipelineDefinition = { ...current, status, updatedAt: new Date().toISOString() }
      if (status === 'active') {
        const others = state.pipelines.filter(candidate => candidate.id !== id)
        assertNoAutonomousSessionCycle([...others, updated])
      }
      await this.store.putPipeline(updated)
      return updated
    })
  }

  dispose(): void {
    this.disposed = true
    this.stopEvents?.()
    this.stopEvents = undefined
  }

  private async triggerFromSession(sessionId: string, triggerKey: string): Promise<void> {
    if (this.disposed || this.seenTriggers.has(triggerKey)) return
    this.seenTriggers.add(triggerKey)
    if (this.seenTriggers.size > 10_000) {
      const oldest = this.seenTriggers.values().next().value as string | undefined
      if (oldest) this.seenTriggers.delete(oldest)
    }
    const pipelines = (await this.store.snapshot()).pipelines.filter(pipeline =>
      pipeline.status === 'active'
      && pipeline.trigger.kind === 'session_turn_completed'
      && pipeline.trigger.sessionId === sessionId,
    )
    for (const pipeline of pipelines) void this.enqueue(pipeline, triggerKey).catch(() => undefined)
  }

  private async serializeDefinitionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.definitionMutationTail.then(operation, operation)
    this.definitionMutationTail = current.then(() => undefined, () => undefined)
    return current
  }

  private enqueue(pipeline: PipelineDefinition, triggerKey: string): Promise<void> {
    const previous = this.queues.get(pipeline.id) ?? Promise.resolve()
    const next = previous.then(() => this.execute(pipeline, triggerKey), () => this.execute(pipeline, triggerKey))
    this.queues.set(pipeline.id, next.catch(() => undefined))
    return next
  }

  private async execute(pipeline: PipelineDefinition, triggerKey: string): Promise<void> {
    const current = (await this.store.snapshot()).pipelines.find(candidate => candidate.id === pipeline.id)
    if (!current || current.status !== 'active') return
    pipeline = current
    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    const running: AutomationRunRecord = {
      id: runId,
      kind: 'pipeline',
      definitionId: pipeline.id,
      triggerKey,
      status: 'running',
      startedAt,
      nodeResults: [],
    }
    await this.store.putRun(running)
    try {
      const order = topologicalOrder(pipeline.nodes, pipeline.edges)
      const nodes = new Map(pipeline.nodes.map(node => [node.id, node]))
      const completedSessions = new Map<string, string>()
      for (const nodeId of order) {
        const node = nodes.get(nodeId)
        if (!node) throw new Error(`pipeline node ${nodeId} disappeared`)
        const upstreamRefs: SessionContextRef[] = []
        if (node.inheritUpstreamContext) {
          for (const predecessor of predecessorIds(nodeId, pipeline.edges)) {
            const sessionId = completedSessions.get(predecessor)
            if (sessionId) upstreamRefs.push({ sessionId, label: `Upstream ${predecessor}` })
          }
          if (predecessorIds(nodeId, pipeline.edges).length === 0 && pipeline.trigger.kind === 'session_turn_completed') {
            upstreamRefs.push({ sessionId: pipeline.trigger.sessionId, label: 'Trigger session' })
          }
        }
        const result = await this.dispatcher.dispatch(node.target, upstreamRefs)
        completedSessions.set(nodeId, result.sessionId)
        running.nodeResults?.push({ nodeId, ...result })
        await this.store.putRun(running)
      }
      await this.store.putRun({ ...running, status: 'completed', completedAt: new Date().toISOString() })
    } catch (error: unknown) {
      await this.store.putRun({
        ...running,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
