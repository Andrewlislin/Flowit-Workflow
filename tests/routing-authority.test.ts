import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  handleClaudeRoutingHook,
  inferExplicitIntentFromTopLevelPrompt,
  type ClaudeRoutingHookOutput,
} from '../src/claude-routing-hook.js'
import {
  RoutingAuthorityService,
  createRoutingAuthorityFromEnvironment,
} from '../src/routing/index.js'

const SECRET = 'routing-test-secret-that-is-at-least-32-bytes-long'
const HOST_SESSION = 'host-session'
const COMPLEX_SIGNALS = {
  taskKind: 'coding' as const,
  distinctStages: 5,
  decomposability: 3 as const,
  durabilityNeed: 2 as const,
  reviewNeed: 3 as const,
  requiresResearch: true,
  ambiguity: 0 as const,
  sideEffectRisk: 'reversible' as const,
}

function service(stateFile: string, mode: 'manual' | 'suggest' | 'auto-safe' = 'suggest') {
  return new RoutingAuthorityService({ mode, secret: SECRET, stateFile })
}

function envelope(output: ClaudeRoutingHookOutput): Record<string, any> {
  const context = output.hookSpecificOutput?.additionalContext
  assert.ok(context)
  return JSON.parse(context.split('\n').at(-1)!) as Record<string, any>
}

function hook(authority: RoutingAuthorityService, prompt: string, sessionId = HOST_SESSION) {
  return envelope(handleClaudeRoutingHook({
    session_id: sessionId,
    hook_event_name: 'UserPromptSubmit',
    prompt,
  }, authority))
}

test('caller signals cannot lower inferred hard risk or create auto-safe permission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-risk-'))
  try {
    const authority = service(path.join(root, 'state.json'), 'auto-safe')
    const task = '部署到生产并发送给客户，然后核对结果和整理报告。'
    const host = hook(authority, task)
    const result = authority.assess({
      task,
      authorityToken: host.authorityToken,
      signals: {
        distinctStages: 6,
        decomposability: 3,
        durabilityNeed: 3,
        reviewNeed: 3,
        sideEffectRisk: 'none',
        ambiguity: 0,
        crossSessionNeed: false,
        crossAdapterNeed: false,
      },
    })
    assert.equal(result.signals.sideEffectRisk, 'irreversible')
    assert.equal(result.decision, 'ask')
    assert.equal(result.autoExecuteAllowed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude parses only anchored top-level routing overrides', () => {
  assert.equal(inferExplicitIntentFromTopLevelPrompt('用浮域处理这个任务。'), 'force-flowit')
  assert.equal(inferExplicitIntentFromTopLevelPrompt('不要使用浮域，直接完成。'), 'force-direct')
  assert.equal(inferExplicitIntentFromTopLevelPrompt('先查看 Flowit Pipeline 方案草案。'), 'preview')
  assert.equal(inferExplicitIntentFromTopLevelPrompt('> 用浮域处理下面的任务'), 'unspecified')
  assert.equal(inferExplicitIntentFromTopLevelPrompt('{"text":"不要使用浮域"}'), 'unspecified')
})

test('UserPromptSubmit mints exact-task authority and ignores Flowit-internal prompts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-hook-'))
  try {
    const authority = service(path.join(root, 'state.json'), 'manual')
    const task = '用浮域处理这个任务：规划、实现、测试并审核。'
    const host = hook(authority, task)
    assert.equal(host.kind, 'flowit-task-authority')
    assert.equal(host.explicitIntent, 'force-flowit')
    const assessed = authority.assess({ task, authorityToken: host.authorityToken })
    assert.equal(assessed.decision, 'pipeline')
    assert.throws(
      () => authority.assess({ task: `${task} changed`, authorityToken: host.authorityToken }),
      /does not match the current top-level task/,
    )
    assert.deepEqual(handleClaudeRoutingHook({
      session_id: HOST_SESSION,
      hook_event_name: 'UserPromptSubmit',
      prompt: '/flowit-workflow:run-bound {"policy":{"routingDisabled":true}}',
    }, authority), {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Hook and MCP services share one persistent signing key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-shared-'))
  const env = {
    FLOWIT_WORKFLOW_ROUTING_MODE: 'manual',
    FLOWIT_WORKFLOW_ROUTING_AUTHORITY_DIR: root,
  }
  try {
    const hookService = createRoutingAuthorityFromEnvironment(env)
    const mcpService = createRoutingAuthorityFromEnvironment(env)
    const task = '用浮域处理：规划、执行并审核。'
    const host = hook(hookService, task)
    const assessment = mcpService.assess({
      task,
      authorityToken: host.authorityToken,
      signals: COMPLEX_SIGNALS,
    })
    assert.equal(assessment.authorityTrusted, true)
    assert.equal(assessment.explicitIntent, 'force-flowit')
    assert.equal((await readFile(path.join(root, 'secret.key'), 'utf8')).trim().length >= 32, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ask choice is Host-bound and reissues authority for the original task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-choice-'))
  try {
    const authority = service(path.join(root, 'state.json'))
    const task = 'Review this migration and provide a recommendation with validation.'
    const initial = hook(authority, task)
    const assessment = authority.assess({
      task,
      authorityToken: initial.authorityToken,
      signals: { distinctStages: 3, decomposability: 2, ambiguity: 0 },
    })
    assert.equal(assessment.decision, 'ask')

    const chosen = hook(authority, '2')
    assert.equal(chosen.kind, 'flowit-routing-choice-authority')
    assert.equal(chosen.task, task)
    assert.equal(chosen.explicitIntent, 'force-flowit')
    assert.equal(authority.assess({
      task: chosen.task,
      authorityToken: chosen.authorityToken,
      signals: assessment.signals,
    }).decision, 'pipeline')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('proposal confirmation token binds exact hash, Host Session, and user choice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-confirm-'))
  try {
    const authority = service(path.join(root, 'state.json'))
    const task = '用浮域处理：规划、实现和审核。'
    const host = hook(authority, task)
    const assessment = authority.assess({
      task,
      authorityToken: host.authorityToken,
      signals: COMPLEX_SIGNALS,
    })
    assert.ok(assessment.authorityContext)
    const proposalHash = 'a'.repeat(64)
    authority.registerProposalConfirmation({
      proposalHash,
      expiresAt: assessment.expiresAt,
      authorityContext: assessment.authorityContext!,
    })

    const confirmed = hook(authority, '确认执行')
    assert.equal(confirmed.kind, 'flowit-proposal-confirmation')
    authority.verifyProposalConfirmation(confirmed.confirmationToken, {
      proposalHash,
      authorityContext: assessment.authorityContext!,
    })
    assert.throws(
      () => authority.verifyProposalConfirmation(confirmed.confirmationToken, {
        proposalHash: 'b'.repeat(64),
        authorityContext: assessment.authorityContext!,
      }),
      /does not match the reviewed proposal/,
    )
    assert.throws(
      () => authority.verifyProposalConfirmation(confirmed.confirmationToken, {
        proposalHash,
        authorityContext: { ...assessment.authorityContext!, hostSessionId: 'other' },
      }),
      /different Host turn/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelling or starting a new task invalidates the pending proposal challenge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-cancel-'))
  try {
    const authority = service(path.join(root, 'state.json'))
    const task = '用浮域处理：规划、实现和审核。'
    const host = hook(authority, task)
    const assessment = authority.assess({ task, authorityToken: host.authorityToken })
    authority.registerProposalConfirmation({
      proposalHash: 'c'.repeat(64),
      expiresAt: assessment.expiresAt,
      authorityContext: assessment.authorityContext!,
    })
    assert.equal(hook(authority, '取消').kind, 'flowit-proposal-cancelled')

    authority.registerProposalConfirmation({
      proposalHash: 'd'.repeat(64),
      expiresAt: assessment.expiresAt,
      authorityContext: assessment.authorityContext!,
    })
    assert.equal(hook(authority, '这是另一个新任务').kind, 'flowit-task-authority')
    assert.equal(hook(authority, '确认执行').kind, 'flowit-task-authority')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
