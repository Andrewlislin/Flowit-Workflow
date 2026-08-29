import { randomUUID } from 'node:crypto'
import { advanceSchedule, createScheduleRecord } from './domain.js'
import type { CreateScheduleInput, ScheduledTask } from './types.js'
import { JsonWorkflowStore } from './store.js'
import { OrchestrationDispatcher } from './dispatcher.js'
import { PipelineRuntime } from './pipeline.js'
import { startLeaseHeartbeat } from './lease.js'

const MAX_TIMER_MS = 2_000_000_000
const DEFAULT_RECONCILE_MS = 1_000
export interface SchedulerRuntimeOptions { workerId: string; leaseDurationMs: number; retryDelayMs: number; maxAttempts: number }

export class DurableScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly armedAt = new Map<string, string>()
  private readonly localControllers = new Map<string, AbortController>()
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(private readonly store: JsonWorkflowStore, private readonly dispatcher: OrchestrationDispatcher, private readonly pipelines: PipelineRuntime, private readonly minimumIntervalSeconds: number, private readonly defaultAdapterId: string, private readonly options: SchedulerRuntimeOptions, private readonly activeWorkers = true) {}
  async start(): Promise<void> { if (!this.activeWorkers) return; await this.reconcile(); this.reconcileTimer = setInterval(() => void this.reconcile().catch(() => undefined), DEFAULT_RECONCILE_MS) }
  async create(input: CreateScheduleInput): Promise<ScheduledTask> {
    if (typeof input.pipelineId === 'string') {
      const pipeline = (await this.store.snapshot()).pipelines.find(candidate => candidate.id === input.pipelineId)
      if (!pipeline) throw new Error(`unknown pipeline ${input.pipelineId}`)
    }
    const task = createScheduleRecord(randomUUID(), input, new Date(), this.minimumIntervalSeconds, this.defaultAdapterId); await this.store.putSchedule(task); if (this.activeWorkers) this.arm(task); return task
  }
  async list(): Promise<ScheduledTask[]> { return (await this.store.snapshot()).schedules }
  async cancel(id: string): Promise<ScheduledTask> { const updated = await this.store.transact(state => { const index = state.schedules.findIndex(task => task.id === id); if (index < 0) throw new Error(`unknown schedule ${id}`); const current = state.schedules[index]!; const { nextRunAt: _nextRunAt, ...rest } = current; const next: ScheduledTask = { ...rest, status: 'cancelled', updatedAt: new Date().toISOString() }; state.schedules[index] = next; return next }); this.localControllers.get(id)?.abort(new Error(`schedule ${id} cancelled`)); this.clear(id); return updated }
  dispose(): void { this.disposed = true; if (this.reconcileTimer) clearInterval(this.reconcileTimer); this.reconcileTimer = undefined; for (const controller of this.localControllers.values()) controller.abort(new Error('scheduler disposed')); this.localControllers.clear(); for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); this.armedAt.clear() }

  private async reconcile(): Promise<void> { if (this.disposed) return; const active = (await this.store.snapshot()).schedules.filter(task => task.status === 'active' && task.nextRunAt); const activeIds = new Set(active.map(task => task.id)); for (const id of this.timers.keys()) if (!activeIds.has(id)) this.clear(id); for (const task of active) { if (this.localControllers.has(task.id)) continue; if (this.armedAt.get(task.id) !== task.nextRunAt) this.arm(task) } }
  private arm(task: ScheduledTask): void { this.clear(task.id); if (this.disposed || task.status !== 'active' || !task.nextRunAt) return; const delay = Math.max(0, Date.parse(task.nextRunAt) - Date.now()); this.armedAt.set(task.id, task.nextRunAt); this.timers.set(task.id, setTimeout(() => void this.onTimer(task.id).catch(() => undefined), Math.min(delay, MAX_TIMER_MS))) }

  private async onTimer(id: string): Promise<void> {
    this.timers.delete(id); this.armedAt.delete(id); if (this.disposed || this.localControllers.has(id)) return
    const task = (await this.store.snapshot()).schedules.find(candidate => candidate.id === id); if (!task || task.status !== 'active' || !task.nextRunAt) return
    const scheduledAt = task.nextRunAt; if (Date.parse(scheduledAt) > Date.now()) { this.arm(task); return }
    const triggerKey = `schedule:${id}:${scheduledAt}`
    const claim = await this.store.claimScheduleOccurrence({ scheduleId: id, expectedNextRunAt: scheduledAt, triggerKey, owner: this.options.workerId, leaseDurationMs: this.options.leaseDurationMs, maxAttempts: this.options.maxAttempts })
    if (claim.kind === 'not_current') return
    if (claim.kind === 'completed') { await this.settleOccurrence(task, scheduledAt, triggerKey, 'completed'); return }
    if (claim.kind === 'dead_letter') { await this.settleOccurrence(task, scheduledAt, triggerKey, 'failed'); return }
    if (claim.kind === 'busy') return
    const controller = new AbortController(); this.localControllers.set(id, controller)
    const heartbeat = startLeaseHeartbeat(this.store, claim.run.id, this.options.workerId, this.options.leaseDurationMs, { kind: 'schedule', definitionId: id }); const signal = AbortSignal.any([controller.signal, heartbeat.signal])
    try {
      if (typeof task.pipelineId === 'string') await this.pipelines.runWithTrigger(task.pipelineId, triggerKey, signal)
      else await this.dispatcher.dispatchWithCorrelation(task.target, [], triggerKey, claim.run.attempt, signal)
      signal.throwIfAborted(); const completedAt = new Date(); await this.store.completeRun(claim.run.id, this.options.workerId, completedAt); await this.settleOccurrence(task, scheduledAt, triggerKey, 'completed', completedAt)
    }
    catch (error: unknown) { const failedAt = new Date(); const message = error instanceof Error ? error.message : String(error); const deadLetter = claim.run.attempt >= this.options.maxAttempts; try { await this.store.failRun(claim.run.id, this.options.workerId, message, { retryDelayMs: this.options.retryDelayMs, deadLetter }, failedAt) } catch {} if (deadLetter) await this.settleOccurrence(task, scheduledAt, triggerKey, 'failed', failedAt) }
    finally { heartbeat.stop(); this.localControllers.delete(id) }
  }

  private async settleOccurrence(task: ScheduledTask, scheduledAt: string, triggerKey: string, outcome: 'completed' | 'failed', at = new Date()): Promise<void> {
    const next = await this.store.transact(state => {
      const index = state.schedules.findIndex(candidate => candidate.id === task.id); if (index < 0) return undefined
      const current = state.schedules[index]!; if (current.status !== 'active' || current.nextRunAt !== scheduledAt) return current
      const updated = advanceSchedule(current, at, outcome); state.schedules[index] = updated
      const receiptIndex = state.terminalReceipts.findIndex(receipt => receipt.kind === 'schedule' && receipt.definitionId === task.id && receipt.triggerKey === triggerKey); if (receiptIndex >= 0) state.terminalReceipts.splice(receiptIndex, 1)
      return updated
    })
    if (next?.status === 'active') this.arm(next); else this.clear(task.id)
  }

  private clear(id: string): void { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); this.armedAt.delete(id) }
}