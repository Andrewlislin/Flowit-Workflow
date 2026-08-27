import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { AgentAdapterRegistry } from './adapter.js'
import { ContextGraph } from './context-graph.js'
import { SkillBinder } from './skill-binding.js'
import { JsonWorkflowStore } from './store.js'
import { OrchestrationDispatcher } from './dispatcher.js'
import { DurableScheduler } from './scheduler.js'
import { PipelineRuntime } from './pipeline.js'
import type { AgentAdapter, FlowitCoreConfig } from './types.js'

const DISPOSE_READY_GRACE_MS = 5_000

export class FlowitOrchestrationCore {
  readonly adapters = new AgentAdapterRegistry()
  readonly contextGraph = new ContextGraph()
  readonly skillBinder = new SkillBinder()
  readonly store: JsonWorkflowStore
  readonly dispatcher: OrchestrationDispatcher
  readonly scheduler: DurableScheduler
  readonly pipelines: PipelineRuntime
  readonly ready: Promise<void>
  readonly workerId: string
  private readonly startupController = new AbortController()
  private disposed = false

  constructor(config: FlowitCoreConfig, initialAdapters: readonly AgentAdapter[] = []) {
    const storageFile = path.resolve(config.storageFile ?? '.flowit-workflow/workflow.json')
    const minimumIntervalSeconds = positiveInteger(
      config.minimumIntervalSeconds ?? 60,
      'minimumIntervalSeconds',
    )
    const maxRunHistory = positiveInteger(config.maxRunHistory ?? 500, 'maxRunHistory')
    const maxTerminalReceipts = positiveInteger(
      config.maxTerminalReceipts ?? 100_000,
      'maxTerminalReceipts',
    )
    const terminalReceiptRetentionMs = integerAtLeast(
      config.terminalReceiptRetentionMs ?? 90 * 24 * 60 * 60 * 1_000,
      60_000,
      'terminalReceiptRetentionMs',
    )
    const maxEventInbox = positiveInteger(config.maxEventInbox ?? 10_000, 'maxEventInbox')
    if (!config.defaultAdapterId.trim()) throw new Error('defaultAdapterId must be non-empty')
    const leaseDurationMs = integerAtLeast(
      config.leaseDurationMs ?? 30_000,
      1_000,
      'leaseDurationMs',
    )
    const retryDelayMs = positiveInteger(config.retryDelayMs ?? 5_000, 'retryDelayMs')
    const maxPipelineAttempts = positiveInteger(
      config.maxPipelineAttempts ?? 3,
      'maxPipelineAttempts',
    )
    const maxScheduleAttempts = positiveInteger(
      config.maxScheduleAttempts ?? 3,
      'maxScheduleAttempts',
    )
    this.workerId = config.workerId?.trim() || `worker:${process.pid}:${randomUUID()}`
    this.store = new JsonWorkflowStore(
      storageFile,
      maxRunHistory,
      config.legacyStorageFiles ?? [],
      maxTerminalReceipts,
      terminalReceiptRetentionMs,
      maxEventInbox,
    )
    for (const adapter of initialAdapters) this.adapters.register(adapter)
    this.dispatcher = new OrchestrationDispatcher(
      this.adapters,
      this.contextGraph,
      this.skillBinder,
      config.defaultAdapterId,
    )
    const activeWorkers = config.activeWorkers ?? true
    this.scheduler = new DurableScheduler(
      this.store,
      this.dispatcher,
      minimumIntervalSeconds,
      config.defaultAdapterId,
      { workerId: this.workerId, leaseDurationMs, retryDelayMs, maxAttempts: maxScheduleAttempts },
      activeWorkers,
    )
    this.pipelines = new PipelineRuntime(
      this.adapters,
      this.store,
      this.dispatcher,
      this.contextGraph,
      config.defaultAdapterId,
      { workerId: this.workerId, leaseDurationMs, retryDelayMs, maxAttempts: maxPipelineAttempts },
    )
    this.ready = this.initialize(activeWorkers, this.startupController.signal)
  }

  registerAdapter(adapter: AgentAdapter): () => void {
    if (this.disposed) throw new Error('Flowit Orchestration Core is disposed')
    return this.adapters.register(adapter)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.startupController.abort(new Error('Flowit Orchestration Core disposed during startup'))
    this.scheduler.dispose()
    const pipelineStop = this.pipelines.dispose()
    await this.adapters.dispose()
    await pipelineStop
    await settleWithin(this.ready, DISPOSE_READY_GRACE_MS)
  }

  private async initialize(activeWorkers: boolean, signal: AbortSignal): Promise<void> {
    try {
      await this.store.snapshot()
      signal.throwIfAborted()
      if (!activeWorkers || this.disposed) return
      await this.adapters.startAll(signal)
      signal.throwIfAborted()
      await this.pipelines.start(signal)
      signal.throwIfAborted()
      await this.scheduler.start()
    } catch (error: unknown) {
      if (!this.startupController.signal.aborted) this.startupController.abort(error)
      throw error
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`)
  return value
}
function integerAtLeast(value: number, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}`)
  return value
}
async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    }),
  ])
}
