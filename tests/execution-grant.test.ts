import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ExecutionGrantService,
  permissionEnvelopeForPlan,
} from '../src/execution-grant.js'
import {
  planExplicitRunOnce,
  type ExplicitRunOnceInput,
} from '../src/explicit-run-once.js'

const SECRET = 'execution-grant-test-secret-that-is-at-least-32-bytes-long'

function input(
  root: string,
  capabilities: ExplicitRunOnceInput['target']['execution'] extends infer _T
    ? Array<'workspace-read' | 'workspace-write' | 'network'>
    : never,
  requestId = 'permission-test',
): ExplicitRunOnceInput {
  return {
    requestId,
    name: 'Permission test',
    goal: 'Verify exact capability and workspace binding.',
    target: {
      adapterId: 'codex',
      dedicatedCwd: root,
      execution: {
        requiredCapabilities: capabilities,
      },
    },
    steps: [
      { id: 'work', prompt: 'perform bounded work' },
      { id: 'review', prompt: 'review bounded work' },
    ],
  }
}

test('permission envelopes map capabilities to the four bounded Codex policies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-envelope-'))
  try {
    const readOnly = permissionEnvelopeForPlan(
      planExplicitRunOnce(input(root, ['workspace-read'], 'read-only')),
    )
    assert.deepEqual(readOnly, {
      adapterId: 'codex',
      sandboxMode: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'never',
      capabilities: ['workspace-read'],
      dedicatedCwd: path.resolve(root),
    })

    const readNetwork = permissionEnvelopeForPlan(
      planExplicitRunOnce(input(root, ['network'], 'read-network')),
    )
    assert.deepEqual(readNetwork.capabilities, ['network', 'workspace-read'])
    assert.deepEqual(readNetwork.sandboxPolicy, {
      type: 'readOnly',
      networkAccess: true,
    })

    const writeOffline = permissionEnvelopeForPlan(
      planExplicitRunOnce(input(root, ['workspace-write'], 'write-offline')),
    )
    assert.deepEqual(writeOffline.capabilities, ['workspace-read', 'workspace-write'])
    assert.deepEqual(writeOffline.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [path.resolve(root)],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    })

    const writeNetwork = permissionEnvelopeForPlan(
      planExplicitRunOnce(
        input(root, ['workspace-write', 'network'], 'write-network'),
      ),
    )
    assert.deepEqual(
      writeNetwork.capabilities,
      ['network', 'workspace-read', 'workspace-write'],
    )
    assert.deepEqual(writeNetwork.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [path.resolve(root)],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('signed grants verify only the exact request, directory, capabilities, and correlation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-grant-'))
  try {
    const service = new ExecutionGrantService({
      directory: path.join(root, 'authority'),
      secret: SECRET,
      ttlMs: 60_000,
    })
    const plan = planExplicitRunOnce(
      input(root, ['workspace-write', 'network']),
    )
    const issued = service.issuePlanGrant(plan, 'mcp-elicitation')
    assert.equal(issued.verified, true)
    assert.equal(issued.source, 'mcp-elicitation')
    assert.deepEqual(
      issued.grantedCapabilities,
      ['network', 'workspace-read', 'workspace-write'],
    )
    assert.deepEqual(service.findValidPlanGrant(plan), issued)

    const dedicated = service.verifyCodexRequest(plan.preflight)
    assert.deepEqual(dedicated, issued)

    const node = plan.snapshot.nodes[0]
    assert.ok(node)
    const existing = service.verifyCodexRequest({
      correlationId:
        `run-once:${plan.definitionId}:${plan.triggerKey}:${node.id}`,
      session: { kind: 'existing', sessionId: 'dedicated-1' },
      requirement: structuredClone(plan.preflight.requirement),
    })
    assert.deepEqual(existing, issued)

    assert.throws(
      () => service.verifyCodexRequest({
        correlationId:
          `run-once:${plan.definitionId}:${plan.triggerKey}:${node.id}`,
        session: { kind: 'existing', sessionId: 'dedicated-1' },
        requirement: { requiredCapabilities: ['workspace-read'] },
      }),
      /does not match the requested capabilities/,
    )

    const changed = planExplicitRunOnce({
      ...input(root, ['workspace-write', 'network']),
      goal: 'A different goal must not reuse the old approval.',
    })
    assert.throws(
      () => service.findValidPlanGrant(changed),
      /already bound to different permission input/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('grant expiry and tampering fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-grant-expiry-'))
  let now = new Date('2026-09-01T00:00:00.000Z')
  try {
    const service = new ExecutionGrantService({
      directory: path.join(root, 'authority'),
      secret: SECRET,
      ttlMs: 1_000,
      now: () => now,
    })
    const plan = planExplicitRunOnce(input(root, ['network'], 'expiring'))
    service.issuePlanGrant(plan, 'mcp-elicitation')
    now = new Date('2026-09-01T00:00:02.000Z')
    assert.equal(service.findValidPlanGrant(plan), undefined)
    assert.throws(
      () => service.verifyCodexRequest(plan.preflight),
      /expired/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
