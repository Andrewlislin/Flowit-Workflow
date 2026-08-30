import { randomUUID } from 'node:crypto'
import {
  createRoutingAuthorityFromEnvironment,
  type RoutingAuthorityService,
  type RoutingExplicitIntent,
} from './routing/index.js'
import { inferExplicitIntentFromTopLevelPrompt } from './routing/intent.js'

export interface ClaudeRoutingHookInput {
  readonly session_id: string
  readonly hook_event_name: string
  readonly prompt: string
  readonly transcript_path?: string
  readonly cwd?: string
}

export interface ClaudeRoutingHookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: 'UserPromptSubmit'
    readonly additionalContext: string
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

export function handleClaudeRoutingHook(
  input: ClaudeRoutingHookInput,
  authority: RoutingAuthorityService = createRoutingAuthorityFromEnvironment(),
): ClaudeRoutingHookOutput {
  if (input.hook_event_name !== 'UserPromptSubmit') {
    throw new Error('Claude routing hook only accepts UserPromptSubmit events')
  }
  const hostSessionId = requiredString(input.session_id, 'session_id')
  const prompt = input.prompt?.trim()
  if (!prompt || isFlowitInternalPrompt(prompt)) return {}
  const context = {
    hostId: 'claude-code',
    hostSessionId,
    turnNonce: randomUUID(),
  }

  const proposalChoice = parseProposalChoice(prompt)
  if (proposalChoice) {
    const result = authority.consumeProposalConfirmation(context, proposalChoice)
    if (result?.kind === 'confirmed') {
      return output({
        kind: 'flowit-proposal-confirmation',
        version: 1,
        proposalHash: result.proposalHash,
        confirmationToken: result.confirmationToken,
      })
    }
    if (result?.kind === 'cancelled') {
      return output({
        kind: 'flowit-proposal-cancelled',
        version: 1,
        proposalHash: result.proposalHash,
      })
    }
  }

  const routingChoice = parseRoutingChoice(prompt)
  if (routingChoice) {
    const result = authority.consumeRoutingChoice(context, routingChoice)
    if (result) {
      return output({
        kind: 'flowit-routing-choice-authority',
        version: 1,
        task: result.task,
        explicitIntent: result.explicitIntent,
        authorityToken: result.authorityToken,
      })
    }
  }

  // A normal new top-level task invalidates any unanswered challenge in this
  // Session. The user must review a newly prepared proposal before confirming.
  authority.abandonPending(context)
  const explicitIntent = inferExplicitIntentFromTopLevelPrompt(prompt)
  const authorityToken = authority.issueHostAuthority({
    task: prompt,
    explicitIntent,
    hostId: context.hostId,
    hostSessionId: context.hostSessionId,
    turnNonce: context.turnNonce,
  })
  return output({
    kind: 'flowit-task-authority',
    version: 1,
    task: prompt,
    explicitIntent,
    authorityToken,
  })
}

function output(envelope: TrustedEnvelope): ClaudeRoutingHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        'Flowit trusted routing context from the Claude Code UserPromptSubmit hook.',
        'Pass the opaque token only to the matching Flowit workflow tool. Do not edit its task or proposal hash.',
        JSON.stringify(envelope),
      ].join('\n'),
    },
  }
}

function parseProposalChoice(prompt: string): 'confirm' | 'cancel' | undefined {
  const value = normalizedChoice(prompt)
  if (new Set([
    '确认执行',
    '执行这个方案',
    '执行该方案',
    '用浮域执行该方案',
    '确认使用浮域执行',
    'confirm',
    'runthisproposal',
    'executethisproposal',
    'yesrunit',
  ]).has(value)) return 'confirm'
  if (new Set([
    '取消',
    '不执行',
    '不要执行',
    '取消这个方案',
    'cancel',
    'donotrun',
  ]).has(value)) return 'cancel'
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

function normalizedChoice(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'`]+/g, '')
}

function isFlowitInternalPrompt(prompt: string): boolean {
  const trimmed = prompt.trim()
  return trimmed.startsWith('/flowit-workflow:run-bound') ||
    /"routingDisabled"\s*:\s*true/.test(trimmed) ||
    /You are the .+ stage \(\d+\/\d+\) of a Flowit run-once Pipeline\./.test(trimmed)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}
