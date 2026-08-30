import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  handleClaudeRoutingHook,
  type ClaudeRoutingHookOutput,
} from '../src/claude-routing-hook.js'
import {
  RoutingAuthorityService,
  confirmationCodeForProposalHash,
  createRoutingAuthorityFromEnvironment,
  inferExplicitIntentFromTopLevelPrompt,
  type RoutingCallerContext,
  type RoutingWorkflowToolName,
  type TaskAssessmentRequest,
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

function service(
  stateFile: string,
  mode: 'manual' | 'suggest' | 'auto-safe' = 'suggest',
  requireCallerAttestation = false,
) {
  return new RoutingAuthorityService({
    mode,
    secret: SECRET,
    stateFile,
    requireCallerAttestation,
  })
}

function envelope(output: ClaudeRoutingHookOutput): Record<string, any> {
  const context = output.hookSpecificOutput?.additionalContext
  assert.ok(context)
  return JSON.parse(context.split('\n').at(-1)!) as Record<string, any>
}

function promptHook(
  authority: RoutingAuthorityService,
  prompt: string,
  sessionId = HOST_SESSION,
) {
  return envelope(handleClaudeRoutingHook({
    session_id: sessionId,
    hook_event_name: 'UserPromptSubmit',
    prompt,
  }, authority))
}

function callerFor(
  authority: RoutingAuthorityService,
  toolName: RoutingWorkflowToolName,
  toolInput: Record<string, unknown>,
  sessionId = HOST_SESSION,
  toolUseId = `${toolName}-tool-use`,
): RoutingCallerContext {
  const output = handleClaudeRoutingHook({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: `mcp__orchestration__${toolName}`,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  }, authority)
  const updated = output.hookSpecificOutput?.updatedInput
  assert.ok(updated)
  assert.equal(output.hookSpecificOutput?.hookEventName, 'PreToolUse')
  assert.equal(
    output.hookSpecificOutput?.permissionDecision,
    toolName === 'workflow_commit' ? 'ask' : 'allow',
  )
  const callerToken = updated.callerToken
  assert.equal(typeof callerToken, 'string')
  return authority.consumeCallerAttestation(
    callerToken as string,
    { toolName, toolInput },
  )
}

function assessWithCaller(
  authority: RoutingAuthorityService,
  input: TaskAssessmentRequest,
  sessionId = HOST_SESSION,
) {
  return authority.assess(
    input,
    callerFor(authority, 'workflow_assess', input as unknown as Record<string, unknown>, sessionId),
  )
}

test('caller signals cannot lower inferred hard risk or create auto-safe permission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-risk-'))
  try {
    const authority = service(path.join(root, 'state.json'), 'auto-safe', true)
    const task = '部署到生产并发送给客户，然后核对结果和整理报告。'
    const host = promptHook(authority, task)
    const result = assessWithCaller(authority, {
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
    const authority = service(path.join(root, 'state.json'), 'manual', true)
    const task = '用浮域处理这个任务：规划、实现、测试并审核。'
    const host = promptHook(authority, task)
    assert.equal(host.kind, 'flowit-task-authority')
    assert.equal(host.explicitIntent, 'force-flowit')
    const assessed = assessWithCaller(authority, {
      task,
      authorityToken: host.authorityToken,
    })
    assert.equal(assessed.decision, 'pipeline')
    const changed = {
      task: `${task} changed`,
      authorityToken: host.authorityToken,
    }
    assert.throws(
      () => assessWithCaller(authority, changed),
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

test('Hook and MCP services share one persistent signing key and caller state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-shared-'))
  const env = {
    FLOWIT_WORKFLOW_ROUTING_MODE: 'manual',
    FLOWIT_WORKFLOW_ROUTING_AUTHORITY_DIR: root,
  }
  try {
    const hookService = createRoutingAuthorityFromEnvironment(env)
    const mcpService = createRoutingAuthorityFromEnvironment(env)
    const task = '用浮域处理：规划、执行并审核。'
    const host = promptHook(hookService, task)
    const toolInput = {
      task,
      authorityToken: host.authorityToken,
      signals: COMPLEX_SIGNALS,
    }
    const preTool = handleClaudeRoutingHook({
      session_id: HOST_SESSION,
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__orchestration__workflow_assess',
      tool_input: toolInput,
      tool_use_id: 'shared-tool-use',
    }, hookService)
    const callerToken = preTool.hookSpecificOutput?.updatedInput?.callerToken
    assert.equal(typeof callerToken, 'string')
    const caller = mcpService.consumeCallerAttestation(
      callerToken as string,
      { toolName: 'workflow_assess', toolInput },
    )
    const assessment = mcpService.assess(toolInput, caller)
    assert.equal(assessment.authorityTrusted, true)
    assert.equal(assessment.explicitIntent, 'force-flowit')
    assert.equal((await readFile(path.join(root, 'secret.key'), 'utf8')).trim().length >= 32, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent first use publishes one complete authority secret', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-secret-race-'))
  try {
    const secretFile = path.join(root, 'routing-authority', 'secret.key')
    const moduleUrl = new URL('../src/routing/authority-state.js', import.meta.url).href
    const program = [
      `import { readOrCreateAuthoritySecret } from ${JSON.stringify(moduleUrl)};`,
      `process.stdout.write(readOrCreateAuthoritySecret(${JSON.stringify(secretFile)}));`,
    ].join('\n')
    const [first, second] = await Promise.all([
      runNode(program),
      runNode(program),
    ])
    assert.equal(first, second)
    assert.equal(first.length >= 32, true)
    assert.equal((await readFile(secretFile, 'utf8')).trim(), first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('caller attestation proves the actual Session and is single-use', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-caller-'))
  try {
    const authority = service(path.join(root, 'state.json'), 'auto-safe', true)
    const task = '用浮域处理：规划、实现、测试并审核。'
    const host = promptHook(authority, task, 'session-a')
    const toolInput = {
      task,
      authorityToken: host.authorityToken,
      signals: COMPLEX_SIGNALS,
    }
    const output = handleClaudeRoutingHook({
      session_id: 'session-b',
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__orchestration__workflow_assess',
      tool_input: toolInput,
      tool_use_id: 'cross-session-use',
    }, authority)
    const callerToken = output.hookSpecificOutput?.updatedInput?.callerToken
    assert.equal(typeof callerToken, 'string')
    const caller = authority.consumeCallerAttestation(
      callerToken as string,
      { toolName: 'workflow_assess', toolInput },
    )
    assert.throws(
      () => authority.assess(toolInput, caller),
      /different Host Session/,
    )
    assert.throws(
      () => authority.consumeCallerAttestation(
        callerToken as string,
        { toolName: 'workflow_assess', toolInput },
      ),
      /already used/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ask choice is Host-bound and reissues authority for the original task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-choice-'))
  try {
    const authority = service(path.join(root, 'state.json'), 'suggest', true)
    const task = 'Review this migration and provide a recommendation with validation.'
    const initial = promptHook(authority, task)
    const assessment = assessWithCaller(authority, {
      task,
      authorityToken: initial.authorityToken,
      signals: { distinctStages: 3, decomposability: 2, ambiguity: 0 },
    })
    assert.equal(assessment.decision, 'ask')

    const chosen = promptHook(authority, '2')
    assert.equal(chosen.kind, 'flowit-routing-choice-authority')
    assert.equal(chosen.task, task)
    assert.equal(chosen.explicitIntent, 'force-flowit')
    assert.equal(assessWithCaller(authority, {
      task: chosen.task,
      authorityToken: chosen.authorityToken,
      signals: assessment.signals,
    }).decision, 'pipeline')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('proposal confirmation code resolves only the proposal the user reviewed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-confirm-'))
  try {
    const authority = service(path.join(root, 'state.json'), 'suggest', true)
    const task = '用浮域处理：规划、实现和审核。'
    const host = promptHook(authority, task)
    const assessment = assessWithCaller(authority, {
      task,
      authorityToken: host.authorityToken,
      signals: COMPLEX_SIGNALS,
    })
    assert.ok(assessment.authorityContext)

    const proposalA = 'a'.repeat(64)
    const proposalB = 'b'.repeat(64)
    const codeA = confirmationCodeForProposalHash(proposalA)
    const codeB = confirmationCodeForProposalHash(proposalB)
    authority.registerProposalConfirmation({
      proposalHash: proposalA,
      confirmationCode: codeA,
      expiresAt: assessment.expiresAt,
      authorityContext: assessment.authorityContext!,
    })
    authority.registerProposalConfirmation({
      proposalHash: proposalB,
      confirmationCode: codeB,
      expiresAt: assessment.expiresAt,
      authorityContext: assessment.authorityContext!,
    })

    const missingCode = promptHook(authority, '确认执行')
    assert.equal(missingCode.kind, 'flowit-proposal-confirmation-rejected')
    assert.equal(missingCode.reason, 'confirmation-code-required')

    const confirmedA = promptHook(authority, `确认执行 ${codeA}`)
    assert.equal(confirmedA.kind, 'flowit-proposal-confirmation')
    assert.equal(confirmedA.proposalHash, proposalA)
    authority.verifyProposalConfirmation(
      confirmedA.confirmationToken,
      {
        proposalHash: proposalA,
        authorityContext: assessment.authorityContext!,
      },
      { hostId: 'claude-code', hostSessionId: HOST_SESSION, toolUseId: 'commit-a' },
    )
    assert.throws(
      () => authority.verifyProposalConfirmation(
        confirmedA.confirmationToken,
        {
          proposalHash: proposalB,
          authorityContext: assessment.authorityContext!,
        },
        { hostId: 'claude-code', hostSessionId: HOST_SESSION, toolUseId: 'commit-b' },
      ),
      /does not match the reviewed proposal/,
    )

    const confirmedB = promptHook(authority, `确认执行 ${codeB}`)
    assert.equal(confirmedB.kind, 'flowit-proposal-confirmation')
    assert.equal(confirmedB.proposalHash, proposalB)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('proposal confirmation rejects a different actual caller Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-confirm-session-'))
  try {
    const authority = service(path.join(root, 'state.json'), 'suggest', true)
    const task = '用浮域处理：规划、实现和审核。'
    const host = promptHook(authority, task, 'session-a')
    const assessment = assessWithCaller(authority, {
      task,
      authorityToken: host.authorityToken,
      signals: COMPLEX_SIGNALS,
    }, 'session-a')
    const proposalHash = 'c'.repeat(64)
    const confirmationCode = confirmationCodeForProposalHash(proposalHash)
    authority.registerProposalConfirmation({
      proposalHash,
      confirmationCode,
      expiresAt: assessment.expiresAt,
      authorityContext: assessment.authorityContext!,
    })
    const confirmed = promptHook(
      authority,
      `确认执行 ${confirmationCode}`,
      'session-a',
    )
    assert.throws(
      () => authority.verifyProposalConfirmation(
        confirmed.confirmationToken,
        {
          proposalHash,
          authorityContext: assessment.authorityContext!,
        },
        { hostId: 'claude-code', hostSessionId: 'session-b', toolUseId: 'commit-b' },
      ),
      /different Host Session/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelling with an exact code or starting a new task invalidates pending challenges', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-auth-cancel-'))
  try {
    const authority = service(path.join(root, 'state.json'), 'suggest', true)
    const task = '用浮域处理：规划、实现和审核。'
    const host = promptHook(authority, task)
    const assessment = assessWithCaller(authority, {
      task,
      authorityToken: host.authorityToken,
    })
    const proposalA = 'd'.repeat(64)
    const codeA = confirmationCodeForProposalHash(proposalA)
    authority.registerProposalConfirmation({
      proposalHash: proposalA,
      confirmationCode: codeA,
      expiresAt: assessment.expiresAt,
      authorityContext: assessment.authorityContext!,
    })
    assert.equal(
      promptHook(authority, `取消 ${codeA}`).kind,
      'flowit-proposal-cancelled',
    )

    const proposalB = 'e'.repeat(64)
    const codeB = confirmationCodeForProposalHash(proposalB)
    authority.registerProposalConfirmation({
      proposalHash: proposalB,
      confirmationCode: codeB,
      expiresAt: assessment.expiresAt,
      authorityContext: assessment.authorityContext!,
    })
    assert.equal(promptHook(authority, '这是另一个新任务').kind, 'flowit-task-authority')
    assert.equal(
      promptHook(authority, `确认执行 ${codeB}`).kind,
      'flowit-proposal-confirmation-rejected',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function runNode(program: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', program],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`authority secret child exited ${code}: ${stderr.trim()}`))
    })
  })
}
