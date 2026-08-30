import type { FlowitOrchestrationCore } from './core/runtime.js'
import type { AutomationTarget, CreatePipelineInput, CreateScheduleInput } from './core/types.js'
import {
  commitPreparedWorkflow,
  createRoutingAuthorityFromEnvironment,
  getAdaptiveWorkflowRun,
  prepareWorkflow,
  type CommitPreparedWorkflowOptions,
  type PrepareWorkflowInput,
  type RoutingAuthorityService,
  type TaskAssessmentRequest,
} from './routing/index.js'

export type ControlRequest =
  | { op: 'state' }
  | { op: 'sessions.list'; adapterId?: string; query?: string }
  | { op: 'dispatch'; target: AutomationTarget }
  | { op: 'schedule.list' }
  | { op: 'schedule.create'; input: CreateScheduleInput }
  | { op: 'schedule.cancel'; id: string }
  | { op: 'pipeline.list' }
  | { op: 'pipeline.create'; input: CreatePipelineInput }
  | { op: 'pipeline.run'; id: string }
  | { op: 'pipeline.status'; id: string; status: 'active' | 'paused' }
  | { op: 'workflow.assess'; input: TaskAssessmentRequest }
  | { op: 'workflow.prepare'; input: PrepareWorkflowInput }
  | {
      op: 'workflow.commit'
      proposal: unknown
      expectedHash: string
      options?: CommitPreparedWorkflowOptions
    }
  | { op: 'workflow.run.get'; runId: string }

export async function executeControl(
  core: FlowitOrchestrationCore,
  request: ControlRequest,
  routingAuthority: RoutingAuthorityService = createRoutingAuthorityFromEnvironment(),
): Promise<unknown> {
  await core.ready
  switch (request.op) {
    case 'state':
      return core.store.snapshot()
    case 'sessions.list': {
      const adapters = request.adapterId
        ? [core.adapters.require(request.adapterId)]
        : core.adapters.list()
      return (await Promise.all(adapters.map(async adapter => {
        await core.adapters.start(adapter)
        return adapter.listSessions(request.query ?? '')
      }))).flat()
    }
    case 'dispatch':
      return core.dispatcher.dispatch(request.target)
    case 'schedule.list':
      return core.scheduler.list()
    case 'schedule.create':
      return core.scheduler.create(request.input)
    case 'schedule.cancel':
      return core.scheduler.cancel(request.id)
    case 'pipeline.list':
      return core.pipelines.list()
    case 'pipeline.create':
      return core.pipelines.create(request.input)
    case 'pipeline.run':
      await core.pipelines.run(request.id)
      return { id: request.id, completed: true }
    case 'pipeline.status':
      return core.pipelines.setStatus(request.id, request.status)
    case 'workflow.assess':
      return routingAuthority.assess(request.input)
    case 'workflow.prepare':
      return prepareWorkflow(core, routingAuthority, request.input)
    case 'workflow.commit':
      return commitPreparedWorkflow(
        core,
        routingAuthority,
        request.proposal,
        request.expectedHash,
        request.options,
      )
    case 'workflow.run.get':
      return getAdaptiveWorkflowRun(core, request.runId)
    default: {
      const exhaustive: never = request
      throw new Error(`unknown control request: ${JSON.stringify(exhaustive)}`)
    }
  }
}
