import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { handleClaudeRoutingHook } from '../src/claude-routing-hook.js'
import {
  RoutingAuthorityService,
  type RoutingWorkflowToolName,
} from '../src/routing/index.js'

const SECRET = 'routing-test-secret-that-is-at-least-32-bytes-long'
const PLUGIN_PREFIX = 'mcp__plugin_flowit-workflow_orchestration__'
const STANDALONE_PREFIX = 'mcp__orchestration__'
const TOOLS: readonly RoutingWorkflowToolName[] = [
  'workflow_assess',
  'workflow_prepare',
  'workflow_commit',
]

test('Claude plugin-scoped adaptive MCP tools receive caller attestation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-plugin-tool-scope-'))
  try {
    const authority = new RoutingAuthorityService({
      mode: 'suggest',
      secret: SECRET,
      stateFile: path.join(root, 'authority.json'),
      requireCallerAttestation: true,
    })

    for (const toolName of TOOLS) {
      const toolInput = { marker: toolName }
      const toolUseId = `${toolName}-plugin-use`
      const output = handleClaudeRoutingHook({
        session_id: 'plugin-session',
        hook_event_name: 'PreToolUse',
        tool_name: `${PLUGIN_PREFIX}${toolName}`,
        tool_input: toolInput,
        tool_use_id: toolUseId,
      }, authority)
      const hook = output.hookSpecificOutput
      assert.equal(hook?.hookEventName, 'PreToolUse')
      assert.equal(
        hook?.permissionDecision,
        toolName === 'workflow_commit' ? 'ask' : 'allow',
      )
      const callerToken = hook?.updatedInput?.callerToken
      assert.equal(typeof callerToken, 'string')
      const caller = authority.consumeCallerAttestation(
        callerToken as string,
        { toolName, toolInput },
      )
      assert.equal(caller.hostSessionId, 'plugin-session')
      assert.equal(caller.toolUseId, toolUseId)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone MCP tool names remain supported for development installs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-standalone-tool-scope-'))
  try {
    const authority = new RoutingAuthorityService({
      mode: 'suggest',
      secret: SECRET,
      stateFile: path.join(root, 'authority.json'),
      requireCallerAttestation: true,
    })
    const toolInput = { task: 'inspect the repository' }
    const output = handleClaudeRoutingHook({
      session_id: 'standalone-session',
      hook_event_name: 'PreToolUse',
      tool_name: `${STANDALONE_PREFIX}workflow_assess`,
      tool_input: toolInput,
      tool_use_id: 'standalone-use',
    }, authority)
    assert.equal(typeof output.hookSpecificOutput?.updatedInput?.callerToken, 'string')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
