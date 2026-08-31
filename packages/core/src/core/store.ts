import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { durableReplaceText, withGenerationFileLock } from '../internal/file-lock.js'
import type {
  AgentEvent,
  AutomationRunNodeResult,
  AutomationRunRecord,
  AutomationTerminalReceipt,
  PipelineEventAdmission,
  PipelineDefinition,
  ScheduledTask,
  SessionProvisioningIntent,
  WorkflowState,
} from './types.js'

const EMPTY_STATE: WorkflowState = {
  version: 2,
  schedules: [],
  pipelines: [],
  eventInbox: [],
  runs: [],
  terminalReceipts: [],
  provisioningIntents: [],
}
const LEGACY_PID_INITIALIZATION_GRACE_MS = 2_000
const LEGACY_PID_GUARD_TIMEOUT_MS = 5_000

export interface RunClaimInput {
  kind: 'schedule' | 'pipeline'
  definitionId: string
  triggerKey: string
  owner: string
  leaseDurationMs: number
  maxAttempts: number
  permanentDedupe?: boolean
  now?: Date
}
export type RunClaimResult =
  | { kind: 'claimed'; run: AutomationRunRecord }
  | { kind: 'completed'; run?: AutomationRunRecord; receipt?: AutomationTerminalReceipt }
  | { kind: 'busy'; run: AutomationRunRecord }
  | { kind: 'dead_letter'; run?: AutomationRunRecord; receipt?: AutomationTerminalReceipt }
export interface ScheduleOccurrenceClaimInput {
  scheduleId: string
  expectedNextRunAt: string
  triggerKey: string
  owner: string
  leaseDurationMs: number
  maxAttempts: number
  now?: Date
}
export type ScheduleOccurrenceClaimResult =
  | RunClaimResult
  | { kind: 'not_current'; schedule?: ScheduledTask }
export interface PipelineTriggerAdmissionInput {
  pipelineId: string
  triggerKey: string
  event: AgentEvent
  receivedAt?: Date
}
export interface PipelineTriggerClaimInput {
  pipelineId: string
  triggerKey: string
  owner: string
  leaseDurationMs: number
  maxAttempts: number
  now?: Date
}
export interface LeaseDefinitionGuard {
  kind: 'schedule' | 'pipeline'
  definitionId: string
}

export class JsonWorkflowStore {
  private state: WorkflowState = structuredClone(EMPTY_STATE)
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly maxRunHistory = 500,
    private readonly legacyFilePaths: readonly string[] = [],
    private readonly maxTerminalReceipts = 100_000,
    private readonly terminalReceiptRetentionMs = 90 * 24 * 60 * 60 * 1_000,
    private readonly maxEventInbox = 10_000,
  ) {}

  async snapshot(): Promise<WorkflowState> {
    await this.ensureLoaded()
    await this.mutationTail
    this.state = await this.readCurrent()
    return structuredClone(this.state)
  }
  async putSchedule(task: ScheduledTask): Promise<void> {
    await this.mutate(state => {
      const index = state.schedules.findIndex(candidate => candidate.id === task.id)
      if (index >= 0) state.schedules[index] = task
      else state.schedules.push(task)
    })
  }
  async putPipeline(pipeline: PipelineDefinition): Promise<void> {
    await this.mutate(state => {
      const index = state.pipelines.findIndex(candidate => candidate.id === pipeline.id)
      if (index >= 0) state.pipelines[index] = pipeline
      else state.pipelines.push(pipeline)
    })
  }
  async putRun(run: AutomationRunRecord): Promise<void> {
    await this.mutate(state => {
      const index = state.runs.findIndex(candidate => candidate.id === run.id)
      if (index >= 0) state.runs[index] = run
      else state.runs.push(run)
      this.pruneRuns(state)
    })
  }

  async reserveProvisioningIntent(
    intent: SessionProvisioningIntent,
  ): Promise<{ created: boolean; intent: SessionProvisioningIntent }> {
    return this.transact(state => {
      const existing = state.provisioningIntents.find(candidate => candidate.id === intent.id)
      if (existing) return { created: false, intent: structuredClone(existing) }
      const stored = structuredClone(intent)
      state.provisioningIntents.push(stored)
      return { created: true, intent: structuredClone(stored) }
    })
  }

  async replaceProvisioningIntent(intent: SessionProvisioningIntent): Promise<void> {
    await this.mutate(state => {
      const index = state.provisioningIntents.findIndex(candidate => candidate.id === intent.id)
      if (index < 0) throw new Error(`unknown provisioning intent ${intent.id}`)
      state.provisioningIntents[index] = structuredClone(intent)
    })
  }

  async removeProvisioningIntent(id: string): Promise<void> {
    await this.mutate(state => {
      const index = state.provisioningIntents.findIndex(candidate => candidate.id === id)
      if (index >= 0) state.provisioningIntents.splice(index, 1)
    })
  }

  async admitPipelineTriggers(
    inputs: readonly PipelineTriggerAdmissionInput[],
  ): Promise<PipelineEventAdmission[]> {
    if (inputs.length === 0) return []
    return this.transact(state => {
      const admitted: PipelineEventAdmission[] = []
      for (const input of inputs) {
        const pipeline = state.pipelines.find(item => item.id === input.pipelineId)
        if (!pipeline || pipeline.status !== 'active') continue
        const covered =
          state.terminalReceipts.some(
            item =>
              item.kind === 'pipeline' &&
              item.definitionId === input.pipelineId &&
              item.triggerKey === input.triggerKey,
          ) ||
          state.runs.some(
            item =>
              item.kind === 'pipeline' &&
              item.definitionId === input.pipelineId &&
              item.triggerKey === input.triggerKey,
          )
        if (covered) continue
        const existing = state.eventInbox.find(
          item => item.pipelineId === input.pipelineId && item.triggerKey === input.triggerKey,
        )
        if (existing) {
          admitted.push(structuredClone(existing))
          continue
        }
        if (state.eventInbox.length >= this.maxEventInbox) {
          throw new Error(
            `pipeline event inbox capacity exceeded (${this.maxEventInbox}); event admission is fail-closed`,
          )
        }
        const receivedAt = (input.receivedAt ?? new Date()).toISOString()
        const row: PipelineEventAdmission = {
          id: randomUUID(),
          pipelineId: input.pipelineId,
          triggerKey: input.triggerKey,
          adapterId: input.event.adapterId,
          sessionId: input.event.sessionId,
          eventKind: input.event.kind,
          eventId: input.event.eventId,
          receivedAt,
        }
        state.eventInbox.push(row)
        admitted.push(structuredClone(row))
      }
      return admitted
    })
  }

  async claimRun(input: RunClaimInput): Promise<RunClaimResult> {
    return this.transact(state => this.claimRunInState(state, input))
  }

  async claimPipelineTrigger(input: PipelineTriggerClaimInput): Promise<RunClaimResult> {
    return this.transact(state => {
      const result = this.claimRunInState(state, {
        kind: 'pipeline',
        definitionId: input.pipelineId,
        triggerKey: input.triggerKey,
        owner: input.owner,
        leaseDurationMs: input.leaseDurationMs,
        maxAttempts: input.maxAttempts,
        permanentDedupe: true,
        ...(input.now ? { now: input.now } : {}),
      })
      const admissionIndex = state.eventInbox.findIndex(
        item => item.pipelineId === input.pipelineId && item.triggerKey === input.triggerKey,
      )
      if (admissionIndex >= 0) state.eventInbox.splice(admissionIndex, 1)
      return result
    })
  }

  async claimScheduleOccurrence(
    input: ScheduleOccurrenceClaimInput,
  ): Promise<ScheduleOccurrenceClaimResult> {
    return this.transact(state => {
      const schedule = state.schedules.find(item => item.id === input.scheduleId)
      if (
        !schedule ||
        schedule.status !== 'active' ||
        schedule.nextRunAt !== input.expectedNextRunAt
      ) {
        return schedule
          ? { kind: 'not_current' as const, schedule: structuredClone(schedule) }
          : { kind: 'not_current' as const }
      }
      return this.claimRunInState(state, {
        kind: 'schedule',
        definitionId: input.scheduleId,
        triggerKey: input.triggerKey,
        owner: input.owner,
        leaseDurationMs: input.leaseDurationMs,
        maxAttempts: input.maxAttempts,
        permanentDedupe: true,
        ...(input.now ? { now: input.now } : {}),
      })
    })
  }

  async renewRunLease(
    runId: string,
    owner: string,
    leaseDurationMs: number,
    guard?: LeaseDefinitionGuard,
    now = new Date(),
  ): Promise<boolean> {
    return this.transact(state => {
      const run = state.runs.find(item => item.id === runId)
      if (!run || run.status !== 'running' || run.leaseOwner !== owner) return false
      if (
        guard?.kind === 'schedule' &&
        !state.schedules.some(item => item.id === guard.definitionId && item.status === 'active')
      )
        return false
      if (
        guard?.kind === 'pipeline' &&
        !state.pipelines.some(item => item.id === guard.definitionId && item.status === 'active')
      )
        return false
      const nowIso = now.toISOString()
      run.lastHeartbeatAt = nowIso
      run.updatedAt = nowIso
      run.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString()
      return true
    })
  }

  async checkpointRun(
    runId: string,
    owner: string,
    result: AutomationRunNodeResult,
    leaseDurationMs: number,
    now = new Date(),
  ): Promise<AutomationRunRecord> {
    return this.transact(state => {
      const run = requireOwnedRunning(state, runId, owner)
      const rows = run.nodeResults ?? []
      const index = rows.findIndex(item => item.nodeId === result.nodeId)
      if (index >= 0) rows[index] = result
      else rows.push(result)
      run.nodeResults = rows
      const nowIso = now.toISOString()
      run.lastHeartbeatAt = nowIso
      run.updatedAt = nowIso
      run.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString()
      return structuredClone(run)
    })
  }

  async completeRun(
    runId: string,
    owner: string,
    completedAt = new Date(),
  ): Promise<AutomationRunRecord> {
    return this.transact(state => {
      const run = requireOwnedRunning(state, runId, owner)
      const at = completedAt.toISOString()
      run.status = 'completed'
      run.completedAt = at
      run.updatedAt = at
      delete run.error
      delete run.retryNotBefore
      delete run.leaseOwner
      delete run.leaseExpiresAt
      if (run.permanentDedupe) addTerminalReceipt(state, run, 'completed', at)
      return structuredClone(run)
    })
  }

  async failRun(
    runId: string,
    owner: string,
    error: string,
    options: { retryDelayMs: number; deadLetter: boolean },
    failedAt = new Date(),
  ): Promise<AutomationRunRecord> {
    return this.transact(state => {
      const run = requireOwnedRunning(state, runId, owner)
      const at = failedAt.toISOString()
      run.status = options.deadLetter ? 'dead_letter' : 'failed'
      run.error = error
      run.completedAt = at
      run.updatedAt = at
      if (!options.deadLetter)
        run.retryNotBefore = new Date(failedAt.getTime() + options.retryDelayMs).toISOString()
      else delete run.retryNotBefore
      delete run.leaseOwner
      delete run.leaseExpiresAt
      if (options.deadLetter && run.permanentDedupe)
        addTerminalReceipt(state, run, 'dead_letter', at)
      return structuredClone(run)
    })
  }

  async removeTerminalReceipt(
    kind: 'schedule' | 'pipeline',
    definitionId: string,
    triggerKey: string,
  ): Promise<void> {
    await this.mutate(state => {
      const index = state.terminalReceipts.findIndex(
        item =>
          item.kind === kind &&
          item.definitionId === definitionId &&
          item.triggerKey === triggerKey,
      )
      if (index >= 0) state.terminalReceipts.splice(index, 1)
    })
  }

  async transact<T>(operation: (state: WorkflowState) => T): Promise<T> {
    await this.ensureLoaded()
    let result: T | undefined
    const next = this.mutationTail.then(() =>
      withGenerationFileLock(this.filePath, async () => {
        const draft = await this.readCurrent()
        this.pruneTerminalReceipts(draft, new Date())
        result = operation(draft)
        this.pruneTerminalReceipts(draft, new Date())
        await this.persist(draft)
        this.state = draft
      }),
    )
    this.mutationTail = next.catch(() => undefined)
    await next
    return result as T
  }
  private async mutate(operation: (state: WorkflowState) => void): Promise<void> {
    await this.transact(state => {
      operation(state)
    })
  }

  private claimRunInState(state: WorkflowState, input: RunClaimInput): RunClaimResult {
    const now = input.now ?? new Date()
    const nowIso = now.toISOString()
    const nowMs = now.getTime()
    if (input.permanentDedupe) {
      const receipt = state.terminalReceipts.find(
        item =>
          item.kind === input.kind &&
          item.definitionId === input.definitionId &&
          item.triggerKey === input.triggerKey,
      )
      if (receipt)
        return receipt.status === 'completed'
          ? { kind: 'completed', receipt: structuredClone(receipt) }
          : { kind: 'dead_letter', receipt: structuredClone(receipt) }
    }
    const matches = state.runs.filter(
      run =>
        run.kind === input.kind &&
        run.definitionId === input.definitionId &&
        run.triggerKey === input.triggerKey,
    )
    const completed = matches.findLast(run => run.status === 'completed')
    if (completed) return { kind: 'completed', run: structuredClone(completed) }
    let latest = matches.at(-1)
    if (latest?.status === 'dead_letter')
      return { kind: 'dead_letter', run: structuredClone(latest) }
    if (latest?.status === 'running') {
      const expiry = Date.parse(latest.leaseExpiresAt ?? '')
      if (Number.isFinite(expiry) && expiry > nowMs)
        return { kind: 'busy', run: structuredClone(latest) }
      latest.status = 'failed'
      latest.completedAt = nowIso
      latest.updatedAt = nowIso
      latest.error = 'worker lease expired before completion'
      latest.retryNotBefore = nowIso
      delete latest.leaseOwner
      delete latest.leaseExpiresAt
    }
    if (latest?.status === 'failed') {
      const retryAt = Date.parse(latest.retryNotBefore ?? '')
      if (Number.isFinite(retryAt) && retryAt > nowMs)
        return { kind: 'busy', run: structuredClone(latest) }
    }
    const nextAttempt = (latest?.attempt ?? 0) + 1
    if (nextAttempt > input.maxAttempts) {
      if (!latest) throw new Error('claim attempt overflow without prior run')
      latest.status = 'dead_letter'
      latest.updatedAt = nowIso
      latest.completedAt ??= nowIso
      latest.error ??= `maximum attempts exceeded (${input.maxAttempts})`
      delete latest.leaseOwner
      delete latest.leaseExpiresAt
      if (input.permanentDedupe) addTerminalReceipt(state, latest, 'dead_letter', nowIso)
      return { kind: 'dead_letter', run: structuredClone(latest) }
    }
    const run: AutomationRunRecord = {
      id: randomUUID(),
      kind: input.kind,
      definitionId: input.definitionId,
      triggerKey: input.triggerKey,
      status: 'running',
      attempt: nextAttempt,
      startedAt: nowIso,
      updatedAt: nowIso,
      leaseOwner: input.owner,
      leaseExpiresAt: new Date(nowMs + input.leaseDurationMs).toISOString(),
      lastHeartbeatAt: nowIso,
      ...(input.permanentDedupe ? { permanentDedupe: true } : {}),
      ...(latest?.nodeResults?.length
        ? { nodeResults: structuredClone(latest.nodeResults) }
        : input.kind === 'pipeline'
          ? { nodeResults: [] }
          : {}),
    }
    state.runs.push(run)
    this.pruneRuns(state)
    return { kind: 'claimed', run: structuredClone(run) }
  }

  private pruneRuns(state: WorkflowState): void {
    let removeCount = state.runs.length - this.maxRunHistory
    if (removeCount <= 0) return
    const protectedIds = new Set<string>()
    const seenTriggers = new Set<string>()
    for (let index = state.runs.length - 1; index >= 0; index -= 1) {
      const run = state.runs[index]!
      if (run.status === 'running') protectedIds.add(run.id)
      const triggerIdentity = `${run.kind}\u0000${run.definitionId}\u0000${run.triggerKey}`
      if (seenTriggers.has(triggerIdentity)) continue
      seenTriggers.add(triggerIdentity)
      if (
        run.status === 'failed' &&
        !run.triggerKey.startsWith('manual:') &&
        isRecoverableFailure(state, run)
      )
        protectedIds.add(run.id)
    }
    const kept: AutomationRunRecord[] = []
    for (const run of state.runs) {
      if (removeCount > 0 && !protectedIds.has(run.id)) {
        removeCount -= 1
        continue
      }
      kept.push(run)
    }
    state.runs = kept
  }

  private pruneTerminalReceipts(state: WorkflowState, now: Date): void {
    const cutoff = now.getTime() - this.terminalReceiptRetentionMs
    state.terminalReceipts = state.terminalReceipts.filter(
      receipt =>
        isProtectedScheduleReceipt(state, receipt) || Date.parse(receipt.recordedAt) >= cutoff,
    )
    let removeCount = state.terminalReceipts.length - this.maxTerminalReceipts
    if (removeCount <= 0) return
    const kept: AutomationTerminalReceipt[] = []
    for (const receipt of state.terminalReceipts) {
      if (removeCount > 0 && !isProtectedScheduleReceipt(state, receipt)) {
        removeCount -= 1
        continue
      }
      kept.push(receipt)
    }
    state.terminalReceipts = kept
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.load().finally(() => {
      this.loadPromise = undefined
    })
    return this.loadPromise
  }
  private async load(): Promise<void> {
    await withGenerationFileLock(this.filePath, async () => {
      await this.migrateLegacyIfNeeded()
      const current = await readWorkflowFile(this.filePath)
      if (current) {
        if (current.version === 1) {
          current.version = 2
          await this.persist(current)
        }
        this.state = current
      } else {
        await this.persist(EMPTY_STATE)
        this.state = structuredClone(EMPTY_STATE)
      }
    })
    this.loaded = true
  }

  private async migrateLegacyIfNeeded(): Promise<void> {
    const targetPath = path.resolve(this.filePath)
    const sources = [...new Set(this.legacyFilePaths.map(value => path.resolve(value)))]
      .filter(value => value !== targetPath)
      .sort()
    if (sources.length === 0) return
    const guards = await acquireLegacyDaemonGuards(sources)
    try {
      await withFileLocks(sources, async () => {
        const entries = (
          await Promise.all(
            sources.map(async sourcePath => ({
              sourcePath,
              state: await readWorkflowFile(sourcePath),
            })),
          )
        ).filter(entry => entry.state !== undefined) as Array<{
          sourcePath: string
          state: WorkflowState
        }>
        if (entries.length === 0) return
        const nonEmpty = entries.filter(entry => !isEmptyState(entry.state))
        const representative = nonEmpty[0]
        if (
          representative &&
          nonEmpty.some(entry => !equivalentState(entry.state, representative.state))
        ) {
          throw new Error(
            `workflow storage migration conflict: multiple legacy databases contain different non-empty orchestration state: ${nonEmpty.map(entry => entry.sourcePath).join(', ')}; run an explicit offline migration and choose/merge the desired state`,
          )
        }

        const target = await readWorkflowFile(targetPath)
        if (representative) {
          if (target && !isEmptyState(target) && !equivalentState(target, representative.state)) {
            throw new Error(
              `workflow storage migration conflict: new storage ${targetPath} differs from legacy storage ${representative.sourcePath}; run an explicit offline migration before startup`,
            )
          }
          if (!target || isEmptyState(target)) await this.persist(representative.state)
        }
        for (const entry of entries) await archiveLegacyFile(entry.sourcePath)
      })
    } finally {
      for (const guard of guards.reverse()) await guard.release().catch(() => undefined)
    }
  }

  private async readCurrent(): Promise<WorkflowState> {
    const current = (await readWorkflowFile(this.filePath)) ?? structuredClone(EMPTY_STATE)
    if (current.version !== 2) {
      throw new Error(
        'workflow state regressed to version 1 after startup; an older Flowit worker may still be active',
      )
    }
    return current
  }
  private async persist(state: WorkflowState): Promise<void> {
    await durableReplaceText(this.filePath, `${JSON.stringify(state, null, 2)}\n`)
  }
}

function isRecoverableFailure(state: WorkflowState, run: AutomationRunRecord): boolean {
  if (run.kind === 'pipeline')
    return state.pipelines.some(item => item.id === run.definitionId && item.status === 'active')
  const schedule = state.schedules.find(item => item.id === run.definitionId)
  if (!schedule || schedule.status !== 'active' || !schedule.nextRunAt) return false
  return run.triggerKey === `schedule:${run.definitionId}:${schedule.nextRunAt}`
}
function isProtectedScheduleReceipt(
  state: WorkflowState,
  receipt: AutomationTerminalReceipt,
): boolean {
  if (receipt.kind !== 'schedule') return false
  const schedule = state.schedules.find(item => item.id === receipt.definitionId)
  return Boolean(
    schedule?.status === 'active' &&
      schedule.nextRunAt &&
      receipt.triggerKey === `schedule:${receipt.definitionId}:${schedule.nextRunAt}`,
  )
}
function requireOwnedRunning(
  state: WorkflowState,
  runId: string,
  owner: string,
): AutomationRunRecord {
  const run = state.runs.find(item => item.id === runId)
  if (!run || run.status !== 'running' || run.leaseOwner !== owner)
    throw new Error(`automation run ${runId} is not owned by worker ${owner}`)
  return run
}
function addTerminalReceipt(
  state: WorkflowState,
  run: AutomationRunRecord,
  status: 'completed' | 'dead_letter',
  recordedAt: string,
): void {
  const existing = state.terminalReceipts.find(
    item =>
      item.kind === run.kind &&
      item.definitionId === run.definitionId &&
      item.triggerKey === run.triggerKey,
  )
  if (existing) {
    existing.status = status
    existing.recordedAt = recordedAt
    return
  }
  state.terminalReceipts.push({
    kind: run.kind,
    definitionId: run.definitionId,
    triggerKey: run.triggerKey,
    status,
    recordedAt,
  })
}

interface LegacyDaemonGuard {
  release(): Promise<void>
}
async function acquireLegacyDaemonGuards(
  sourcePaths: readonly string[],
): Promise<LegacyDaemonGuard[]> {
  const pidFiles = [
    ...new Set(sourcePaths.map(sourcePath => path.join(path.dirname(sourcePath), 'daemon.pid'))),
  ].sort()
  const guards: LegacyDaemonGuard[] = []
  try {
    for (const pidFile of pidFiles) guards.push(await acquireLegacyDaemonGuard(pidFile))
    return guards
  } catch (error) {
    for (const guard of guards.reverse()) await guard.release().catch(() => undefined)
    throw error
  }
}

async function acquireLegacyDaemonGuard(pidFile: string): Promise<LegacyDaemonGuard> {
  await mkdir(path.dirname(pidFile), { recursive: true })
  const deadline = Date.now() + LEGACY_PID_GUARD_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const handle = await open(pidFile, 'wx')
      await handle.writeFile(`${process.pid}\n`, 'utf8')
      await handle.sync()
      return {
        async release(): Promise<void> {
          await handle.close().catch(() => undefined)
          const current = await readFile(pidFile, 'utf8').catch(() => '')
          if (current.trim() === String(process.pid)) await rm(pidFile, { force: true })
        },
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const raw = await readFile(pidFile, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    const pid = Number(raw.trim())
    if (Number.isSafeInteger(pid) && pid > 0) {
      if (isProcessAlive(pid))
        throw new Error(
          `legacy Flowit Workflow daemon is still running with pid ${pid} for ${pidFile}; stop the v0.3 daemon before migration`,
        )
      await rm(pidFile, { force: true })
      continue
    }
    const age = await stat(pidFile)
      .then(value => Date.now() - value.mtimeMs)
      .catch(() => Number.POSITIVE_INFINITY)
    if (age < LEGACY_PID_INITIALIZATION_GRACE_MS) {
      await sleep(25)
      continue
    }
    throw new Error(
      `legacy daemon pid file ${pidFile} is occupied but does not contain a valid PID; migration will not remove it because a v0.3 daemon may still be initializing. Stop the old daemon or remove the stale pid file explicitly after verifying no process owns it.`,
    )
  }
  throw new Error(`timed out acquiring legacy daemon migration guard: ${pidFile}`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function readWorkflowFile(filePath: string): Promise<WorkflowState | undefined> {
  try {
    return normalizeState(JSON.parse(await readFile(filePath, 'utf8')) as WorkflowState)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function normalizeState(parsed: WorkflowState): WorkflowState {
  if (
    (parsed.version !== 1 && parsed.version !== 2) ||
    !Array.isArray(parsed.schedules) ||
    !Array.isArray(parsed.pipelines) ||
    !Array.isArray(parsed.runs)
  )
    throw new Error('unsupported Flowit Workflow state')
  parsed.eventInbox = Array.isArray(parsed.eventInbox) ? parsed.eventInbox : []
  parsed.terminalReceipts = Array.isArray(parsed.terminalReceipts) ? parsed.terminalReceipts : []
  parsed.provisioningIntents = Array.isArray(parsed.provisioningIntents)
    ? parsed.provisioningIntents
    : []
  parsed.runs = parsed.runs.map(run => ({
    ...run,
    attempt: run.attempt ?? 1,
    updatedAt: run.updatedAt ?? run.completedAt ?? run.startedAt,
  }))
  const receiptKeys = new Set(
    parsed.terminalReceipts.map(
      receipt => `${receipt.kind}\u0000${receipt.definitionId}\u0000${receipt.triggerKey}`,
    ),
  )
  for (const run of parsed.runs) {
    const automatic = run.kind === 'schedule' || !run.triggerKey.startsWith('manual:')
    if (!automatic) continue
    run.permanentDedupe ??= true
    if (run.status !== 'completed' && run.status !== 'dead_letter') continue
    const key = `${run.kind}\u0000${run.definitionId}\u0000${run.triggerKey}`
    if (receiptKeys.has(key)) continue
    parsed.terminalReceipts.push({
      kind: run.kind,
      definitionId: run.definitionId,
      triggerKey: run.triggerKey,
      status: run.status,
      recordedAt: run.completedAt ?? run.updatedAt ?? run.startedAt,
    })
    receiptKeys.add(key)
  }
  return parsed
}
function isEmptyState(state: WorkflowState): boolean {
  return (
    state.schedules.length === 0 &&
    state.pipelines.length === 0 &&
    state.eventInbox.length === 0 &&
    state.runs.length === 0 &&
    state.terminalReceipts.length === 0 &&
    state.provisioningIntents.length === 0
  )
}
function equivalentState(a: WorkflowState, b: WorkflowState): boolean {
  const left = structuredClone(a)
  const right = structuredClone(b)
  left.version = 2
  right.version = 2
  left.provisioningIntents ??= []
  right.provisioningIntents ??= []
  return isDeepStrictEqual(left, right)
}
async function archiveLegacyFile(sourcePath: string): Promise<void> {
  const archived = `${sourcePath}.migrated-v0.4-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    await rename(sourcePath, archived)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function withFileLocks<T>(
  filePaths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const paths = [...new Set(filePaths.map(value => path.resolve(value)))].sort()
  const enter = async (index: number): Promise<T> =>
    index >= paths.length
      ? operation()
      : withGenerationFileLock(paths[index]!, () => enter(index + 1))
  return enter(0)
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}
