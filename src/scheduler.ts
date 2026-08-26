import { randomUUID } from 'node:crypto'
import { advanceSchedule, createScheduleRecord } from './domain.js'
import type { CreateScheduleInput, ScheduledTask } from './types.js'
import { JsonWorkflowStore } from './store.js'
import { DshTargetDispatcher } from './dispatcher.js'

const MAX_TIMER_MS = 2_000_000_000

export class DurableScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Set<string>()
  private disposed = false

  constructor(
    private readonly store: JsonWorkflowStore,
    private readonly dispatcher: DshTargetDispatcher,
    private readonly minimumIntervalSeconds: number,
  ) {}

  async start(): Promise<void> {
    const state = await this.store.snapshot()
    for (const task of state.schedules) if (task.status === 'active') this.arm(task)
  }

  async create(input: CreateScheduleInput): Promise<ScheduledTask> {
    const task = createScheduleRecord(randomUUID(), input, new Date(), this.minimumIntervalSeconds)
    await this.store.putSchedule(task)
    this.arm(task)
    return task
  }

  async list(): Promise<ScheduledTask[]> {
    return (await this.store.snapshot()).schedules
  }

  async cancel(id: string): Promise<ScheduledTask> {
    const current = (await this.store.snapshot()).schedules.find(task => task.id === id)
    if (!current) throw new Error(`unknown schedule ${id}`)
    const { nextRunAt: _nextRunAt, ...rest } = current
    const updated: ScheduledTask = { ...rest, status: 'cancelled', updatedAt: new Date().toISOString() }
    await this.store.putSchedule(updated)
    this.clear(id)
    return updated
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private arm(task: ScheduledTask): void {
    this.clear(task.id)
    if (this.disposed || task.status !== 'active' || !task.nextRunAt) return
    const delay = Math.max(0, Date.parse(task.nextRunAt) - Date.now())
    this.timers.set(task.id, setTimeout(() => void this.onTimer(task.id).catch(() => undefined), Math.min(delay, MAX_TIMER_MS)))
  }

  private async onTimer(id: string): Promise<void> {
    this.timers.delete(id)
    if (this.disposed || this.running.has(id)) return
    const task = (await this.store.snapshot()).schedules.find(candidate => candidate.id === id)
    if (!task || task.status !== 'active' || !task.nextRunAt) return
    if (Date.parse(task.nextRunAt) > Date.now()) {
      this.arm(task)
      return
    }
    this.running.add(id)
    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    await this.store.putRun({ id: runId, kind: 'schedule', definitionId: id, triggerKey: `schedule:${id}:${task.nextRunAt}`, status: 'running', startedAt })
    try {
      const result = await this.dispatcher.dispatch(task.target)
      const firedAt = new Date()
      const current = (await this.store.snapshot()).schedules.find(candidate => candidate.id === id)
      const next = current?.status === 'active' ? advanceSchedule(task, firedAt) : current
      if (next) await this.store.putSchedule(next)
      await this.store.putRun({
        id: runId,
        kind: 'schedule',
        definitionId: id,
        triggerKey: `schedule:${id}:${task.nextRunAt}`,
        status: 'completed',
        startedAt,
        completedAt: firedAt.toISOString(),
        nodeResults: [{ nodeId: 'scheduled-task', ...result }],
      })
      if (next) this.arm(next)
    } catch (error: unknown) {
      const failedAt = new Date()
      await this.store.putRun({
        id: runId,
        kind: 'schedule',
        definitionId: id,
        triggerKey: `schedule:${id}:${task.nextRunAt}`,
        status: 'failed',
        startedAt,
        completedAt: failedAt.toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      const current = (await this.store.snapshot()).schedules.find(candidate => candidate.id === id)
      const next = current?.status === 'active' ? advanceSchedule(task, failedAt, 'failed') : current
      if (next) {
        await this.store.putSchedule(next)
        this.arm(next)
      }
    } finally {
      this.running.delete(id)
    }
  }

  private clear(id: string): void {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }
}
