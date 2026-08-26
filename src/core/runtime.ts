import path from 'node:path'
import { AgentAdapterRegistry } from './adapter.js'
import { ContextGraph } from './context-graph.js'
import { SkillBinder } from './skill-binding.js'
import { JsonWorkflowStore } from './store.js'
import { OrchestrationDispatcher } from './dispatcher.js'
import { DurableScheduler } from './scheduler.js'
import { PipelineRuntime } from './pipeline.js'
import type { AgentAdapter, FlowitCoreConfig } from './types.js'

export class FlowitOrchestrationCore {
  readonly adapters = new AgentAdapterRegistry(); readonly contextGraph = new ContextGraph(); readonly skillBinder = new SkillBinder(); readonly store: JsonWorkflowStore; readonly dispatcher: OrchestrationDispatcher; readonly scheduler: DurableScheduler; readonly pipelines: PipelineRuntime; readonly ready: Promise<void>
  private disposed = false
  constructor(config: FlowitCoreConfig, initialAdapters: readonly AgentAdapter[] = []) {
    const storageFile = path.resolve(config.storageFile ?? '.flowit-workflow/workflow.json'); const minimumIntervalSeconds = config.minimumIntervalSeconds ?? 60; if (!Number.isSafeInteger(minimumIntervalSeconds) || minimumIntervalSeconds < 1) throw new Error('minimumIntervalSeconds must be a positive integer'); const maxRunHistory = config.maxRunHistory ?? 500; if (!Number.isSafeInteger(maxRunHistory) || maxRunHistory < 1) throw new Error('maxRunHistory must be a positive integer'); if (!config.defaultAdapterId.trim()) throw new Error('defaultAdapterId must be non-empty')
    this.store = new JsonWorkflowStore(storageFile, maxRunHistory); for (const adapter of initialAdapters) this.adapters.register(adapter); this.dispatcher = new OrchestrationDispatcher(this.adapters, this.contextGraph, this.skillBinder, config.defaultAdapterId); const activeWorkers = config.activeWorkers ?? true; this.scheduler = new DurableScheduler(this.store, this.dispatcher, minimumIntervalSeconds, config.defaultAdapterId, activeWorkers); this.pipelines = new PipelineRuntime(this.adapters, this.store, this.dispatcher, this.contextGraph, config.defaultAdapterId); if (activeWorkers) this.pipelines.start(); this.ready = activeWorkers ? this.scheduler.start() : Promise.resolve()
  }
  registerAdapter(adapter: AgentAdapter): () => void { if (this.disposed) throw new Error('Flowit Orchestration Core is disposed'); return this.adapters.register(adapter) }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.scheduler.dispose(); this.pipelines.dispose(); await this.ready.catch(() => undefined); await this.adapters.dispose() }
}
