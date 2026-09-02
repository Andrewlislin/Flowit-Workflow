from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


# Fix the public Codex permission facade.
public_path = Path("packages/adapter-codex/src/public.ts")
public = public_path.read_text()
public = replace_once(
    public,
    "import { AgentExecutionError } from '@coaseedgeltd/flowit-core'\n",
    "import path from 'node:path'\nimport { AgentExecutionError } from '@coaseedgeltd/flowit-core'\n",
    "public path import",
)
if "CodexAdapterPermissionEvidence" in public:
    raise SystemExit("public permission evidence was already renamed")
if public.count("CodexPermissionEvidence") < 8:
    raise SystemExit("public permission evidence occurrences are unexpectedly low")
public = public.replace("CodexPermissionEvidence", "CodexAdapterPermissionEvidence")
public = replace_once(
    public,
    "  readonly scope: 'run'\n  readonly sandboxMode: 'read-only' | 'workspace-write'\n",
    "  readonly scope: 'run'\n  readonly dedicatedCwd: string\n  readonly sandboxMode: 'read-only' | 'workspace-write'\n",
    "adapter evidence dedicated cwd",
)
if public.count("this.executableCandidates(") != 2:
    raise SystemExit("unexpected executableCandidates call count")
public = public.replace(
    "this.executableCandidates(",
    "this.permissionExecutableCandidates(",
)
public = replace_once(
    public,
    "  private executableCandidates(preferred?: string): string[] {\n",
    "  private permissionExecutableCandidates(preferred?: string): string[] {\n",
    "private executable candidate method",
)
public = replace_once(
    public,
    "      assertHostPolicy(response, permissions, 'thread/start')\n      const runtime = runtimeFromHostResponse(response, request.requirement.runtime)\n",
    "      assertHostPolicy(response, permissions, 'thread/start')\n      const cwd = assertHostCwd(response, permissions, 'thread/start')\n      const runtime = runtimeFromHostResponse(response, request.requirement.runtime)\n",
    "thread start cwd verification",
)
public = replace_once(
    public,
    "        cwd: firstString(response?.cwd, thread?.cwd) ?? request.session.cwd,\n",
    "        cwd,\n",
    "provisioned session cwd",
)
public = replace_once(
    public,
    "    const resumedRuntime = runtimeFromHostResponse(resumed, request.execution?.runtime)\n    assertRuntimeMatch(request.execution?.runtime, resumedRuntime)\n    const cwd = firstString(resumed?.cwd, thread?.cwd) ?? this.flowitConfig.cwd ?? process.cwd()\n",
    "    const resumedRuntime = runtimeFromHostResponse(resumed, request.execution?.runtime)\n    assertRuntimeMatch(request.execution?.runtime, resumedRuntime)\n    const cwd = assertHostCwd(resumed, permissions, 'thread/resume')\n",
    "thread resume cwd verification",
)
public = replace_once(
    public,
    "    const cwd = descriptor.cwd ?? permissions.writableRoots[0] ?? this.flowitConfig.cwd ?? process.cwd()\n    await this.resolvePermissionSkills(\n",
    "    const cwd = assertHostCwd(snapshot, permissions, 'thread/read')\n    await this.resolvePermissionSkills(\n",
    "thread read cwd verification",
)

reroute_start = public.index("    const reroutes: ModelRerouteRecord[] = []\n")
reroute_end = public.index("    const snapshot = await prepared.client", reroute_start)
reroute_block = """    const reroutes: ModelRerouteRecord[] = []
    let activeTurnId: string | undefined
    let violationResolved = false
    let resolveViolation:
      | ((value: {
          error: AgentExecutionError
          interrupt: Promise<void>
        }) => void)
      | undefined
    const violationPromise = new Promise<{
      error: AgentExecutionError
      interrupt: Promise<void>
    }>(resolve => {
      resolveViolation = resolve
    })
    const signalExactRerouteViolation = (
      reroute: ModelRerouteRecord,
    ): void => {
      const requestedModel = request.execution?.runtime?.match === 'exact'
        ? request.execution.runtime.model
        : undefined
      const violatingTurnId = activeTurnId
      if (
        violationResolved ||
        !requestedModel ||
        !violatingTurnId ||
        reroute.turnId !== violatingTurnId ||
        reroute.toModel === requestedModel
      ) {
        return
      }
      violationResolved = true
      const error = new AgentExecutionError(
        'MODEL_UNAVAILABLE',
        `Codex rerouted exact model ${requestedModel} from ${reroute.fromModel} to ${reroute.toModel}`,
        false,
      )
      const interrupt = prepared.client
        .request(
          'turn/interrupt',
          { threadId: request.sessionId, turnId: violatingTurnId },
          undefined,
          5_000,
        )
        .then(
          () => undefined,
          () => undefined,
        )
      resolveViolation?.({ error, interrupt })
    }
    const stopReroutes = prepared.client.onNotification((method, params) => {
      if (method !== 'model/rerouted') return
      const reroute = parseModelReroute(params)
      if (reroute?.threadId !== request.sessionId) return
      reroutes.push(reroute)
      signalExactRerouteViolation(reroute)
    })
    let turnId: string | undefined
    let completion: any
    let interruptedForViolation = false
    try {
      const started = await prepared.client.request(
        'turn/start',
        {
          threadId: request.sessionId,
          input,
          approvalPolicy: 'never',
          sandboxPolicy: structuredClone(permissions.sandboxPolicy),
          ...(resumedRuntime.actualModel
            ? { model: resumedRuntime.actualModel }
            : {}),
          ...(resumedRuntime.actualReasoningEffort
            ? { effort: resumedRuntime.actualReasoningEffort }
            : {}),
        },
        signal,
        this.requestTimeoutMs,
      )
      turnId = firstString(started?.turn?.id, started?.id)
      if (!turnId) {
        throw new AgentExecutionError(
          'HOST_VERSION_INCOMPATIBLE',
          'Codex turn/start returned no turn id for the approved Session',
          false,
        )
      }
      activeTurnId = turnId
      for (const reroute of reroutes) signalExactRerouteViolation(reroute)
      const outcome = await Promise.race([
        prepared.client.waitFor(
          'turn/completed',
          params =>
            firstString(params?.threadId, params?.thread_id) === request.sessionId &&
            firstString(params?.turn?.id, params?.turnId) === turnId,
          signal,
          this.turnTimeoutMs,
        ).then(value => ({ kind: 'completed' as const, value })),
        violationPromise.then(value => ({
          kind: 'contract-violation' as const,
          value,
        })),
      ])
      if (outcome.kind === 'contract-violation') {
        interruptedForViolation = true
        await outcome.value.interrupt
        throw outcome.value.error
      }
      completion = outcome.value
      assertSuccessfulTurn(completion?.turn, request.sessionId, turnId)
    } catch (error: unknown) {
      if (turnId && !interruptedForViolation) {
        await prepared.client
          .request(
            'turn/interrupt',
            { threadId: request.sessionId, turnId },
            undefined,
            5_000,
          )
          .catch(() => undefined)
      }
      throw contextualizeProtocolError(error, 'Codex approved turn failed')
    } finally {
      stopReroutes()
    }

    const runtime = runtimeAfterReroutes(
      resumedRuntime,
      request.execution?.runtime,
      reroutes.filter(row => row.turnId === turnId),
    )
    assertRuntimeMatch(request.execution?.runtime, runtime)
"""
public = public[:reroute_start] + reroute_block + public[reroute_end:]
public = replace_once(
    public,
    "  if (expected.type === 'workspaceWrite') {\n",
    "  if (actual.networkAccess !== expected.networkAccess) {\n    throw new AgentExecutionError(\n      'PERMISSION_UNAVAILABLE',\n      `${operation} returned networkAccess ${JSON.stringify(actual.networkAccess)} instead of ${expected.networkAccess}`,\n      false,\n    )\n  }\n  if (expected.type === 'workspaceWrite') {\n",
    "read only network verification",
)
public = replace_once(
    public,
    "}\n\nasync function resolveRuntime(\n",
    "}\n\nfunction assertHostCwd(\n  response: any,\n  permissions: CodexAdapterPermissionEvidence,\n  operation: string,\n): string {\n  const reported = firstString(response?.cwd, response?.thread?.cwd)\n  if (!reported) {\n    throw new AgentExecutionError(\n      'HOST_VERSION_INCOMPATIBLE',\n      `${operation} did not report the active Codex working directory`,\n      false,\n    )\n  }\n  const actual = path.resolve(reported)\n  const expected = path.resolve(permissions.dedicatedCwd)\n  if (actual !== expected) {\n    throw new AgentExecutionError(\n      'PERMISSION_UNAVAILABLE',\n      `${operation} returned working directory ${JSON.stringify(actual)} instead of approved dedicatedCwd ${JSON.stringify(expected)}`,\n      false,\n    )\n  }\n  return actual\n}\n\nasync function resolveRuntime(\n",
    "host cwd verifier",
)
public_path.write_text(public)


# Bind permission evidence to the approved dedicated working directory and fix
# stale envelope field references that were hidden behind the package build error.
grant_path = Path("src/execution-grant.ts")
grant = grant_path.read_text()
grant = replace_once(
    grant,
    "  readonly scope: 'run'\n  readonly sandboxMode: CodexSandboxMode\n",
    "  readonly scope: 'run'\n  readonly dedicatedCwd: string\n  readonly sandboxMode: CodexSandboxMode\n",
    "grant evidence dedicated cwd",
)
if grant.count("envelope.networkAccess") != 2:
    raise SystemExit("unexpected stale envelope.networkAccess count")
grant = grant.replace(
    "envelope.networkAccess",
    "envelope.sandboxPolicy.networkAccess",
)
grant = replace_once(
    grant,
    "    source: payload.source,\n    scope: 'run',\n    sandboxMode: envelope.sandboxMode,\n",
    "    source: payload.source,\n    scope: 'run',\n    dedicatedCwd: envelope.dedicatedCwd,\n    sandboxMode: envelope.sandboxMode,\n",
    "issued evidence dedicated cwd",
)
grant_path.write_text(grant)


# Keep normalized execution values assignable to the mutable Core contract and
# reject provisioned/recovered Sessions whose Host cwd differs from the approved
# dedicated workspace.
run_path = Path("src/explicit-run-once.ts")
run = run_path.read_text()
run = replace_once(
    run,
    "  AgentExecutionRequirement,\n  AgentRuntimeRequirement,\n  AgentSessionDescriptor,\n",
    "  AgentExecutionRequirement,\n  AgentSessionDescriptor,\n",
    "remove redundant runtime import",
)
run = replace_once(
    run,
    "    readonly skills: readonly string[]\n    readonly execution?: {\n      readonly runtime?: AgentRuntimeRequirement\n      readonly requiredCapabilities?: readonly AgentExecutionCapability[]\n    }\n",
    "    readonly skills: readonly string[]\n    readonly execution?: AgentExecutionRequirement\n",
    "normalized execution contract",
)
run = replace_once(
    run,
    "  if (!provisioned) throw new Error('provisioned intent has no Host Session evidence')\n  const sessionId = requiredString(\n",
    "  if (!provisioned) throw new Error('provisioned intent has no Host Session evidence')\n  assertProvisionedSessionCwd(provisioned.session, plan)\n  const sessionId = requiredString(\n",
    "journaled cwd admission check",
)
run = replace_once(
    run,
    "  requiredString(session.sessionId, 'provisioned Session id')\n  if (session.status === 'ended' || session.status === 'unknown') {\n",
    "  requiredString(session.sessionId, 'provisioned Session id')\n  assertProvisionedSessionCwd(session, plan)\n  if (session.status === 'ended' || session.status === 'unknown') {\n",
    "fresh provision cwd check",
)
run = replace_once(
    run,
    "}\n\nfunction assertIntentMatchesPlan(\n",
    "}\n\nfunction assertProvisionedSessionCwd(\n  session: AgentSessionDescriptor,\n  plan: ExplicitRunOncePlan,\n): void {\n  const actual = path.resolve(requiredString(\n    session.cwd,\n    'provisioned Session working directory',\n  ))\n  const expected = plan.input.target.dedicatedCwd\n  if (actual !== expected) {\n    throw permissionError(\n      `provisioned Session working directory ${JSON.stringify(actual)} differs from approved dedicatedCwd ${JSON.stringify(expected)}`,\n    )\n  }\n}\n\nfunction assertIntentMatchesPlan(\n",
    "provisioned cwd helper",
)
run_path.write_text(run)


# Replace the stale permission contract test with the APIs and invariants that
# the implementation actually exposes.
contract_path = Path("tests/contracts/codex-permission-envelope.test.ts")
contract_path.write_text(r"""import assert from 'node:assert/strict'
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
""")


# Add direct Core-level regressions for fresh and journaled Session cwd drift.
cwd_test_path = Path("tests/explicit-run-once-cwd.test.ts")
cwd_test_path.write_text(r"""import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {
  AgentAdapter,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentExecutionPreflightRequest,
  AgentExecutionPreflightResult,
  AgentSessionDescriptor,
  ProvisionedAgentSession,
  SessionProvisioningIntent,
} from '../src/core/types.js'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import {
  planExplicitRunOnce,
  startExplicitRunOnce,
  type ExplicitRunOnceInput,
} from '../src/explicit-run-once.js'

class CwdDriftAdapter implements AgentAdapter {
  readonly id = 'codex'
  readonly capabilities = {
    coldResume: true,
    liveDispatch: false,
    skillBinding: true,
    contextReference: 'summary' as const,
    eventSubscription: false,
    executionPreflight: true,
    sessionProvisioning: 'dedicated' as const,
    runtimeSelection: 'turn' as const,
    runtimeIntrospection: true,
    lockInspection: true,
  }
  releaseCount = 0
  dispatchCount = 0

  constructor(private readonly returnedCwd: string) {}

  async listSessions(): Promise<AgentSessionDescriptor[]> {
    return []
  }

  async preflightExecution(
    request: AgentExecutionPreflightRequest,
  ): Promise<AgentExecutionPreflightResult> {
    return {
      status: 'ready',
      evidence: {
        host: { executable: 'cwd-drift-adapter' },
        runtime: { verified: false },
        session: {
          strategy: request.session.kind,
          exclusive: request.session.kind === 'dedicated',
        },
      },
      blockers: [],
    }
  }

  async provisionSession(
    request: AgentExecutionPreflightRequest,
  ): Promise<ProvisionedAgentSession> {
    if (request.session.kind !== 'dedicated') {
      throw new Error('expected dedicated Session plan')
    }
    return {
      session: {
        adapterId: this.id,
        sessionId: 'cwd-drift-session',
        cwd: this.returnedCwd,
        status: 'idle',
      },
      managed: true,
      evidence: {
        host: { executable: 'cwd-drift-adapter' },
        runtime: { verified: false },
        session: {
          strategy: 'dedicated',
          sessionId: 'cwd-drift-session',
          exclusive: true,
        },
      },
    }
  }

  async releaseSession(): Promise<void> {
    this.releaseCount += 1
  }

  async dispatch(_request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.dispatchCount += 1
    throw new Error('cwd drift must be rejected before dispatch')
  }
}

function input(cwd: string, requestId: string): ExplicitRunOnceInput {
  return {
    requestId,
    name: 'Dedicated cwd contract',
    goal: 'Run only in the user-approved dedicated working directory.',
    target: {
      adapterId: 'codex',
      dedicatedCwd: cwd,
    },
    steps: [
      { id: 'work', prompt: 'perform bounded work' },
      { id: 'review', prompt: 'review bounded work' },
    ],
  }
}

async function coreWith(
  root: string,
  adapter: CwdDriftAdapter,
): Promise<FlowitOrchestrationCore> {
  const core = new FlowitOrchestrationCore(
    {
      storageFile: path.join(root, 'workflow.json'),
      defaultAdapterId: adapter.id,
      activeWorkers: false,
      retryDelayMs: 5,
    },
    [adapter],
  )
  await core.ready
  return core
}

test('fresh dedicated Session cwd drift is released before run admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-explicit-cwd-fresh-'))
  const approved = path.join(root, 'approved')
  const adapter = new CwdDriftAdapter(path.join(root, 'different'))
  const core = await coreWith(root, adapter)
  try {
    await assert.rejects(
      startExplicitRunOnce(core, input(approved, 'fresh-cwd-drift')),
      /working directory.*differs|dedicatedCwd/i,
    )
    const state = await core.store.snapshot()
    assert.equal(adapter.releaseCount, 1)
    assert.equal(adapter.dispatchCount, 0)
    assert.equal(state.runs.length, 0)
    assert.equal(state.provisioningIntents.length, 0)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('journaled provisioned Session cwd drift cannot be admitted after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-explicit-cwd-recovery-'))
  const approved = path.join(root, 'approved')
  const adapter = new CwdDriftAdapter(approved)
  const core = await coreWith(root, adapter)
  try {
    const request = input(approved, 'journaled-cwd-drift')
    const plan = planExplicitRunOnce(request)
    const now = new Date().toISOString()
    const intent: SessionProvisioningIntent = {
      id: plan.intentId,
      definitionId: plan.definitionId,
      triggerKey: plan.triggerKey,
      adapterId: 'codex',
      sessionPlan: structuredClone(plan.preflight.session) as Extract<
        AgentExecutionPreflightRequest['session'],
        { kind: 'dedicated' }
      >,
      requirement: structuredClone(plan.preflight.requirement),
      skills: [...plan.preflight.skills],
      pipelineSnapshot: structuredClone(plan.snapshot),
      status: 'provisioned',
      createdAt: now,
      updatedAt: now,
      provisioned: {
        session: {
          adapterId: 'codex',
          sessionId: 'journaled-cwd-drift-session',
          cwd: path.join(root, 'different'),
          status: 'idle',
        },
        managed: true,
        evidence: {
          host: { executable: 'cwd-drift-adapter' },
          runtime: { verified: false },
          session: {
            strategy: 'dedicated',
            sessionId: 'journaled-cwd-drift-session',
            exclusive: true,
          },
        },
      },
    }
    assert.equal((await core.store.reserveProvisioningIntent(intent)).created, true)

    await assert.rejects(
      startExplicitRunOnce(core, request),
      /working directory.*differs|dedicatedCwd/i,
    )
    const state = await core.store.snapshot()
    assert.equal(adapter.dispatchCount, 0)
    assert.equal(state.runs.length, 0)
    assert.equal(state.provisioningIntents.length, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
""")


docs_path = Path("docs/codex-permissions.md")
docs = docs_path.read_text()
docs = replace_once(
    docs,
    "Every `turn/start` repeats the full bounded `sandboxPolicy`; later Pipeline nodes cannot silently drift to another permission profile.\n",
    "Every `turn/start` repeats the full bounded `sandboxPolicy`; later Pipeline nodes cannot silently drift to another permission profile.\n\nFor both `readOnly` and `workspaceWrite`, `networkAccess` is an exact field: a Host response that is either broader or narrower than the approved value is rejected. `thread/start`, `thread/read`, and `thread/resume` must also report the exact approved `dedicatedCwd` before Skills are resolved or a turn begins. If an exact model is rerouted, Flowit immediately interrupts that specific turn rather than waiting for the replacement model to finish and applying a post-hoc error.\n",
    "permission enforcement documentation",
)
docs_path.write_text(docs)
