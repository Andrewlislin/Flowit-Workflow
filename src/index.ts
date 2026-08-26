/**
 * Flowit Workflow for DeepSeek Harness.
 * Cross-session orchestration, durable scheduling, Skill binding, and session-reference context flow.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-reference'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { FlowitWorkflowRuntime } from './runtime.js'
import type { FlowitWorkflowConfig } from './types.js'

export * from './types.js'
export * from './domain.js'
export { JsonWorkflowStore } from './store.js'
export { DshTargetDispatcher } from './dispatcher.js'
export { DurableScheduler } from './scheduler.js'
export { PipelineRuntime } from './pipeline.js'
export { FlowitWorkflowRuntime } from './runtime.js'

export const name = 'flowit-workflow'
export const Config: z<FlowitWorkflowConfig> = z.object({
  storageFile: z.string().default('.dsh/flowit-workflow.json'),
  minimumIntervalSeconds: z.number().step(1).min(1).default(60),
  allowModelMutations: z.boolean().default(false),
  maxRunHistory: z.number().step(1).min(1).default(500),
})
export const inject = ['agents', 'tools', 'skills', 'sessionReferenceResolver', 'sessionPersistence']

export function apply(ctx: Context, config: FlowitWorkflowConfig = {}): void {
  const runtime = new FlowitWorkflowRuntime(ctx, config)
  ctx.effect(() => () => runtime.dispose(), 'flowit-workflow.runtime()')
}
