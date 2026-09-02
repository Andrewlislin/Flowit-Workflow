import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

interface CodexSandboxContractFixture {
  readonly source: {
    readonly repository: string
    readonly tag: string
    readonly commit: string
  }
  readonly threadLifecycle: {
    readonly methods: readonly string[]
    readonly requestFields: readonly string[]
    readonly sandboxField: string
    readonly sandboxType: string
    readonly structuredSandboxPolicyField: null
    readonly readOnlyNetworkConfigField: null
    readonly workspaceWriteConfigField: string
    readonly readOnlyDefault: {
      readonly type: 'readOnly'
      readonly networkAccess: false
    }
  }
  readonly turnStart: {
    readonly method: 'turn/start'
    readonly structuredSandboxPolicyField: 'sandboxPolicy'
    readonly appliesTo: 'current-and-subsequent-turns'
  }
}

const CODEX_SANDBOX_CONTRACT = JSON.parse(readFileSync(
  new URL(
    '../fixtures/codex-app-server-v0.152.0-sandbox-contract.json',
    import.meta.url,
  ),
  'utf8',
)) as CodexSandboxContractFixture

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
  readonly readOnlyNetworkOverride?: boolean
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
const readOnlyNetworkOverride = ${JSON.stringify(options.readOnlyNetworkOverride)};
const reroute = ${JSON.stringify(options.reroute === true)};
const completionDelayMs = ${JSON.stringify(options.completionDelayMs ?? 0)};
const models = ${JSON.stringify(models)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (name, params) => fs.appendFileSync(marker, JSON.stringify({ name, params }) + '\\n');
const lifecycleSandbox = params => {
  if (params && params.sandbox === 'workspace-write') {
    const configured = params.config && params.config.sandbox_workspace_write;
    return {
      type: 'workspaceWrite',
      writableRoots: configured && Array.isArray(configured.writable_roots)
        ? configured.writable_roots
        : [],
      networkAccess: Boolean(configured && configured.network_access),
      excludeTmpdirEnvVar: Boolean(configured && configured.exclude_tmpdir_env_var),
      excludeSlashTmp: Boolean(configured && configured.exclude_slash_tmp),
    };
  }
  return {
    type: 'readOnly',
    networkAccess: readOnlyNetworkOverride === true,
  };
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
      sandbox: lifecycleSandbox(msg.params),
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
      sandbox: lifecycleSandbox(msg.params),
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

test('pinned Codex 0.152.0 schema separates lifecycle mode from turn policy', () => {
  assert.equal(CODEX_SANDBOX_CONTRACT.source.repository, 'openai/codex')
  assert.equal(CODEX_SANDBOX_CONTRACT.source.tag, 'rust-v0.152.0')
  assert.equal(
    CODEX_SANDBOX_CONTRACT.source.commit,
    '316795b3cf2a45e90d121d9f46499d4658b2645c',
  )
  assert.deepEqual(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.methods,
    ['thread/start', 'thread/resume'],
  )
  assert.deepEqual(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.requestFields,
    ['sandbox', 'config'],
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.structuredSandboxPolicyField,
    null,
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.readOnlyNetworkConfigField,
    null,
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.workspaceWriteConfigField,
    'sandbox_workspace_write',
  )
  assert.deepEqual(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.readOnlyDefault,
    { type: 'readOnly', networkAccess: false },
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.turnStart.structuredSandboxPolicyField,
    'sandboxPolicy',
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.turnStart.appliesTo,
    'current-and-subsequent-turns',
  )
})

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

test('offline read-only grant rejects a broader online lifecycle policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-offline-to-online-'))
  const fake = await fakeCodex(root, {
    hostCwd: root,
    readOnlyNetworkOverride: true,
    name: 'offline-to-online',
  })
  const adapter = new CodexAgentAdapter({
    executable: fake.executable,
    requestTimeoutMs: 5_000,
    permissionGrantVerifier: () => permissionEvidence(root, false),
  })
  try {
    await assert.rejects(
      adapter.provisionSession({
        correlationId: 'offline-to-online',
        session: { kind: 'dedicated', cwd: root },
        requirement: { requiredCapabilities: ['workspace-read'] },
        skills: [],
      }),
      (error: unknown) => {
        permissionError(error)
        assert.match((error as Error).message, /networkAccess|online/i)
        return true
      },
    )
    const names = (await recorded(fake.marker)).map(row => row.name)
    assert.equal(names.includes('thread/archive'), true)
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('online read-only grant accepts offline lifecycle bootstrap and starts an exact online turn', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-readonly-network-'))
  const fake = await fakeCodex(root, {
    hostCwd: root,
    name: 'read-only-network-lifecycle',
  })
  const adapter = new CodexAgentAdapter({
    executable: fake.executable,
    requestTimeoutMs: 5_000,
    permissionGrantVerifier: () => permissionEvidence(root, true),
  })
  try {
    const provisioned = await adapter.provisionSession({
      correlationId: 'read-only-network-provision',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        requiredCapabilities: ['workspace-read', 'network'],
      },
      skills: [],
    })
    await adapter.dispatch({
      correlationId: 'read-only-network-dispatch',
      sessionId: provisioned.session.sessionId,
      prompt: 'perform network-backed read-only research',
      skills: [],
      contextRefs: [],
      execution: {
        requiredCapabilities: ['workspace-read', 'network'],
      },
    })

    const rows = await recorded(fake.marker)
    const threadStart = rows.find(row => row.name === 'thread/start')
    const threadResume = rows.find(row => row.name === 'thread/resume')
    const turnStart = rows.find(row => row.name === 'turn/start')
    assert.ok(threadStart)
    assert.ok(threadResume)
    assert.ok(turnStart)

    for (const lifecycle of [threadStart, threadResume]) {
      assert.equal(lifecycle.params.sandbox, 'read-only')
      assert.equal(lifecycle.params.approvalPolicy, 'never')
      assert.equal('sandboxPolicy' in lifecycle.params, false)
      assert.equal(
        Boolean(lifecycle.params.config?.sandbox_workspace_write),
        false,
      )
    }
    assert.equal(turnStart.params.approvalPolicy, 'never')
    assert.deepEqual(
      turnStart.params.sandboxPolicy,
      { type: 'readOnly', networkAccess: true },
    )
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('approved dedicated cwd is enforced on provisioning and existing-session reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-permission-cwd-'))
  const approved = path.join(root, 'approved')
  const different = path.join(root, 'different')
  const provisionFake = await fakeCodex(root, {
    hostCwd: different,
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
