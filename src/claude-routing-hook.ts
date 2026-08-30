import { randomUUID } from 'node:crypto'
import {
  createRoutingAuthorityFromEnvironment,
  type RoutingAuthorityService,
  type RoutingExplicitIntent,
  type RoutingWorkflowToolName,
} from './routing/index.js'
import { inferExplicitIntentFromTopLevelPrompt } from './routing/intent.js'

export { inferExplicitIntentFromTopLevelPrompt } from './routing/intent.js'

export interface ClaudeRoutingHookInput {
  readonly session_id: string
  readonly hook_event_name: string
  readonly prompt?: string
  readonly transcript_path?: string
  readonly cwd?: string
  readonly tool_name?: string
  readonly tool_input?: Record<string, unknown>
  readonly tool_use_id?: string
}

export interface ClaudeRoutingHookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: 'UserPromptSubmit' | 'PreToolUse'
    readonly additionalContext?: string
    readonly permissionDecision?: 'allow' | 'ask' | 'deny'
    readonly permissionDecisionReason?: string
    readonly updatedInput?: Record<string, unknown>
  }
}

type TrustedEnvelope =
  | {
      kind: 'flowit-task-authority' | 'flowit-routing-choice-authority'
      version: 1
      task: string
      explicitIntent: RoutingExplicitIntent
      authorityToken: string
    }
  | {
      kind: 'flowit-proposal-confirmation'
      version: 1
      proposalHash: string
      confirmationToken: string
    }
  | {
      kind: 'flowit-proposal-cancelled'
      version: 1
      proposalHash: string
    }
  | {
      kind: 'flowit-proposal-confirmation-rejected'
      version: 1
      reason: 'confirmation-code-required' | 'unknown-confirmation-code'
    }

type ProposalChoiceAttempt =
  | {
      readonly kind: 'choice'
      readonly choice: 'confirm' | 'cancel'
      readonly confirmationCode: string
    }
  | { readonly kind: 'invalid' }

const ADAPTIVE_WORKFLOW_TOOL_PREFIXES = [
  'mcp__plugin_flowit-workflow_orchestration__',
  'mcp__orchestration__',
] as const

export function handleClaudeRoutingHook(
  input: ClaudeRoutingHookInput,
  authority: RoutingAuthorityService = createRoutingAuthorityFromEnvironment(),
): ClaudeRoutingHookOutput {
  if (input.hook_event_name === 'PreToolUse') {
    return handlePreToolUse(input, authority)
  }
  if (input.hook_event_name !== 'UserPromptSubmit') {
    throw new Error('Claude routing hook accepts only UserPromptSubmit or PreToolUse events')
  }
  return handleUserPromptSubmit(input, authority)
}

function handlePreToolUse(
  input: ClaudeRoutingHookInput,
  authority: RoutingAuthorityService,
): ClaudeRoutingHookOutput {
  const toolName = adaptiveWorkflowToolName(input.tool_name)
  if (!toolName) return {}
  const hostSessionId = requiredString(input.session_id, 'session_id')
  const toolUseId = requiredString(input.tool_use_id, 'tool_use_id')
  const unsignedInput = record(input.tool_input, 'tool_input')
  delete unsignedInput.callerToken
  const callerToken = authority.issueCallerAttestation({
    hostId: 'claude-code',
    hostSessionId,
    toolUseId,
    toolName,
    toolInput: unsignedInput,
  })
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: toolName === 'workflow_commit' ? 'ask' : 'allow',
      permissionDecisionReason:
        toolName === 'workflow_commit'
          ? 'Flowit durable admission requires the Claude Host to preserve its mutation approval gate.'
          : 'Flowit adaptive assessment and preparation are read-only with respect to the Workflow Store.',
      updatedInput: {
        ...unsignedInput,
        callerToken,
      },
    },
  }
}

function handleUserPromptSubmit(
  input: ClaudeRoutingHookInput,
  authority: RoutingAuthorityService,
): ClaudeRoutingHookOutput {
  const hostSessionId = requiredString(input.session_id, 'session_id')
  const prompt = input.prompt?.trim()
  if (!prompt || isFlowitInternalPrompt(prompt)) return {}
  const context = {
    hostId: 'claude-code',
    hostSessionId,
    turnNonce: randomUUID(),
  }

  const proposalChoice = parseProposalChoice(prompt)
  if (proposalChoice?.kind === 'invalid') {
    return contextOutput({
      kind: 'flowit-proposal-confirmation-rejected',
      version: 1,
      reason: 'confirmation-code-required',
    })
  }
  if (proposalChoice?.kind === 'choice') {
    const result = authority.consumeProposalConfirmation(
      context,
      proposalChoice.choice,
      proposalChoice.confirmationCode,
    )
    if (result?.kind === 'confirmed') {
      return contextOutput({
        kind: 'flowit-proposal-confirmation',
        version: 1,
        proposalHash: result.proposalHash,
        confirmationToken: result.confirmationToken,
      })
    }
    if (result?.kind === 'cancelled') {
      return contextOutput({
        kind: 'flowit-proposal-cancelled',
        version: 1,
        proposalHash: result.proposalHash,
      })
    }
    return contextOutput({
      kind: 'flowit-proposal-confirmation-rejected',
      version: 1,
      reason: 'unknown-confirmation-code',
    })
  }

  const routingChoice = parseRoutingChoice(prompt)
  if (routingChoice) {
    const result = authority.consumeRoutingChoice(context, routingChoice)
    if (result) {
      return contextOutput({
        kind: 'flowit-routing-choice-authority',
        version: 1,
        task: result.task,
        explicitIntent: result.explicitIntent,
        authorityToken: result.authorityToken,
      })
    }
  }

  // A normal new top-level task invalidates unanswered challenges in this
  // Session. A proposal can only be confirmed by its explicit displayed code.
  authority.abandonPending(context)
  const explicitIntent = inferExplicitIntentFromTopLevelPrompt(prompt)
  const authorityToken = authority.issueHostAuthority({
    task: prompt,
    explicitIntent,
    hostId: context.hostId,
    hostSessionId: context.hostSessionId,
    turnNonce: context.turnNonce,
  })
  return contextOutput({
    kind: 'flowit-task-authority',
    version: 1,
    task: prompt,
    explicitIntent,
    authorityToken,
  })
}

function contextOutput(envelope: TrustedEnvelope): ClaudeRoutingHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        'Flowit trusted routing context from the Claude Code UserPromptSubmit hook.',
        'Pass opaque tokens only to the matching Flowit workflow tool. Do not edit their task or proposal hash.',
        JSON.stringify(envelope),
      ].join('\n'),
    },
  }
}

function parseProposalChoice(prompt: string): ProposalChoiceAttempt | undefined {
  const value = prompt.normalize('NFKC').trim()
  const confirm = value.match(
    /^(?:确认执行|执行这个方案|执行该方案|用浮域执行该方案|确认使用浮域执行|confirm|run this proposal|execute this proposal|yes run it)\s+([a-f0-9]{12})[。.!]?$/i,
  )
  if (confirm?.[1]) {
    return {
      kind: 'choice',
      choice: 'confirm',
      confirmationCode: confirm[1].toUpperCase(),
    }
  }
  const cancel = value.match(
    /^(?:取消|不执行|不要执行|取消这个方案|cancel|do not run)\s+([a-f0-9]{12})[。.!]?$/i,
  )
  if (cancel?.[1]) {
    return {
      kind: 'choice',
      choice: 'cancel',
      confirmationCode: cancel[1].toUpperCase(),
    }
  }
  if (
    /^(?:确认执行|执行这个方案|执行该方案|用浮域执行该方案|确认使用浮域执行|confirm|run this proposal|execute this proposal|yes run it)(?:\s|$)/i.test(value) ||
    /^(?:取消|不执行|不要执行|取消这个方案|cancel|do not run)(?:\s|$)/i.test(value)
  ) {
    return { kind: 'invalid' }
  }
  return undefined
}

function parseRoutingChoice(
  prompt: string,
): Exclude<RoutingExplicitIntent, 'unspecified'> | undefined {
  const value = normalizedChoice(prompt)
  if (new Set([
    '1',
    '直接完成',
    '直接做',
    '当前agent直接完成',
    '不用浮域',
    '不要使用浮域',
  ]).has(value)) return 'force-direct'
  if (new Set([
    '2',
    '用浮域',
    '使用浮域',
    '用浮域执行',
    '浮域执行',
    '使用pipeline',
    'pipeline',
  ]).has(value)) return 'force-flowit'
  if (new Set([
    '3',
    '只看方案',
    '先看方案',
    '预览方案',
    '只查看pipeline草案',
  ]).has(value)) return 'preview'
  return undefined
}

function adaptiveWorkflowToolName(value: unknown): RoutingWorkflowToolName | undefined {
  if (typeof value !== 'string') return undefined
  const prefix = ADAPTIVE_WORKFLOW_TOOL_PREFIXES.find(candidate =>
    value.startsWith(candidate),
  )
  if (!prefix) return undefined
  const name = value.slice(prefix.length)
  if (
    name === 'workflow_assess' ||
    name === 'workflow_prepare' ||
    name === 'workflow_commit'
  ) {
    return name
  }
  return undefined
}

function normalizedChoice(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'\x60]+/g, '')
}

function isFlowitInternalPrompt(prompt: string): boolean {
  const trimmed = prompt.trim()
  return trimmed.startsWith('/flowit-workflow:run-bound') ||
    /"routingDisabled"\s*:\s*true/.test(trimmed) ||
    /You are the .+ stage \(\d+\/\d+\) of a Flowit run-once Pipeline\./.test(trimmed)
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return structuredClone(value as Record<string, unknown>)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}
