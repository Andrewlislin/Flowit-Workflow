import type {
  AgentDispatchRequest,
  AgentDispatchResult,
} from '@coaseedgeltd/flowit-core'
import {
  CodexAgentAdapter as BaseCodexAgentAdapter,
  CodexAppServerClient,
  type CodexAdapterConfig,
} from './index.js'

export * from './index.js'

const DEFAULT_OUTPUT_MAX_CHARS = 12_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Public Codex adapter facade.
 *
 * The underlying App Server adapter keeps one long-lived client for dispatch.
 * This facade replaces its legacy whole-thread JSON summary with output scoped
 * to the exact completed turn. If the current turn cannot be proven, the
 * summary is omitted rather than leaking unrelated historical thread content.
 */
export class CodexAgentAdapter extends BaseCodexAgentAdapter {
  private readonly outputMaxChars: number
  private readonly outputReadTimeoutMs: number

  constructor(config: CodexAdapterConfig = {}) {
    super(config)
    this.outputMaxChars = positiveInteger(
      config.contextMaxChars ?? DEFAULT_OUTPUT_MAX_CHARS,
      DEFAULT_OUTPUT_MAX_CHARS,
    )
    this.outputReadTimeoutMs = positiveInteger(
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    )
  }

  override async dispatch(
    request: AgentDispatchRequest,
    signal?: AbortSignal,
  ): Promise<AgentDispatchResult> {
    const result = await super.dispatch(request, signal)
    const turnId = nonEmptyString(result.runId)
    const legacySummary = nonEmptyString(result.outputSummary)
    const fromLegacy = turnId && legacySummary
      ? summarizeSerializedThreadTurn(legacySummary, turnId, this.outputMaxChars)
      : undefined
    const outputSummary = fromLegacy ?? await this.readCompletedTurn(
      request.sessionId,
      turnId,
      result,
      signal,
    )
    const { outputSummary: _legacyWholeThreadSummary, ...safeResult } = result
    return outputSummary ? { ...safeResult, outputSummary } : safeResult
  }

  private async readCompletedTurn(
    threadId: string,
    turnId: string | undefined,
    result: AgentDispatchResult,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const executable = nonEmptyString(result.executionEvidence?.host?.executable)
    if (!turnId || !executable) return undefined
    const client = new CodexAppServerClient(executable, this.outputReadTimeoutMs)
    try {
      const snapshot = await client.request(
        'thread/read',
        { threadId, includeTurns: true },
        signal,
        this.outputReadTimeoutMs,
      )
      return summarizeThreadTurn(snapshot, turnId, this.outputMaxChars)
    } catch {
      return undefined
    } finally {
      await client.dispose().catch(() => undefined)
    }
  }
}

function summarizeSerializedThreadTurn(
  value: string,
  turnId: string,
  limit: number,
): string | undefined {
  try {
    return summarizeThreadTurn(JSON.parse(value) as unknown, turnId, limit)
  } catch {
    return undefined
  }
}

function summarizeThreadTurn(
  snapshot: unknown,
  turnId: string,
  limit: number,
): string | undefined {
  const turn = findTurn(snapshot, turnId)
  if (!turn) return undefined
  const assistantText = assistantTextFromTurn(turn)
  const value = assistantText.length > 0
    ? assistantText.join('\n\n')
    : JSON.stringify(turn)
  return truncate(value, limit)
}

function findTurn(snapshot: unknown, turnId: string): Record<string, unknown> | undefined {
  if (!isRecord(snapshot)) return undefined
  const candidates = [
    snapshot.turns,
    isRecord(snapshot.thread) ? snapshot.thread.turns : undefined,
    isRecord(snapshot.data) ? snapshot.data.turns : undefined,
  ]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const turn = candidate.find(item => {
      if (!isRecord(item)) return false
      return nonEmptyString(item.id) === turnId || nonEmptyString(item.turnId) === turnId
    })
    if (isRecord(turn)) return turn
  }
  return undefined
}

function assistantTextFromTurn(turn: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const key of ['agentMessage', 'assistantMessage', 'finalResponse', 'outputText']) {
    collectText(turn[key], values)
  }
  for (const collection of [turn.items, turn.output, turn.messages]) {
    if (!Array.isArray(collection)) continue
    for (const item of collection) {
      if (!isRecord(item) || !isAssistantItem(item)) continue
      collectText(item.text, values)
      collectText(item.content, values)
      collectText(item.message, values)
      collectText(item.outputText, values)
      collectText(item.output_text, values)
    }
  }
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function isAssistantItem(item: Record<string, unknown>): boolean {
  const role = nonEmptyString(item.role)?.toLocaleLowerCase()
  const type = nonEmptyString(item.type ?? item.kind)?.toLocaleLowerCase()
  return role === 'assistant' ||
    type === 'output_text' ||
    type?.includes('agentmessage') === true ||
    type?.includes('agent_message') === true ||
    type?.includes('assistant') === true
}

function collectText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    if (value.trim()) output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output)
    return
  }
  if (!isRecord(value)) return
  for (const key of ['text', 'content', 'message', 'outputText', 'output_text']) {
    if (key in value) collectText(value[key], output)
  }
}

function truncate(value: string, limit: number): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit)}\n…[truncated]`
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
