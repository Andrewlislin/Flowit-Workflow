import type { AgentExecutionBlockerCode } from './types.js'

const EXECUTION_ERROR_MARKER =
  '@coaseedgeltd/flowit-core/agent-execution-error'

export class AgentExecutionError extends Error {
  readonly executionErrorMarker = EXECUTION_ERROR_MARKER

  constructor(
    readonly code: AgentExecutionBlockerCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'AgentExecutionError'
  }
}

export function isAgentExecutionError(
  value: unknown,
): value is AgentExecutionError {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AgentExecutionError>
  return (
    candidate.executionErrorMarker === EXECUTION_ERROR_MARKER &&
    typeof candidate.code === 'string' &&
    typeof candidate.retryable === 'boolean'
  )
}

export function isNonRetryableExecutionError(value: unknown): boolean {
  return isAgentExecutionError(value) && value.retryable === false
}
