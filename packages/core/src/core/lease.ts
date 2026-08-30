import type { LeaseDefinitionGuard } from './store.js'
import { JsonWorkflowStore } from './store.js'

export interface LeaseHeartbeat {
  signal: AbortSignal
  stop(): void
}

/**
 * Renew a run whose lease must remain fenced by an active Schedule or
 * persistent Pipeline definition.
 */
export function startLeaseHeartbeat(
  store: JsonWorkflowStore,
  runId: string,
  owner: string,
  leaseDurationMs: number,
  guard: LeaseDefinitionGuard,
): LeaseHeartbeat {
  return startHeartbeat(store, runId, owner, leaseDurationMs, guard)
}

/**
 * Renew a snapshot-owned run that deliberately has no persistent definition.
 * The run record and owner lease remain authoritative; callers must not use
 * this helper for Schedule or persistent Pipeline execution.
 */
export function startRunLeaseHeartbeat(
  store: JsonWorkflowStore,
  runId: string,
  owner: string,
  leaseDurationMs: number,
): LeaseHeartbeat {
  return startHeartbeat(store, runId, owner, leaseDurationMs)
}

function startHeartbeat(
  store: JsonWorkflowStore,
  runId: string,
  owner: string,
  leaseDurationMs: number,
  guard?: LeaseDefinitionGuard,
): LeaseHeartbeat {
  const controller = new AbortController()
  const interval = Math.max(250, Math.floor(leaseDurationMs / 3))
  let stopped = false
  let renewing = false
  const renew = async (): Promise<void> => {
    if (stopped || renewing) return
    renewing = true
    try {
      const retained = await store.renewRunLease(runId, owner, leaseDurationMs, guard)
      if (!retained && !controller.signal.aborted) {
        controller.abort(new Error(`automation run ${runId} lost its worker lease`))
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        controller.abort(error instanceof Error ? error : new Error(String(error)))
      }
    } finally {
      renewing = false
    }
  }
  const timer = setInterval(() => void renew(), interval)
  return {
    signal: controller.signal,
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
  }
}
