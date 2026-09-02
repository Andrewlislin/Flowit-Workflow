import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CodexAgentAdapter,
  type CodexAdapterPermissionEvidence,
} from '../../src/adapters/codex.js'
import { isAgentExecutionError } from '../../src/core/index.js'
import {
  ExecutionGrantService,
  permissionEnvelopeForPlan,
} from '../../src/execution-grant.js'
import {
  planExplicitRunOnce,
  type ExplicitRunOnceInput,
} from '../../src/explicit-run-once.js'

const SECRET = 'codex-permission-contract-secret-at-least-32-bytes'

function explicitInput(
  cwd: string,
  capabilities: Array<'workspace-read' | 'workspace-write' | 'network'>,
): ExplicitRunOnceInput {
  return {
    requestId: `contract-${capabilities.join('-') || 'none'}`,
    name: 'Codex permission contract',
    goal: 'Verify exact sandbox, working directory, and runtime enforcement.',
    target: {
      adapterId: 'codex',
      dedicatedCwd: cwd,
      execution: { requiredCapabilities: capabilities },
    },
    steps: [
      { id: 'work', prompt: 'perform bounded work' },
      { id: 'review', prompt: 'review bounded work' },
    ],
  }
}

function permissionEvidence(
  cwd: string,
  networkAccess: boolean,
  writable = false,
): CodexAdapterPermissionEvidence {
  const capabilities = writable
    ? networkAccess
      ? ['network', 'workspace-read', 'workspace-write'] as const
      : ['workspace-read', 'workspace-write'] as const
    : networkAccess
      ? ['network', 'workspace-read'] as const
      : ['workspace-read'] as const
  const sandboxPolicy = writable
    ? {
        type: 'workspaceWrite' as const,
        writableRoots: [path.resolve(cwd)],
        networkAccess,
        excludeTmpdirEnvVar: true as const,
        excludeSlashTmp: true as const,
      }
    : {
        type: 'readOnly' as const,
        networkAccess,
      }
  return {
    requestedCapabilities: [...capabilities],
    grantedCapabilities: [...capabilities],
    source: 'mcp-elicitation',
    scope: 'run',
    dedicatedCwd: path.resolve(cwd),
    sandboxMode: writable ? 'workspace-write' : 'read-only',
    sandboxPolicy,
    approvalPolicy: 'never',
    networkAccess,
    writableRoots: writable ? [path.resolve(cwd)] : [],
    grantDigest: 'a'.repeat(64),
    verified: true,
  }
}

interface FakeOptions {
  readonly hostCwd: string
  readonly networkAccess: boolean
  readonly reroute?: boolean
  readonly completionDelayMs?: number
  readonly name: string
}

async function fakeCodex(
  root: string,
  options: FakeOptions,
): Promise<{ executable: string; marker: string }> {
  const executable = path.join(root, options.name)
  const marker = path.join(root, `${options.name}.jsonl`)
  const models = [
    {
      id: 'picker-a',
      model: 'model-a',
      isDefault: true,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    },
    {
      id: 'picker-b',
      model: 'model-b',
      isDefault: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    },
  ]
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const marker = ${JSON.stringify(marker)};
const hostCwd = ${JSON.stringify(path.resolve(options.hostCwd))};
const hostNetwork = ${JSON.stringify(options.networkAccess)};
const reroute = ${JSON.stringify(options.reroute === true)};
const completionDelayMs = ${JSON.stringify(options.completionDelayMs ?? 0)};
const models = ${JSON.stringify(models)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (name, params) => fs.appendFileSync(marker, JSON.stringify({ name, params }) + '\\n');
const sandbox = params => {
  if (params && params.sandbox === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: [hostCwd],
      networkAccess: hostNetwork,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
  }
  return { type: 'readOnly', networkAccess: hostNetwork };
};
let turn = 0;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({ id: msg.id, result: { userAgent: 'codex-permission-contract/1', protocolVersion: 'v2' } });
  if (msg.method === 'model/list') return send({ id: msg.id, result: { data: models, nextCursor: null } });
  if (msg.method === 'skills/list') return send({ id: msg.id, result: { data: [] } });
  if (msg.method === 'thread/start') {
    record('thread/start', msg.params);
    const effort = msg.params && msg.params.config && msg.params.config.model_reasoning_effort;
    return send({ id: msg.id, result: {
      thread: { id: 'managed-1', status: 'idle', cwd: hostCwd },
      cwd: hostCwd,
      model: msg.params && msg.params.model,
      reasoningEffort: effort,
      approvalPolicy: 'never',
      sandbox: sandbox(msg.params),
    } });
  }
  if (msg.method === 'thread/read') {
    record('thread/read', msg.params);
    return send({ id: msg.id, result: {
      thread: { id: msg.params.threadId, status: 'idle', cwd: hostCwd },
      cwd: hostCwd,
      turns: [],
    } });
  }
  if (msg.method === 'thread/resume') {
    record('thread/resume', msg.params);
    const effort = msg.params && msg.params.config && msg.params.config.model_reasoning_effort;
    return send({ id: msg.id, result: {
      thread: { id: msg.params.threadId, status: 'idle', cwd: hostCwd },
      cwd: hostCwd,
      model: msg.params && msg.params.model,
      reasoningEffort: effort,
      approvalPolicy: 'never',
      sandbox: sandbox(msg.params),
    } });
  }
  if (msg.method === 'turn/start') {
    record('turn/start', msg.params);
    const turnId = 'turn-' + (++turn);
    send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    if (reroute) {
      const event = { threadId: msg.params.threadId, turnId, fromModel: 'model-a', toModel: 'model-b' };
      record('model/rerouted', event);
      send({ method: 'model/rerouted', params: event });
      return setTimeout(() => {
        const completed = { threadId: msg.params.threadId, turn: { id: turnId, status: 'completed', error: null } };
        record('turn/completed', completed);
        send({ method: 'turn/completed', params: completed });
      }, completionDelayMs);
    }
    const completed = { threadId: msg.params.threadId, turn: { id: turnId, status: 'completed', error: null } };
    record('turn/completed', completed);
    return send({ method: 'turn/completed', params: completed });
  }
  if (msg.method === 'turn/interrupt') {
    record('turn/interrupt', msg.params);
    return send({ id: msg.id, result: {} });
  }
  if (msg.method === 'thread/archive') {
    record('thread/archive', msg.params);
    return send({ id: msg.id, result: {} });
  }
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return { executable, marker }
}

async function recorded(marker: string): Promise<Array<{ name: string; params: any }>> {
  const value = await readFile(marker, 'utf8').catch(() => '')
  return value.trim()
    ? value.trim().split('\n').map(line => JSON.parse(line) as { name: string; params: any })
    : []
}

function permissionError(error: unknown): true {
  assert.ok(isAgentExecutionError(error))
  assert.equal(error.code, 'PERMISSION_UNAVAILABLE')
  assert.equal(error.retryable, false)
  return true
}

test('permission envelope and signed evidence use the current exact contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-permission-envelope-contract-'))
  try {
    const plan = planExplicitRunOnce(
      explicitInput(root, ['workspace-write', 'network']),
    )
    const envelope = permissionEnvelopeForPlan(plan)
    assert.equal(envelope.sandboxMode, 'workspace-write')
    assert.equal(envelope.sandboxPolicy.type, 'workspaceWrite')
    assert.equal(envelope.sandboxPolicy.networkAccess, true)
    assert.deepEqual(
      envelope.sandboxPolicy.type === 'workspaceWrite'
        ? envelope.sandboxPolicy.writableRoots
        : [],
      [path.resolve(root)],
    )

    const service = new ExecutionGrantService({
      directory: path.join(root, 'authority'),
      secret: SECRET,
    })
    const evidence = service.issuePlanGrant(plan, 'mcp-elicitation')
    assert.equal(evidence.dedicatedCwd, path.resolve(root))
    assert.equal(evidence.networkAccess, true)
    assert.deepEqual(evidence.writableRoots, [path.resolve(root)])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('read-only policy verification rejects network drift in both directions', async () => {
  const scenarios = [
    { approved: false, actual: true, name: 'offline-to-online' },
    { approved: true, actual: false, name: 'online-to-offline' },
  ]
  for (const scenario of scenarios) {
    const root = await mkdtemp(path.join(os.tmpdir(), `flowit-${scenario.name}-`))
    const fake = await fakeCodex(root, {
      hostCwd: root,
      networkAccess: scenario.actual,
      name: scenario.name,
    })
    const adapter = new CodexAgentAdapter({
      executable: fake.executable,
      requestTimeoutMs: 5_000,
      permissionGrantVerifier: () => permissionEvidence(root, scenario.approved),
    })
    try {
      await assert.rejects(
        adapter.provisionSession({
          correlationId: scenario.name,
          session: { kind: 'dedicated', cwd: root },
          requirement: {
            requiredCapabilities: scenario.approved
              ? ['workspace-read', 'network']
              : ['workspace-read'],
          },
          skills: [],
        }),
        (error: unknown) => {
          permissionError(error)
          assert.match((error as Error).message, /networkAccess/i)
          return true
        },
      )
      const names = (await recorded(fake.marker)).map(row => row.name)
      assert.equal(names.includes('thread/archive'), true)
    } finally {
      await adapter.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('approved dedicated cwd is enforced on provisioning and existing-session reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-permission-cwd-'))
  const approved = path.join(root, 'approved')
  const different = path.join(root, 'different')
  const provisionFake = await fakeCodex(root, {
    hostCwd: different,
    networkAccess: false,
    name: 'provision-cwd-drift',
  })
  const provisionAdapter = new CodexAgentAdapter({
    executable: provisionFake.executable,
    requestTimeoutMs: 5_000,
    permissionGrantVerifier: () => permissionEvidence(approved, false),
  })
  try {
    await assert.rejects(
      provisionAdapter.provisionSession({
        correlationId: 'provision-cwd-drift',
        session: { kind: 'dedicated', cwd: approved },
        requirement: { requiredCapabilities: ['workspace-read'] },
        skills: [],
      }),
      (error: unknown) => {
        permissionError(error)
        assert.match((error as Error).message, /working directory|dedicatedCwd/i)
        return true
      },
    )
    assert.equal(
      (await recorded(provisionFake.marker)).some(row => row.name === 'thread/archive'),
      true,
    )
  } finally {
    await provisionAdapter.dispose()
  }

  const dispatchFake = await fakeCodex(root, {
    hostCwd: different,
    networkAccess: false,
    name: 'dispatch-cwd-drift',
  })
  const dispatchAdapter = new CodexAgentAdapter({
    executable: dispatchFake.executable,
    requestTimeoutMs: 5_000,
    permissionGrantVerifier: () => permissionEvidence(approved, false),
  })
  try {
    await assert.rejects(
      dispatchAdapter.dispatch({
        correlationId: 'dispatch-cwd-drift',
        sessionId: 'managed-1',
        prompt: 'perform bounded work',
        skills: [],
        contextRefs: [],
        execution: { requiredCapabilities: ['workspace-read'] },
      }),
      (error: unknown) => {
        permissionError(error)
        assert.match((error as Error).message, /working directory|dedicatedCwd/i)
        return true
      },
    )
    const names = (await recorded(dispatchFake.marker)).map(row => row.name)
    assert.equal(names.includes('thread/read'), true)
    assert.equal(names.includes('thread/resume'), false)
    assert.equal(names.includes('turn/start'), false)
  } finally {
    await dispatchAdapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('permission path interrupts an exact-model reroute before completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-permission-reroute-'))
  const fake = await fakeCodex(root, {
    hostCwd: root,
    networkAccess: false,
    reroute: true,
    completionDelayMs: 300,
    name: 'permission-exact-reroute',
  })
  const adapter = new CodexAgentAdapter({
    executable: fake.executable,
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 1_000,
    permissionGrantVerifier: () => permissionEvidence(root, false),
  })
  try {
    await assert.rejects(
      adapter.dispatch({
        correlationId: 'permission-exact-reroute',
        sessionId: 'managed-1',
        prompt: 'perform bounded work',
        skills: [],
        contextRefs: [],
        execution: {
          requiredCapabilities: ['workspace-read'],
          runtime: {
            model: 'model-a',
            reasoningEffort: 'high',
            match: 'exact',
          },
        },
      }),
      (error: unknown) => {
        assert.ok(isAgentExecutionError(error))
        assert.equal(error.code, 'MODEL_UNAVAILABLE')
        assert.equal(error.retryable, false)
        assert.match(error.message, /rerouted exact model model-a.*model-b/i)
        return true
      },
    )
    await new Promise(resolve => setTimeout(resolve, 25))
    const names = (await recorded(fake.marker)).map(row => row.name)
    const rerouteIndex = names.indexOf('model/rerouted')
    const interruptIndex = names.indexOf('turn/interrupt')
    const completedIndex = names.indexOf('turn/completed')
    assert.ok(rerouteIndex >= 0)
    assert.ok(interruptIndex > rerouteIndex)
    assert.ok(completedIndex === -1 || interruptIndex < completedIndex)
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
