import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { predecessorIds, topologicalOrder } from './domain.js'
import type {
  AutomationRunNodeResult,
  AutomationRunRecord,
  AutomationTerminalReceipt,
  RunOncePipelineSnapshot,
  SessionContextRef,
  WorkflowState,
} from './types.js'
import { AgentAdapterRegistry } from './adapter.js'
import { ContextGraph } from './context-graph.js'
import { OrchestrationDispatcher } from './dispatcher.js'
import { startLeaseHeartbeat } from './lease.js'
import { JsonWorkflowStore } from './store.js'

const DEFAULT_RECONCILE_MS = 1_000
const DISPOSE_QUEUE_GRACE_MS = 3_000

export interface RunOncePipelineRuntimeOptions {
  readonly workerId: string
  readonly leaseDurationMs: number
  readonly retryDelayMs: number
  readonly maxAttempts: number
}

export interface AdmitRunOncePipelineInput {
  readonly definitionId: string
  readonly triggerKey: string
  readonly snapshot: RunOncePipelineSnapshot
  readonly now?: Date
}

export interface RunOncePipelineAdmission {
  readonly definitionId: string
  readonly triggerKey: string
  readonly runId?: string
  readonly status: 'accepted' | 'running' | 'completed' | 'dead-letter'
  readonly attempt?: number
  readonly created: boolean
  readonly error?: string
}

export interface RunOncePipelineStatus {
  readonly runId: string
  readonly definitionId: string
  readonly triggerKey: string
  readonly status: 'running' | 'retrying' | 'completed' | 'dead-letter'
  readonly attempt: number
  readonly startedAt: string
  readonly updatedAt: string
  readonly completedAt?: string
  readonly retryNotBefore?: string
  readonly leaseExpiresAt?: string
  readonly error?: string
  readonly nodeResults: readonly AutomationRunNodeResult[]
}

type ClaimOutcome =
  | { kind: 'claimed'; run: AutomationRunRecord; created: boolean }
  | { kind: 'busy'; run: AutomationRunRecord }
  | { kind: 'completed'; run?: AutomationRunRecord; receipt?: AutomationTerminalReceipt }
  | { kind: 'dead-letter'; run?: AutomationRunRecord; receipt?: AutomationTerminalReceipt }

export class RunOncePipelineRuntime {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly disposeController = new AbortController()
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly store: JsonWorkflowStore,
    private readonly dispatcher: OrchestrationDispatcher,
    private readonly contextGraph: ContextGraph,
    private readonly options: RunOncePipelineRuntimeOptions,
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('run-once Pipeline runtime is disposed')
    this.reconcileTimer = setInterval(
      () => void this.reconcileRecoverable().catch(() => undefined),
      DEFAULT_RECONCILE_MS,
    )
    await this.reconcileRecoverable(signal)
  }

  async admit(
    input: AdmitRunOncePipelineInput,
    signal?: AbortSignal,
  ): Promise<RunOncePipelineAdmission> {
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('run-once Pipeline runtime is disposed')
    const normalized = normalizeInput(input)
    const outcome = await this.claim(normalized)
    if (outcome.kind === 'claimed') {
      return admission(normalized, outcome.run, 'accepted', outcome.created)
    }
    if (outcome.kind === 'busy') {
      return admission(normalized, outcome.run, 'running', false)
    }
    const run = outcome.run
    const error = run?.error
    return {
      definitionId: normalized.definitionId,
      triggerKey: normalized.triggerKey,
      ...(run ? { runId: run.id, attempt: run.attempt } : {}),
      status: outcome.kind === 'completed' ? 'completed' : 'dead-letter',
      created: false,
      ...(error ? { error } : {}),
    }
  }

  async startRunOnce(
    input: AdmitRunOncePipelineInput,
    signal?: AbortSignal,
  ): Promise<RunOncePipelineAdmission> {
    const normalized = normalizeInput(input)
    const accepted = await this.admit(normalized, signal)
    if (accepted.status === 'accepted') {
      const state = await this.store.snapshot()
      const run = accepted.runId
        ? state.runs.find(candidate => candidate.id === accepted.runId)
        : undefined
      if (!run?.pipelineSnapshot) {
        throw new Error('accepted run-once Pipeline lost its executable snapshot')
      }
      this.enqueue(run)
    }
    return accepted
  }

  async getRun(runId: string): Promise<RunOncePipelineStatus | undefined> {
    const normalized = requiredString(runId, 'runId')
    const run = (await this.store.snapshot()).runs.find(candidate => candidate.id === normalized)
    return run?.pipelineSnapshot ? statusOf(run) : undefined
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.disposeController.abort(new Error('run-once Pipeline runtime disposed'))
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = undefined
    await settleAllWithin([...new Set(this.queues.values())], DISPOSE_QUEUE_GRACE_MS)
    this.queues.clear()
  }

  private async reconcileRecoverable(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return
    signal?.throwIfAborted()
    const state = await this.store.snapshot()
    const now = Date.now()
    const latest = new Map<string, AutomationRunRecord>()
    for (const run of state.runs) {
      if (!run.pipelineSnapshot) continue
      latest.set(identity(run.definitionId, run.triggerKey), run)
    }
    for (const run of latest.values()) {
      if (run.status === 'completed' || run.status === 'dead_letter') continue
      if (run.status === 'running') {
        const boundary = Date.parse(run.leaseExpiresAt ?? '')
        if (Number.isFinite(boundary) && boundary > now) continue
      }
      if (run.status === 'failed') {
        const retryAt = Date.parse(run.retryNotBefore ?? '')
        if (Number.isFinite(retryAt) && retryAt > now) continue
      }
      const outcome = await this.claim({
        definitionId: run.definitionId,
        triggerKey: run.triggerKey,
        snapshot: run.pipelineSnapshot,
      })
      if (outcome.kind === 'claimed') this.enqueue(outcome.run)
    }
  }

  private enqueue(run: AutomationRunRecord): void {
    if (this.disposed || !run.pipelineSnapshot) return
    const key = identity(run.definitionId, run.triggerKey)
    if (this.queues.has(key)) return
    const work = this.execute(run).finally(() => {
      if (this.queues.get(key) === work) this.queues.delete(key)
    })
    this.queues.set(key, work)
    void work.catch(() => undefined)
  }

  private async claim(input: Required<Pick<AdmitRunOncePipelineInput, 'definitionId' | 'triggerKey' | 'snapshot'>> & { now?: Date }): Promise<ClaimOutcome> {
    const now = input.now ?? new Date()
    const outcome = await this.store.transact(state =>
      claimInState(state, input, now, this.options),
    )
    if (outcome.kind === 'claimed') {
      await this.store.putRun(outcome.run)
    }
    return outcome
  }

  private async execute(initial: AutomationRunRecord): Promise<void> {
    if (!initial.pipelineSnapshot || this.disposed) return
    let running = initial
    const snapshot = initial.pipelineSnapshot
    const heartbeat = startLeaseHeartbeat(
      this.store,
      running.id,
      this.options.workerId,
      this.options.leaseDurationMs,
    )
    const signal = AbortSignal.any([heartbeat.signal, this.disposeController.signal])
    try {
      signal.throwIfAborted()
      const order = topologicalOrder(snapshot.nodes, snapshot.edges)
      const nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
      const completed = new Set((running.nodeResults ?? []).map(result => result.nodeId))
      for (const nodeId of order) {
        if (completed.has(nodeId)) continue
        signal.throwIfAborted()
        const node = nodes.get(nodeId)
        if (!node) throw new Error(`run-once Pipeline node ${nodeId} disappeared`)
        const upstreamRefs: SessionContextRef[] = []
        if (node.inheritUpstreamContext) {
          upstreamRefs.push(
            ...this.contextGraph.inheritedFromResults(
              running.nodeResults ?? [],
              predecessorIds(nodeId, snapshot.edges),
            ),
          )
        }
        const result = await this.dispatcher.dispatchWithCorrelation(
          { ...node.target },
          upstreamRefs,
          `run-once:${running.definitionId}:${running.triggerKey}:${nodeId}`,
          running.attempt,
          signal,
        )
        signal.throwIfAborted()
        const checkpoint: AutomationRunNodeResult = {
          nodeId,
          adapterId: result.adapterId,
          sessionId: result.sessionId,
          loadedSkills: result.loadedSkills,
          referencedSessions: result.referencedSessions,
          ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}),
        }
        running = await this.store.checkpointRun(
          running.id,
          this.options.workerId,
          checkpoint,
          this.options.leaseDurationMs,
        )
      }
      await this.store.completeRun(running.id, this.options.workerId)
    } catch (error: unknown) {
      heartbeat.stop()
      if (this.disposeController.signal.aborted || heartbeat.signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (running.attempt >= this.options.maxAttempts) {
        await this.store.failRun(
          running.id,
          this.options.workerId,
          message,
          { retryDelayMs: this.options.retryDelayMs, deadLetter: true },
        )
      } else {
        await deferRetry(
          this.store,
          running.id,
          this.options.workerId,
          message,
          this.options.retryDelayMs,
        )
      }
      throw error
    } finally {
      heartbeat.stop()
    }
  }
}

function claimInState(
  state: WorkflowState,
  input: Required<Pick<AdmitRunOncePipelineInput, 'definitionId' | 'triggerKey' | 'snapshot'>>,
  now: Date,
  options: RunOncePipelineRuntimeOptions,
): ClaimOutcome {
  const receipt = state.terminalReceipts.find(candidate =>
    candidate.kind === 'pipeline' &&
    candidate.definitionId === input.definitionId &&
    candidate.triggerKey === input.triggerKey,
  )
  const matches = state.runs.filter(candidate =>
    candidate.kind === 'pipeline' &&
    candidate.definitionId === input.definitionId &&
    candidate.triggerKey === input.triggerKey,
  )
  const latest = matches.at(-1)
  if (receipt) {
    return receipt.status === 'completed'
      ? { kind: 'completed', ...(latest ? { run: structuredClone(latest) } : {}), receipt: structuredClone(receipt) }
      : { kind: 'dead-letter', ...(latest ? { run: structuredClone(latest) } : {}), receipt: structuredClone(receipt) }
  }
  if (latest?.status === 'completed') return { kind: 'completed', run: structuredClone(latest) }
  if (latest?.status === 'dead_letter') return { kind: 'dead-letter', run: structuredClone(latest) }
  if (latest?.pipelineSnapshot && !isDeepStrictEqual(latest.pipelineSnapshot, input.snapshot)) {
    throw new Error('run-once Pipeline identity is already bound to a different executable snapshot')
  }

  const nowIso = now.toISOString()
  const nowMs = now.getTime()
  if (latest?.status === 'running') {
    const boundary = Date.parse(latest.leaseExpiresAt ?? '')
    if (Number.isFinite(boundary) && boundary > nowMs) {
      return { kind: 'busy', run: structuredClone(latest) }
    }
  }
  if (latest?.status === 'failed') {
    const retryAt = Date.parse(latest.retryNotBefore ?? '')
    if (Number.isFinite(retryAt) && retryAt > nowMs) {
      return { kind: 'busy', run: structuredClone(latest) }
    }
  }

  const nextAttempt = (latest?.attempt ?? 0) + 1
  if (nextAttempt > options.maxAttempts) {
    if (!latest) throw new Error('run-once Pipeline attempt overflow without a prior run')
    latest.status = 'dead_letter'
    latest.updatedAt = nowIso
    latest.completedAt ??= nowIso
    latest.error ??= `maximum attempts exceeded (${options.maxAttempts})`
    delete latest.leaseOwner
    delete latest.leaseExpiresAt
    addTerminalReceipt(state, latest, 'dead_letter', nowIso)
    return { kind: 'dead-letter', run: structuredClone(latest) }
  }

  if (latest) {
    latest.status = 'running'
    latest.attempt = nextAttempt
    latest.updatedAt = nowIso
    latest.leaseOwner = options.workerId
    latest.leaseExpiresAt = new Date(nowMs + options.leaseDurationMs).toISOString()
    latest.lastHeartbeatAt = nowIso
    latest.pipelineSnapshot = structuredClone(input.snapshot)
    latest.permanentDedupe = true
    latest.nodeResults ??= []
    delete latest.completedAt
    delete latest.error
    delete latest.retryNotBefore
    return { kind: 'claimed', run: structuredClone(latest), created: false }
  }

  const run: AutomationRunRecord = {
    id: randomUUID(),
    kind: 'pipeline',
    definitionId: input.definitionId,
    triggerKey: input.triggerKey,
    status: 'running',
    attempt: 1,
    startedAt: nowIso,
    updatedAt: nowIso,
    leaseOwner: options.workerId,
    leaseExpiresAt: new Date(nowMs + options.leaseDurationMs).toISOString(),
    lastHeartbeatAt: nowIso,
    permanentDedupe: true,
    nodeResults: [],
    pipelineSnapshot: structuredClone(input.snapshot),
  }
  state.runs.push(run)
  return { kind: 'claimed', run: structuredClone(run), created: true }
}

async function deferRetry(
  store: JsonWorkflowStore,
  runId: string,
  owner: string,
  error: string,
  retryDelayMs: number,
  now = new Date(),
): Promise<void> {
  await store.transact(state => {
    const run = state.runs.find(candidate => candidate.id === runId)
    if (!run || run.status !== 'running' || run.leaseOwner !== owner) {
      throw new Error(`run-once Pipeline ${runId} is no longer owned by ${owner}`)
    }
    const nowIso = now.toISOString()
    const retryAt = new Date(now.getTime() + retryDelayMs).toISOString()
    run.error = error
    run.retryNotBefore = retryAt
    run.updatedAt = nowIso
    run.lastHeartbeatAt = nowIso
    run.leaseOwner = `retry:${run.id}`
    run.leaseExpiresAt = retryAt
  })
}

function addTerminalReceipt(
  state: WorkflowState,
  run: AutomationRunRecord,
  status: 'completed' | 'dead_letter',
  recordedAt: string,
): void {
  const existing = state.terminalReceipts.find(candidate =>
    candidate.kind === 'pipeline' &&
    candidate.definitionId === run.definitionId &&
    candidate.triggerKey === run.triggerKey,
  )
  if (existing) {
    existing.status = status
    existing.recordedAt = recordedAt
    return
  }
  state.terminalReceipts.push({
    kind: 'pipeline',
    definitionId: run.definitionId,
    triggerKey: run.triggerKey,
    status,
    recordedAt,
  })
}

function normalizeInput(input: AdmitRunOncePipelineInput): Required<Pick<AdmitRunOncePipelineInput, 'definitionId' | 'triggerKey' | 'snapshot'>> & { now?: Date } {
  const definitionId = requiredString(input.definitionId, 'definitionId')
  const triggerKey = requiredString(input.triggerKey, 'triggerKey')
  if (triggerKey.startsWith('manual:')) {
    throw new Error('run-once Pipeline triggerKey must be stable and must not use the manual: namespace')
  }
  const snapshot = validateSnapshot(input.snapshot)
  return {
    definitionId,
    triggerKey,
    snapshot,
    ...(input.now ? { now: input.now } : {}),
  }
}

function validateSnapshot(value: RunOncePipelineSnapshot): RunOncePipelineSnapshot {
  if (!value || value.version !== 1) throw new Error('run-once Pipeline snapshot must be version 1')
  const name = requiredString(value.name, 'snapshot.name')
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    throw new Error('run-once Pipeline snapshot requires at least one node')
  }
  if (!Array.isArray(value.edges)) throw new Error('run-once Pipeline snapshot edges must be an array')
  topologicalOrder(value.nodes, value.edges)
  return { version: 1, name, nodes: structuredClone(value.nodes), edges: structuredClone(value.edges) }
}

function admission(
  input: Required<Pick<AdmitRunOncePipelineInput, 'definitionId' | 'triggerKey' | 'snapshot'>>,
  run: AutomationRunRecord,
  status: 'accepted' | 'running',
  created: boolean,
): RunOncePipelineAdmission {
  return {
    definitionId: input.definitionId,
    triggerKey: input.triggerKey,
    runId: run.id,
    status,
    attempt: run.attempt,
    created,
    ...(run.error ? { error: run.error } : {}),
  }
}

function statusOf(run: AutomationRunRecord): RunOncePipelineStatus {
  const retryAt = Date.parse(run.retryNotBefore ?? '')
  const status = run.status === 'completed'
    ? 'completed' as const
    : run.status === 'dead_letter'
      ? 'dead-letter' as const
      : Number.isFinite(retryAt) && retryAt > Date.now()
        ? 'retrying' as const
        : 'running' as const
  return {
    runId: run.id,
    definitionId: run.definitionId,
    triggerKey: run.triggerKey,
    status,
    attempt: run.attempt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.retryNotBefore ? { retryNotBefore: run.retryNotBefore } : {}),
    ...(run.leaseExpiresAt ? { leaseExpiresAt: run.leaseExpiresAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    nodeResults: structuredClone(run.nodeResults ?? []),
  }
}

function identity(definitionId: string, triggerKey: string): string {
  return `${definitionId}\u0000${triggerKey}`
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

async function settleAllWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return
  await Promise.race([
    Promise.allSettled(promises).then(() => undefined),
    new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    }),
  ])
}
