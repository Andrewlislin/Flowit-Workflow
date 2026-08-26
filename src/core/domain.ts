import type { AdapterId, AutomationTarget, CreatePipelineInput, CreateScheduleInput, PipelineDefinition, PipelineEdge, PipelineNode, PipelineTrigger, ScheduledTask, SessionContextRef } from './types.js'
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
  if (input.timing.kind === 'every') {
    if (!Number.isSafeInteger(input.timing.everySeconds) || input.timing.everySeconds < minimumIntervalSeconds) throw new Error(`everySeconds must be an integer >= ${minimumIntervalSeconds}`)
  } else {
    const at = Date.parse(input.timing.at)
    if (!Number.isFinite(at)) throw new Error('at must be a valid ISO timestamp')
    if (at <= now.getTime()) throw new Error('at must be in the future')
  }
  const target = normalizeTarget(input.target, defaultAdapterId)
  const timing = input.timing.kind === 'at' ? { kind: 'at' as const, at: new Date(input.timing.at).toISOString() } : { kind: 'every' as const, everySeconds: input.timing.everySeconds }
  const nextRunAt = timing.kind === 'at' ? timing.at : new Date(now.getTime() + timing.everySeconds * 1000).toISOString()
  return { id, name: nonEmpty(input.name, 'name'), target, timing, status: 'active', nextRunAt, createdAt, updatedAt: createdAt }
}

export function advanceSchedule(task: ScheduledTask, firedAt: Date, oneShotOutcome: 'completed' | 'failed' = 'completed'): ScheduledTask {
  const now = firedAt.toISOString()
  if (task.timing.kind === 'at') {
    const { nextRunAt: _nextRunAt, ...rest } = task
    return { ...rest, status: oneShotOutcome, lastRunAt: now, updatedAt: now }
  }
  const intervalMs = task.timing.everySeconds * 1000
  const previous = task.nextRunAt ? Date.parse(task.nextRunAt) : firedAt.getTime()
  let next = Number.isFinite(previous) ? previous + intervalMs : firedAt.getTime() + intervalMs
  while (next <= firedAt.getTime()) next += intervalMs
  return { ...task, lastRunAt: now, nextRunAt: new Date(next).toISOString(), updatedAt: now }
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
