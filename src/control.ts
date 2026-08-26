import type { FlowitOrchestrationCore } from './core/runtime.js'
import type { AutomationTarget, CreatePipelineInput, CreateScheduleInput } from './core/types.js'

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

export async function executeControl(core: FlowitOrchestrationCore, request: ControlRequest): Promise<unknown> {
  await core.ready
  switch (request.op) {
    case 'state': return core.store.snapshot()
    case 'sessions.list': { const adapters = request.adapterId ? [core.adapters.require(request.adapterId)] : core.adapters.list(); return (await Promise.all(adapters.map(adapter => adapter.listSessions(request.query ?? '')))).flat() }
    case 'dispatch': return core.dispatcher.dispatch(request.target)
    case 'schedule.list': return core.scheduler.list()
    case 'schedule.create': return core.scheduler.create(request.input)
    case 'schedule.cancel': return core.scheduler.cancel(request.id)
    case 'pipeline.list': return core.pipelines.list()
    case 'pipeline.create': return core.pipelines.create(request.input)
    case 'pipeline.run': await core.pipelines.run(request.id); return { id: request.id, completed: true }
    case 'pipeline.status': return core.pipelines.setStatus(request.id, request.status)
    default: { const exhaustive: never = request; throw new Error(`unknown control request: ${JSON.stringify(exhaustive)}`) }
  }
}
