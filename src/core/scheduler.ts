import { randomUUID } from 'node:crypto'
import { advanceSchedule, createScheduleRecord } from './domain.js'
import type { CreateScheduleInput, ScheduledTask } from './types.js'
import { JsonWorkflowStore } from './store.js'
import { OrchestrationDispatcher } from './dispatcher.js'

const MAX_TIMER_MS = 2_000_000_000
const DEFAULT_RECONCILE_MS = 1_000

export class DurableScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly armedAt = new Map<string, string>()
  private readonly running = new Set<string>()
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(private readonly store: JsonWorkflowStore, private readonly dispatcher: OrchestrationDispatcher, private readonly minimumIntervalSeconds: number, private readonly defaultAdapterId: string, private readonly activeWorkers = true) {}

  async start(): Promise<void> { if (!this.activeWorkers) return; await this.reconcile(); this.reconcileTimer = setInterval(() => void this.reconcile().catch(() => undefined), DEFAULT_RECONCILE_MS) }
  async create(input: CreateScheduleInput): Promise<ScheduledTask> { const task = createScheduleRecord(randomUUID(), input, new Date(), this.minimumIntervalSeconds, this.defaultAdapterId); await this.store.putSchedule(task); if (this.activeWorkers) this.arm(task); return task }
  async list(): Promise<ScheduledTask[]> { return (await this.store.snapshot()).schedules }
  async cancel(id: string): Promise<ScheduledTask> { const current = (await this.store.snapshot()).schedules.find(task => task.id === id); if (!current) throw new Error(`unknown schedule ${id}`); const { nextRunAt: _nextRunAt, ...rest } = current; const updated: ScheduledTask = { ...rest, status: 'cancelled', updatedAt: new Date().toISOString() }; await this.store.putSchedule(updated); this.clear(id); return updated }
  dispose(): void { this.disposed = true; if (this.reconcileTimer) clearInterval(this.reconcileTimer); this.reconcileTimer = undefined; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); this.armedAt.clear() }

  private async reconcile(): Promise<void> { if (this.disposed) return; const active = (await this.store.snapshot()).schedules.filter(task => task.status === 'active' && task.nextRunAt); const activeIds = new Set(active.map(task => task.id)); for (const id of this.timers.keys()) if (!activeIds.has(id)) this.clear(id); for (const task of active) { if (this.running.has(task.id)) continue; if (this.armedAt.get(task.id) !== task.nextRunAt) this.arm(task) } }
  private arm(task: ScheduledTask): void { this.clear(task.id); if (this.disposed || task.status !== 'active' || !task.nextRunAt) return; const delay = Math.max(0, Date.parse(task.nextRunAt) - Date.now()); this.armedAt.set(task.id, task.nextRunAt); this.timers.set(task.id, setTimeout(() => void this.onTimer(task.id).catch(() => undefined), Math.min(delay, MAX_TIMER_MS))) }

  private async onTimer(id: string): Promise<void> {
    this.timers.delete(id); this.armedAt.delete(id); if (this.disposed || this.running.has(id)) return
    const task = (await this.store.snapshot()).schedules.find(candidate => candidate.id === id); if (!task || task.status !== 'active' || !task.nextRunAt) return
    if (Date.parse(task.nextRunAt) > Date.now()) { this.arm(task); return }
    this.running.add(id); const runId = randomUUID(); const startedAt = new Date().toISOString(); const triggerKey = `schedule:${id}:${task.nextRunAt}`
    await this.store.putRun({ id: runId, kind: 'schedule', definitionId: id, triggerKey, status: 'running', startedAt })
    try {
      const result = await this.dispatcher.dispatch(task.target); const firedAt = new Date(); const current = (await this.store.snapshot()).schedules.find(candidate => candidate.id === id); const next = current?.status === 'active' ? advanceSchedule(task, firedAt) : current; if (next) await this.store.putSchedule(next)
      await this.store.putRun({ id: runId, kind: 'schedule', definitionId: id, triggerKey, status: 'completed', startedAt, completedAt: firedAt.toISOString(), nodeResults: [{ nodeId: 'scheduled-task', adapterId: result.adapterId, sessionId: result.sessionId, loadedSkills: result.loadedSkills, referencedSessions: result.referencedSessions, ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}) }] })
      if (next) this.arm(next)
    } catch (error: unknown) {
      const failedAt = new Date(); await this.store.putRun({ id: runId, kind: 'schedule', definitionId: id, triggerKey, status: 'failed', startedAt, completedAt: failedAt.toISOString(), error: error instanceof Error ? error.message : String(error) }); const current = (await this.store.snapshot()).schedules.find(candidate => candidate.id === id); const next = current?.status === 'active' ? advanceSchedule(task, failedAt, 'failed') : current; if (next) { await this.store.putSchedule(next); this.arm(next) }
    } finally { this.running.delete(id) }
  }

  private clear(id: string): void { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); this.armedAt.delete(id) }
}
