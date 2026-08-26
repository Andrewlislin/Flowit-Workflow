import { Service, type Context } from '@deepseek-ai/cordis'
import path from 'node:path'
import { JsonWorkflowStore } from './store.js'
import { DshTargetDispatcher } from './dispatcher.js'
import { DurableScheduler } from './scheduler.js'
import { PipelineRuntime } from './pipeline.js'
import { registerWorkflowTools } from './tools.js'
import type { FlowitWorkflowConfig } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    flowitWorkflow: FlowitWorkflowRuntime
  }
}

export class FlowitWorkflowRuntime extends Service {
  readonly store: JsonWorkflowStore
  readonly dispatcher: DshTargetDispatcher
  readonly scheduler: DurableScheduler
  readonly pipelines: PipelineRuntime
  readonly ready: Promise<void>

  constructor(ctx: Context, config: FlowitWorkflowConfig = {}) {
    super(ctx, 'flowitWorkflow')
    const storageFile = path.resolve(config.storageFile ?? '.dsh/flowit-workflow.json')
    const minimumIntervalSeconds = config.minimumIntervalSeconds ?? 60
    if (!Number.isSafeInteger(minimumIntervalSeconds) || minimumIntervalSeconds < 1) {
      throw new Error('minimumIntervalSeconds must be a positive integer')
    }
    const maxRunHistory = config.maxRunHistory ?? 500
    if (!Number.isSafeInteger(maxRunHistory) || maxRunHistory < 1) {
      throw new Error('maxRunHistory must be a positive integer')
    }
    this.store = new JsonWorkflowStore(storageFile, maxRunHistory)
    this.dispatcher = new DshTargetDispatcher(ctx)
    this.scheduler = new DurableScheduler(this.store, this.dispatcher, minimumIntervalSeconds)
    this.pipelines = new PipelineRuntime(ctx, this.store, this.dispatcher)
    this.pipelines.start()
    registerWorkflowTools(ctx, this.scheduler, this.pipelines, this.dispatcher, {
      allowModelMutations: config.allowModelMutations ?? false,
    })
    this.ready = this.scheduler.start()
  }

  async dispose(): Promise<void> {
    this.scheduler.dispose()
    this.pipelines.dispose()
    await this.ready.catch(() => undefined)
  }
}
