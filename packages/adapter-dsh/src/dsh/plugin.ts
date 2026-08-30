import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-reference'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { FlowitOrchestrationCore } from '@coaseedgeltd/flowit-core'
import { DshAgentAdapter, DSH_ADAPTER_ID } from '../adapters/dsh.js'
import { registerDshWorkflowTools } from './tools.js'

export interface DshFlowitWorkflowConfig { storageFile?: string; minimumIntervalSeconds?: number; allowModelMutations?: boolean; maxRunHistory?: number }
declare module '@deepseek-ai/cordis' { interface Context { flowitWorkflow: DshFlowitWorkflowRuntime } }
export class DshFlowitWorkflowRuntime extends Service {
  readonly core: FlowitOrchestrationCore; readonly ready: Promise<void>
  constructor(ctx: Context, config: DshFlowitWorkflowConfig = {}) { super(ctx, 'flowitWorkflow'); this.core = new FlowitOrchestrationCore({ storageFile: config.storageFile ?? '.flowit-workflow/workflow.json', defaultAdapterId: DSH_ADAPTER_ID, minimumIntervalSeconds: config.minimumIntervalSeconds ?? 60, maxRunHistory: config.maxRunHistory ?? 500 }, [new DshAgentAdapter(ctx)]); registerDshWorkflowTools(ctx, this.core, { allowModelMutations: config.allowModelMutations ?? false }); this.ready = this.core.ready }
  get store() { return this.core.store } get dispatcher() { return this.core.dispatcher } get scheduler() { return this.core.scheduler } get pipelines() { return this.core.pipelines }
  async dispose(): Promise<void> { await this.core.dispose() }
}
export const name = 'flowit-workflow'
export const Config: z<DshFlowitWorkflowConfig> = z.object({ storageFile: z.string().default('.flowit-workflow/workflow.json'), minimumIntervalSeconds: z.number().step(1).min(1).default(60), allowModelMutations: z.boolean().default(false), maxRunHistory: z.number().step(1).min(1).default(500) })
export const inject = ['agents','tools','skills','sessionReferenceResolver','sessionPersistence']
export function apply(ctx: Context, config: DshFlowitWorkflowConfig = {}): void { const runtime = new DshFlowitWorkflowRuntime(ctx, config); ctx.effect(() => () => runtime.dispose(), 'flowit-workflow.runtime()') }
