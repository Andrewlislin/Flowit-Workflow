import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PipelineRuntime } from './pipeline.js'
import type { DurableScheduler } from './scheduler.js'
import type { DshTargetDispatcher } from './dispatcher.js'

export interface ToolRegistrationOptions {
  allowModelMutations: boolean
}

export function registerWorkflowTools(
  ctx: Context,
  scheduler: DurableScheduler,
  pipelines: PipelineRuntime,
  dispatcher: DshTargetDispatcher,
  options: ToolRegistrationOptions,
): void {
  registerReadTools(ctx, scheduler, pipelines)
  registerDispatchTool(ctx, dispatcher, options)
  if (!options.allowModelMutations) return
  registerScheduleMutationTools(ctx, scheduler)
  registerPipelineMutationTools(ctx, pipelines)
}

function registerReadTools(ctx: Context, scheduler: DurableScheduler, pipelines: PipelineRuntime): void {
  ctx.tools.register(defineTool({
    name: 'flowit_schedule_list',
    description: 'List durable Flowit Workflow scheduled tasks.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(await scheduler.list())
    },
  }))

  ctx.tools.register(defineTool({
    name: 'flowit_pipeline_list',
    description: 'List Flowit Workflow cross-session pipelines.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return JSON.stringify(await pipelines.list())
    },
  }))

  ctx.tools.register(defineTool({
    name: 'flowit_context_candidates',
    description: 'List candidate sessions that can be referenced as read-only context in the current session.',
    parameters: {
      query: { type: 'string', description: 'Optional title, session id, or cwd substring.' },
      limit: { type: 'integer', description: 'Maximum candidate count.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('flowit_context_candidates requires an owning agent session')
      const candidates = await ctx.sessionReferenceResolver.listCandidates(exec.agent, args.query ?? '', args.limit ?? 10, exec.signal)
      return JSON.stringify(candidates)
    },
  }))
}

function registerDispatchTool(ctx: Context, dispatcher: DshTargetDispatcher, options: ToolRegistrationOptions): void {
  if (!options.allowModelMutations) return
  ctx.tools.register(defineTool({
    name: 'flowit_dispatch_session',
    description: 'Send work to another DeepSeek Harness session, optionally binding Skills and read-only context from other sessions.',
    parameters: {
      session_id: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      skills: { type: 'array', items: { type: 'string' } },
      context_sessions: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          loadedSkills: { type: 'array', required: true, items: { type: 'string' } },
          referencedSessions: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Dispatched to ${value.sessionId}.` }],
    },
    execute(args, exec) {
      return dispatcher.dispatch({
        sessionId: args.session_id,
        prompt: args.prompt,
        skills: args.skills ?? [],
        contextRefs: (args.context_sessions ?? []).map(sessionId => ({ sessionId })),
      }, [], exec.signal)
    },
  }))
}

function registerScheduleMutationTools(ctx: Context, scheduler: DurableScheduler): void {
  ctx.tools.register(defineTool({
    name: 'flowit_schedule_create',
    description: 'Create a durable scheduled agent task. The target session may be cold and will be resumed when the task fires.',
    parameters: {
      name: { type: 'string', required: true },
      session_id: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      timing_kind: { type: 'string', required: true, enum: ['at', 'every'] },
      at: { type: 'string', description: 'ISO timestamp when timing_kind=at.' },
      every_seconds: { type: 'integer', description: 'Fixed interval when timing_kind=every.' },
      skills: { type: 'array', items: { type: 'string' } },
      context_sessions: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          nextRunAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Created schedule ${value.id}; next run ${value.nextRunAt}.` }],
    },
    async execute(args) {
      const timing = args.timing_kind === 'at'
        ? { kind: 'at' as const, at: required(args.at, 'at') }
        : { kind: 'every' as const, everySeconds: requiredInteger(args.every_seconds, 'every_seconds') }
      const task = await scheduler.create({
        name: args.name,
        timing,
        target: {
          sessionId: args.session_id,
          prompt: args.prompt,
          skills: args.skills ?? [],
          contextRefs: (args.context_sessions ?? []).map(sessionId => ({ sessionId })),
        },
      })
      if (!task.nextRunAt) throw new Error('created schedule has no nextRunAt')
      return { id: task.id, status: task.status, nextRunAt: task.nextRunAt }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'flowit_schedule_cancel',
    description: 'Cancel a Flowit Workflow scheduled task.',
    parameters: { id: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Schedule ${value.id} is ${value.status}.` }],
    },
    async execute(args) {
      const task = await scheduler.cancel(args.id)
      return { id: task.id, status: task.status }
    },
  }))
}

function registerPipelineMutationTools(ctx: Context, pipelines: PipelineRuntime): void {
  ctx.tools.register(defineTool({
    name: 'flowit_pipeline_create_linear',
    description: 'Create a linear cross-session pipeline. Each downstream step automatically receives a read-only snapshot of the previous step session.',
    parameters: {
      name: { type: 'string', required: true },
      trigger_session_id: { type: 'string', description: 'When set, run after each completed turn in this session; omit for manual-only.' },
      steps: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            session_id: { type: 'string', required: true },
            prompt: { type: 'string', required: true },
            skills: { type: 'array', items: { type: 'string' } },
            context_sessions: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string', required: true }, name: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Created pipeline ${value.name} (${value.id}).` }],
    },
    async execute(args) {
      const steps = args.steps as Array<{ id: string; session_id: string; prompt: string; skills?: string[]; context_sessions?: string[] }>
      if (steps.length === 0) throw new Error('steps must not be empty')
      const nodes = steps.map(step => ({
        id: step.id,
        inheritUpstreamContext: true,
        target: {
          sessionId: step.session_id,
          prompt: step.prompt,
          skills: step.skills ?? [],
          contextRefs: (step.context_sessions ?? []).map(sessionId => ({ sessionId })),
        },
      }))
      const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }))
      const pipeline = await pipelines.create({
        name: args.name,
        trigger: args.trigger_session_id
          ? { kind: 'session_turn_completed', sessionId: args.trigger_session_id }
          : { kind: 'manual' },
        nodes,
        edges,
      })
      return { id: pipeline.id, name: pipeline.name }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'flowit_pipeline_run',
    description: 'Run an active Flowit Workflow pipeline now.',
    parameters: { id: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, accepted: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.accepted ? `Pipeline ${value.id} completed.` : `Pipeline ${value.id} was not accepted.` }],
    },
    async execute(args) {
      await pipelines.run(args.id)
      return { id: args.id, accepted: true }
    },
  }))
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value
}

function requiredInteger(value: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`)
  return value as number
}
