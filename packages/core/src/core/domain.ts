import type {
  AdapterId,
  AutomationTarget,
  CalendarDayOfWeek,
  CreatePipelineInput,
  CreateScheduleInput,
  PipelineDefinition,
  PipelineEdge,
  PipelineNode,
  PipelineTrigger,
  ScheduledTask,
  ScheduleTiming,
  SessionContextRef,
} from './types.js'
import { nonEmpty, normalizeStringList } from './utils.js'

export { nonEmpty, normalizeStringList } from './utils.js'

export function adapterIdOf(value: { adapterId?: AdapterId }, defaultAdapterId: AdapterId): AdapterId {
  return nonEmpty(value.adapterId ?? defaultAdapterId, 'adapterId')
}

export function sessionKey(adapterId: AdapterId, sessionId: string): string {
  return `${adapterId}\u0000${sessionId}`
}

export function normalizeContextRefs(refs: readonly SessionContextRef[] | undefined, defaultAdapterId: AdapterId): SessionContextRef[] {
  const seen = new Set<string>()
  const result: SessionContextRef[] = []
  for (const ref of refs ?? []) {
    const adapterId = adapterIdOf(ref, defaultAdapterId)
    const sessionId = nonEmpty(ref.sessionId, 'contextRefs.sessionId')
    const key = sessionKey(adapterId, sessionId)
    if (seen.has(key)) continue
    seen.add(key)
    const label = ref.label?.trim()
    result.push(label ? { adapterId, sessionId, label } : { adapterId, sessionId })
  }
  return result
}

export function normalizeTarget(target: AutomationTarget, defaultAdapterId: AdapterId): AutomationTarget {
  const adapterId = adapterIdOf(target, defaultAdapterId)
  return { adapterId, sessionId: nonEmpty(target.sessionId, 'target.sessionId'), prompt: nonEmpty(target.prompt, 'target.prompt'), skills: normalizeStringList(target.skills), contextRefs: normalizeContextRefs(target.contextRefs, defaultAdapterId) }
}

export function createScheduleRecord(id: string, input: CreateScheduleInput, now: Date, minimumIntervalSeconds: number, defaultAdapterId: AdapterId): ScheduledTask {
  const createdAt = now.toISOString()
  const timing = normalizeScheduleTiming(input.timing, now, minimumIntervalSeconds)
  const nextRunAt = nextScheduleOccurrence(timing, now)
  const base = {
    id,
    name: nonEmpty(input.name, 'name'),
    timing,
    status: 'active' as const,
    nextRunAt,
    createdAt,
    updatedAt: createdAt,
  }
  if (typeof input.pipelineId === 'string') {
    return { ...base, pipelineId: nonEmpty(input.pipelineId, 'pipelineId') }
  }
  return { ...base, target: normalizeTarget(input.target, defaultAdapterId) }
}

export function advanceSchedule(task: ScheduledTask, firedAt: Date, oneShotOutcome: 'completed' | 'failed' = 'completed'): ScheduledTask {
  const now = firedAt.toISOString()
  if (task.timing.kind === 'at') {
    const { nextRunAt: _nextRunAt, ...rest } = task
    return { ...rest, status: oneShotOutcome, lastRunAt: now, updatedAt: now }
  }
  const nextRunAt = nextScheduleOccurrence(task.timing, firedAt, task.nextRunAt)
  return { ...task, lastRunAt: now, nextRunAt, updatedAt: now }
}

export function nextCalendarOccurrence(
  timing: Extract<ScheduleTiming, { kind: 'calendar' }>,
  after: Date,
): string {
  const base = zonedParts(after, timing.timeZone)
  const allowed = timing.daysOfWeek ? new Set(timing.daysOfWeek) : undefined
  for (let offset = 0; offset <= 370; offset += 1) {
    const date = new Date(Date.UTC(base.year, base.month - 1, base.day + offset))
    const dayOfWeek = date.getUTCDay() as CalendarDayOfWeek
    if (allowed && !allowed.has(dayOfWeek)) continue
    const candidate = localDateTimeToInstant(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      timing.hour,
      timing.minute,
      timing.timeZone,
    )
    if (candidate && candidate.getTime() > after.getTime()) return candidate.toISOString()
  }
  throw new Error(`calendar schedule could not resolve a future occurrence in ${timing.timeZone}`)
}

function normalizeScheduleTiming(
  timing: ScheduleTiming,
  now: Date,
  minimumIntervalSeconds: number,
): ScheduleTiming {
  if (timing.kind === 'at') {
    const at = Date.parse(timing.at)
    if (!Number.isFinite(at)) throw new Error('at must be a valid ISO timestamp')
    if (at <= now.getTime()) throw new Error('at must be in the future')
    return { kind: 'at', at: new Date(timing.at).toISOString() }
  }
  if (timing.kind === 'every') {
    if (!Number.isSafeInteger(timing.everySeconds) || timing.everySeconds < minimumIntervalSeconds) {
      throw new Error(`everySeconds must be an integer >= ${minimumIntervalSeconds}`)
    }
    return { kind: 'every', everySeconds: timing.everySeconds }
  }
  const timeZone = nonEmpty(timing.timeZone, 'timeZone')
  assertTimeZone(timeZone)
  if (!Number.isSafeInteger(timing.hour) || timing.hour < 0 || timing.hour > 23) {
    throw new Error('calendar hour must be an integer between 0 and 23')
  }
  if (!Number.isSafeInteger(timing.minute) || timing.minute < 0 || timing.minute > 59) {
    throw new Error('calendar minute must be an integer between 0 and 59')
  }
  const days = timing.daysOfWeek === undefined
    ? undefined
    : [...new Set(timing.daysOfWeek)].sort((left, right) => left - right)
  if (days?.length === 0 || days?.some(day => !Number.isSafeInteger(day) || day < 0 || day > 6)) {
    throw new Error('calendar daysOfWeek must contain one or more integers from 0 (Sunday) through 6 (Saturday)')
  }
  return {
    kind: 'calendar',
    timeZone,
    hour: timing.hour,
    minute: timing.minute,
    ...(days ? { daysOfWeek: days as CalendarDayOfWeek[] } : {}),
  }
}

function nextScheduleOccurrence(timing: ScheduleTiming, after: Date, previous?: string): string {
  if (timing.kind === 'at') return timing.at
  if (timing.kind === 'calendar') return nextCalendarOccurrence(timing, after)
  const intervalMs = timing.everySeconds * 1000
  const prior = previous ? Date.parse(previous) : Number.NaN
  let next = Number.isFinite(prior) ? prior + intervalMs : after.getTime() + intervalMs
  while (next <= after.getTime()) next += intervalMs
  return new Date(next).toISOString()
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]),
  ) as Record<string, number>
  const required = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const
  if (required.some(key => !Number.isFinite(parts[key]))) {
    throw new Error(`failed to resolve calendar time in ${timeZone}`)
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  }
}

function localDateTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | undefined {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0)
  let candidate = target
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const observed = zonedParts(new Date(candidate), timeZone)
    const represented = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    )
    const delta = target - represented
    if (delta === 0) break
    candidate += delta
  }
  const result = new Date(candidate)
  const observed = zonedParts(result, timeZone)
  return observed.year === year
    && observed.month === month
    && observed.day === day
    && observed.hour === hour
    && observed.minute === minute
    && observed.second === 0
    ? result
    : undefined
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0))
  } catch {
    throw new Error(`invalid IANA time zone: ${timeZone}`)
  }
}

export function normalizeTrigger(trigger: PipelineTrigger, defaultAdapterId: AdapterId): PipelineTrigger {
  if (trigger.kind === 'manual') return trigger
  if (trigger.kind === 'session_turn_completed') return { kind: 'agent_event', adapterId: adapterIdOf(trigger, defaultAdapterId), sessionId: nonEmpty(trigger.sessionId, 'trigger.sessionId'), event: 'turn_completed' }
  return { kind: 'agent_event', adapterId: adapterIdOf(trigger, defaultAdapterId), sessionId: nonEmpty(trigger.sessionId, 'trigger.sessionId'), event: trigger.event }
}

export function normalizePipeline(id: string, input: CreatePipelineInput, now: Date, defaultAdapterId: AdapterId): PipelineDefinition {
  if (input.nodes.length === 0) throw new Error('pipeline requires at least one node')
  const nodeIds = new Set<string>()
  const nodes: PipelineNode[] = input.nodes.map(node => {
    const nodeId = nonEmpty(node.id, 'node.id')
    if (nodeIds.has(nodeId)) throw new Error(`duplicate pipeline node: ${nodeId}`)
    nodeIds.add(nodeId)
    return { id: nodeId, target: normalizeTarget(node.target, defaultAdapterId), inheritUpstreamContext: node.inheritUpstreamContext !== false }
  })
  const edges: PipelineEdge[] = input.edges.map(edge => {
    const from = nonEmpty(edge.from, 'edge.from'); const to = nonEmpty(edge.to, 'edge.to')
    if (!nodeIds.has(from) || !nodeIds.has(to)) throw new Error(`pipeline edge references unknown node: ${from} -> ${to}`)
    if (from === to) throw new Error(`pipeline self-cycle is not allowed: ${from}`)
    return { from, to }
  })
  const trigger = normalizeTrigger(input.trigger, defaultAdapterId)
  topologicalOrder(nodes, edges)
  const timestamp = now.toISOString()
  return { id, name: nonEmpty(input.name, 'name'), trigger, nodes, edges, status: 'active', createdAt: timestamp, updatedAt: timestamp }
}

export function topologicalOrder(nodes: readonly PipelineNode[], edges: readonly PipelineEdge[]): string[] {
  const indegree = new Map(nodes.map(node => [node.id, 0])); const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]))
  for (const edge of edges) { if (!indegree.has(edge.from) || !indegree.has(edge.to)) throw new Error(`unknown pipeline edge: ${edge.from} -> ${edge.to}`); indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1); outgoing.get(edge.from)?.push(edge.to) }
  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id); const order: string[] = []
  while (queue.length > 0) { const id = queue.shift(); if (!id) break; order.push(id); for (const next of outgoing.get(id) ?? []) { const value = (indegree.get(next) ?? 0) - 1; indegree.set(next, value); if (value === 0) queue.push(next) } }
  if (order.length !== nodes.length) throw new Error('pipeline must be acyclic')
  return order
}

export function predecessorIds(nodeId: string, edges: readonly PipelineEdge[]): string[] { return edges.filter(edge => edge.to === nodeId).map(edge => edge.from) }

export function assertNoAutonomousSessionCycle(pipelines: readonly PipelineDefinition[], defaultAdapterId: AdapterId): void {
  const graph = new Map<string, Set<string>>()
  const ensure = (id: string): Set<string> => { const existing = graph.get(id); if (existing) return existing; const created = new Set<string>(); graph.set(id, created); return created }
  for (const pipeline of pipelines) {
    if (pipeline.status !== 'active' || pipeline.trigger.kind === 'manual') continue
    const trigger = normalizeTrigger(pipeline.trigger, defaultAdapterId); if (trigger.kind !== 'agent_event') continue
    const triggerKey = sessionKey(adapterIdOf(trigger, defaultAdapterId), trigger.sessionId); const nodes = new Map(pipeline.nodes.map(node => [node.id, node])); const roots = pipeline.nodes.filter(node => !pipeline.edges.some(edge => edge.to === node.id))
    for (const root of roots) ensure(triggerKey).add(sessionKey(adapterIdOf(root.target, defaultAdapterId), root.target.sessionId))
    for (const edge of pipeline.edges) { const from = nodes.get(edge.from); const to = nodes.get(edge.to); if (from && to) ensure(sessionKey(adapterIdOf(from.target, defaultAdapterId), from.target.sessionId)).add(sessionKey(adapterIdOf(to.target, defaultAdapterId), to.target.sessionId)) }
  }
  const visiting = new Set<string>(); const visited = new Set<string>()
  const visit = (id: string): void => { if (visiting.has(id)) throw new Error(`autonomous session trigger cycle detected at ${id.replace('\u0000', ':')}`); if (visited.has(id)) return; visiting.add(id); for (const next of graph.get(id) ?? []) visit(next); visiting.delete(id); visited.add(id) }
  for (const id of graph.keys()) visit(id)
}