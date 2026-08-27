import type { AdapterId, AutomationRunNodeResult, SessionContextRef } from './types.js'
import { nonEmpty } from './utils.js'

export class ContextGraph {
  normalize(
    refs: readonly SessionContextRef[] | undefined,
    defaultAdapterId: AdapterId,
    target?: { adapterId: AdapterId; sessionId: string },
  ): SessionContextRef[] {
    const seen = new Set<string>()
    const result: SessionContextRef[] = []
    for (const raw of refs ?? []) {
      const adapterId = nonEmpty(raw.adapterId ?? defaultAdapterId, 'contextRefs.adapterId')
      const sessionId = nonEmpty(raw.sessionId, 'contextRefs.sessionId')
      const key = `${adapterId}\u0000${sessionId}`
      if (target && adapterId === target.adapterId && sessionId === target.sessionId) continue
      if (seen.has(key)) continue
      seen.add(key)
      const label = raw.label?.trim()
      result.push(label ? { adapterId, sessionId, label } : { adapterId, sessionId })
    }
    return result
  }

  inheritedFromResults(
    results: readonly AutomationRunNodeResult[],
    nodeIds: readonly string[],
  ): SessionContextRef[] {
    const wanted = new Set(nodeIds)
    return results
      .filter(result => wanted.has(result.nodeId))
      .map(result => ({ adapterId: result.adapterId, sessionId: result.sessionId, label: `Upstream ${result.nodeId}` }))
  }
}
