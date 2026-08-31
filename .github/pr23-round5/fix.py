from pathlib import Path

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one occurrence, found {count}: {old[:160]!r}")
    write(path, text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Public execution error taxonomy
# ---------------------------------------------------------------------------
replace_once(
    'packages/core/src/core/types.ts',
    "  | 'HOST_VERSION_INCOMPATIBLE'\n  | 'MODEL_UNAVAILABLE'\n",
    "  | 'HOST_VERSION_INCOMPATIBLE'\n  | 'HOST_UNAVAILABLE'\n  | 'MODEL_UNAVAILABLE'\n",
)

# ---------------------------------------------------------------------------
# Codex transient-vs-deterministic Host failure classification
# ---------------------------------------------------------------------------
replace_once(
    'packages/adapter-codex/src/index.ts',
    "import { AgentExecutionError } from '@coaseedgeltd/flowit-core'\n",
    "import { AgentExecutionError, isAgentExecutionError } from '@coaseedgeltd/flowit-core'\n",
)

replace_once(
    'packages/adapter-codex/src/index.ts',
    """    } catch (error: unknown) {
      const classified = classifyError(error)
      return blocked(
""",
    """    } catch (error: unknown) {
      signal?.throwIfAborted()
      const classified = classifyError(error)
      return blocked(
""",
)

old_select = """    validateRuntimeRequirement(runtimeRequirement)
    const errors: Error[] = []
    const inspect = runtimeRequirement?.match === 'exact' ||
      runtimeRequirement?.match === 'preferred'

    for (const executable of this.orderedExecutableCandidates(preferredExecutable)) {
      try {
        const client = await this.getOrCreateClient(executable, signal)
        const runtime = inspect
          ? await this.inspectRuntime(client, runtimeRequirement, executable, signal)
          : runtimeFromRequirement(runtimeRequirement, false)
        this.defaultExecutable ??= executable
        return { client, executable, runtime }
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }

    const capabilityErrors = errors.filter(
      (error): error is CodexCapabilityError => error instanceof CodexCapabilityError,
    )
    const runtimeError =
      capabilityErrors.find(error => error.code === 'REASONING_EFFORT_UNAVAILABLE') ??
      capabilityErrors.find(error => error.code === 'MODEL_UNAVAILABLE')
    if (runtimeError) throw runtimeError
    if (errors.length === 1) throw errors[0]
    const details = errors.map(error => error.message).filter(Boolean).join('; ')
    throw new AggregateError(
      errors,
      `no compatible Codex executable could start${details ? `: ${details}` : ''}`,
    )
"""
new_select = """    validateRuntimeRequirement(runtimeRequirement)
    const errors: CodexCapabilityError[] = []
    const inspect = runtimeRequirement?.match === 'exact' ||
      runtimeRequirement?.match === 'preferred'

    for (const executable of this.orderedExecutableCandidates(preferredExecutable)) {
      try {
        const client = await this.getOrCreateClient(executable, signal)
        const runtime = inspect
          ? await this.inspectRuntime(client, runtimeRequirement, executable, signal)
          : runtimeFromRequirement(runtimeRequirement, false)
        this.defaultExecutable ??= executable
        return { client, executable, runtime }
      } catch (error: unknown) {
        signal?.throwIfAborted()
        errors.push(classifyError(error))
      }
    }

    const details = errors.map(error => error.message).filter(Boolean).join('; ')
    if (errors.some(error => error.retryable)) {
      throw new CodexCapabilityError(
        'HOST_UNAVAILABLE',
        `no Codex executable is currently available${details ? `: ${details}` : ''}`,
        true,
      )
    }
    const runtimeError =
      errors.find(error => error.code === 'REASONING_EFFORT_UNAVAILABLE') ??
      errors.find(error => error.code === 'MODEL_UNAVAILABLE')
    if (runtimeError) throw runtimeError
    const deterministic =
      errors.find(error => error.code === 'HOST_VERSION_INCOMPATIBLE') ??
      errors.find(error => error.code === 'EXECUTABLE_UNAVAILABLE') ??
      errors[0]
    if (!deterministic) {
      throw new CodexCapabilityError(
        'HOST_UNAVAILABLE',
        'no Codex executable candidate was available',
        true,
      )
    }
    if (errors.length === 1) throw deterministic
    throw new CodexCapabilityError(
      deterministic.code,
      `no compatible Codex executable could start${details ? `: ${details}` : ''}`,
      false,
    )
"""
replace_once('packages/adapter-codex/src/index.ts', old_select, new_select)

old_thread_request = """    for (let page = 0; page < 1_000; page += 1) {
      const result = (await client.request(
        'thread/list',
        {
          limit: 200,
          ...(cursor ? { cursor } : {}),
        },
        signal,
      )) as any
      const pageRows = Array.isArray(result?.data) ? result.data : []
"""
new_thread_request = """    for (let page = 0; page < 1_000; page += 1) {
      let result: any
      try {
        result = await client.request(
          'thread/list',
          {
            limit: 200,
            ...(cursor ? { cursor } : {}),
          },
          signal,
        )
      } catch (error: unknown) {
        signal?.throwIfAborted()
        throw contextualizeCodexError(
          error,
          'Codex app-server cannot enumerate Sessions',
        )
      }
      const pageRows = Array.isArray(result?.data) ? result.data : []
"""
replace_once(
    'packages/adapter-codex/src/index.ts',
    old_thread_request,
    new_thread_request,
)

replace_once(
    'packages/adapter-codex/src/index.ts',
    """      } catch (error: unknown) {
        throw new CodexCapabilityError(
          'HOST_VERSION_INCOMPATIBLE',
          `Codex app-server ${executable} cannot enumerate models required for runtime preflight: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
""",
    """      } catch (error: unknown) {
        signal?.throwIfAborted()
        throw contextualizeCodexError(
          error,
          `Codex app-server ${executable} cannot enumerate models required for runtime preflight`,
        )
      }
""",
)

replace_once(
    'packages/adapter-codex/src/index.ts',
    """    if (!names.length) return []
    const result = (await client.request(
      'skills/list',
      { cwds: [cwd], forceReload: true },
      signal,
    )) as any
    const groups = Array.isArray(result?.data) ? result.data : []
""",
    """    if (!names.length) return []
    let result: any
    try {
      result = await client.request(
        'skills/list',
        { cwds: [cwd], forceReload: true },
        signal,
      )
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw contextualizeCodexError(
        error,
        `Codex app-server cannot enumerate Skills for ${cwd}`,
      )
    }
    const groups = Array.isArray(result?.data) ? result.data : []
""",
)

old_classify = """function classifyError(error: unknown): CodexCapabilityError {
  if (error instanceof CodexCapabilityError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/active writer|already.*writer|writer.*locked/i.test(message)) {
    return new CodexCapabilityError('SESSION_WRITER_LOCKED', message, true)
  }
  if (/ENOENT|spawn|not found/i.test(message)) {
    return new CodexCapabilityError('EXECUTABLE_UNAVAILABLE', message)
  }
  return new CodexCapabilityError('HOST_VERSION_INCOMPATIBLE', message)
}
"""
new_classify = """function classifyError(error: unknown): CodexCapabilityError {
  if (error instanceof CodexCapabilityError) return error
  if (isAgentExecutionError(error)) {
    return new CodexCapabilityError(error.code, error.message, error.retryable)
  }
  if (error instanceof AggregateError) {
    const errors = [...error.errors].map(item => classifyError(item))
    const details = errors.map(item => item.message).filter(Boolean).join('; ')
    if (errors.some(item => item.retryable)) {
      return new CodexCapabilityError(
        'HOST_UNAVAILABLE',
        error.message || details || 'Codex Host is temporarily unavailable',
        true,
      )
    }
    const deterministic =
      errors.find(item => item.code === 'REASONING_EFFORT_UNAVAILABLE') ??
      errors.find(item => item.code === 'MODEL_UNAVAILABLE') ??
      errors.find(item => item.code === 'HOST_VERSION_INCOMPATIBLE') ??
      errors.find(item => item.code === 'EXECUTABLE_UNAVAILABLE') ??
      errors[0]
    if (deterministic) {
      return new CodexCapabilityError(
        deterministic.code,
        error.message || details || deterministic.message,
        false,
      )
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined
  if (/active writer|already.*writer|writer.*locked/i.test(message)) {
    return new CodexCapabilityError('SESSION_WRITER_LOCKED', message, true)
  }
  if (
    code === 'ENOENT' ||
    /\\bENOENT\\b|spawn [^\\n]+(?:not found|ENOENT)|command not found|executable [^\\n]+ not found/i.test(message)
  ) {
    return new CodexCapabilityError('EXECUTABLE_UNAVAILABLE', message, false)
  }
  if (
    /\\bmethod\\b.*\\b(?:not found|unknown|unsupported)\\b|\\bunsupported\\b.*\\b(?:method|request|protocol)\\b|\\binvalid params\\b|\\bprotocol\\b.*\\b(?:mismatch|incompatible|unsupported)\\b|\\bJSON-RPC\\b.*\\b(?:invalid|unsupported)\\b/i.test(message)
  ) {
    return new CodexCapabilityError('HOST_VERSION_INCOMPATIBLE', message, false)
  }
  return new CodexCapabilityError('HOST_UNAVAILABLE', message, true)
}

function contextualizeCodexError(
  error: unknown,
  context: string,
): CodexCapabilityError {
  const classified = classifyError(error)
  return new CodexCapabilityError(
    classified.code,
    `${context}: ${classified.message}`,
    classified.retryable,
  )
}
"""
replace_once('packages/adapter-codex/src/index.ts', old_classify, new_classify)

# ---------------------------------------------------------------------------
# Core durability regression: retryable preflight failure must retry
# ---------------------------------------------------------------------------
replace_once(
    'tests/core-execution-contract.test.ts',
    "  dispatchError: Error | undefined\n  preflightMode:\n",
    "  dispatchError: Error | undefined\n  transientPreflightFailures = 0\n  preflightMode:\n",
)

replace_once(
    'tests/core-execution-contract.test.ts',
    """  ): Promise<AgentExecutionPreflightResult> {
    this.preflights.push(structuredClone(request))
    const verified = this.preflightMode !== 'unverified'
""",
    """  ): Promise<AgentExecutionPreflightResult> {
    this.preflights.push(structuredClone(request))
    if (this.transientPreflightFailures > 0) {
      this.transientPreflightFailures -= 1
      return {
        status: 'blocked',
        blockers: [{
          code: 'HOST_UNAVAILABLE',
          message: 'temporary Host timeout',
          retryable: true,
        }],
        evidence: {
          runtime: { verified: false },
          session: {
            strategy: request.session.kind,
            ...(request.session.kind === 'existing'
              ? { sessionId: request.session.sessionId }
              : {}),
          },
        },
      }
    }
    const verified = this.preflightMode !== 'unverified'
""",
)

retry_test = """
test('run-once retryable preflight failure retries and completes on attempt two', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-core-execution-retryable-'))
  const adapter = new ContractAdapter('retryable-execution-adapter', true)
  adapter.transientPreflightFailures = 1
  const definitionId = 'retryable-execution-run-once'
  const triggerKey = 'retryable-execution-trigger'
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: true,
    leaseDurationMs: 1_000,
    retryDelayMs: 250,
    maxPipelineAttempts: 3,
  }, [adapter])
  try {
    await core.ready
    const admitted = await core.runOncePipelines.startRunOnce({
      definitionId,
      triggerKey,
      snapshot: {
        version: 1,
        name: 'retryable execution run-once',
        nodes: [{
          id: 'work',
          target: target(adapter.id),
          inheritUpstreamContext: false,
        }],
        edges: [],
      },
    })
    assert.equal(admitted.status, 'accepted')
    assert.ok(admitted.runId)

    await waitUntil(async () =>
      (await core.runOncePipelines.getRun(admitted.runId!))?.status === 'retrying',
    )
    const retrying = await core.runOncePipelines.getRun(admitted.runId!)
    assert.equal(retrying?.attempt, 1)
    const afterFirstAttempt = await core.store.snapshot()
    assert.equal(afterFirstAttempt.terminalReceipts.some(receipt =>
      receipt.kind === 'pipeline' &&
      receipt.definitionId === definitionId &&
      receipt.triggerKey === triggerKey,
    ), false)

    await waitUntil(async () =>
      (await core.runOncePipelines.getRun(admitted.runId!))?.status === 'completed',
    5_000)
    const completed = await core.runOncePipelines.getRun(admitted.runId!)
    assert.equal(completed?.attempt, 2)
    assert.equal(adapter.preflights.length, 2)
    assert.equal(adapter.dispatches.length, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
"""
replace_once(
    'tests/core-execution-contract.test.ts',
    "\ntest('scheduled target execution cannot bypass Core execution preflight'",
    retry_test + "\ntest('scheduled target execution cannot bypass Core execution preflight'",
)

# ---------------------------------------------------------------------------
# Codex Host contract: timeout is retryable and recovery becomes ready
# ---------------------------------------------------------------------------
transient_codex_test = """
async function transientModelListCodex(root: string): Promise<string> {
  const executable = path.join(root, 'codex-transient-model-list')
  const rows = [model('picker-transient', 'transient-model', ['high'], true, 'high')]
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const models = ${JSON.stringify(rows)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
let modelListCalls = 0;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'transient-model-list'}});
  if (msg.method === 'model/list') {
    modelListCalls += 1;
    if (modelListCalls === 1) return;
    return send({id:msg.id,result:{data:models,nextCursor:null}});
  }
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return executable
}

test('Codex transient model-list timeout remains retryable and later preflight succeeds', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-transient-model-list-'))
  const adapter = new CodexAgentAdapter({
    executable: await transientModelListCodex(root),
    requestTimeoutMs: 50,
  })
  const request = {
    correlationId: 'transient-model-list',
    session: { kind: 'dedicated' as const, cwd: root },
    requirement: {
      runtime: {
        model: 'transient-model',
        reasoningEffort: 'high',
        match: 'exact' as const,
      },
    },
    skills: [],
  }
  try {
    const first = await adapter.preflightExecution(request)
    assert.equal(first.status, 'blocked')
    assert.equal(first.blockers[0]?.code, 'HOST_UNAVAILABLE')
    assert.equal(first.blockers[0]?.retryable, true)
    assert.match(first.blockers[0]?.message ?? '', /model\/list.*timed out/i)

    const second = await adapter.preflightExecution(request)
    assert.equal(second.status, 'ready')
    assert.equal(second.blockers.length, 0)
    assert.equal(second.evidence.runtime?.actualModel, 'transient-model')
    assert.equal(second.evidence.runtime?.actualReasoningEffort, 'high')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
"""
replace_once(
    'tests/contracts/codex-execution-preflight.test.ts',
    "\ntest('Codex capability requirements fail closed without permission evidence'",
    transient_codex_test + "\ntest('Codex capability requirements fail closed without permission evidence'",
)

# ---------------------------------------------------------------------------
# Documentation
# ---------------------------------------------------------------------------
replace_once(
    'docs/adapter-contract.md',
    "Adapters must return structured blockers such as `MODEL_UNAVAILABLE`, `SESSION_BUSY`, `SESSION_WRITER_LOCKED`, `PERMISSION_UNAVAILABLE` or `HOST_VERSION_INCOMPATIBLE`. Do not turn every preflight failure into an unclassified string.",
    "Adapters must return structured blockers such as `MODEL_UNAVAILABLE`, `SESSION_BUSY`, `SESSION_WRITER_LOCKED`, `PERMISSION_UNAVAILABLE`, `HOST_UNAVAILABLE` or `HOST_VERSION_INCOMPATIBLE`. `HOST_UNAVAILABLE` is retryable and covers transient timeout, disconnect, broken-pipe and App Server exit conditions; `HOST_VERSION_INCOMPATIBLE` is reserved for deterministic method, protocol or schema incompatibility. Do not turn every preflight failure into an unclassified string.",
)

replace_once(
    'docs/execution-preflight.md',
    "For Codex, the Adapter exhausts paginated `model/list` and `thread/list` results, uses `thread/start` for a dedicated Session, and sends explicit `model`/`effort` fields at the turn boundary. Exact requests disable provider fallback. Catalog selection is not reused as actual execution evidence: nullable `thread/start` / `thread/resume` runtime fields are validated independently. If `model/rerouted` moves an active exact-model turn away from the requested model, Flowit immediately requests `turn/interrupt` and raises a non-retryable execution-contract error; preferred and inherited execution record the final routed model.",
    "For Codex, the Adapter exhausts paginated `model/list` and `thread/list` results, uses `thread/start` for a dedicated Session, and sends explicit `model`/`effort` fields at the turn boundary. Exact requests disable provider fallback. Catalog selection is not reused as actual execution evidence: nullable `thread/start` / `thread/resume` runtime fields are validated independently. If `model/rerouted` moves an active exact-model turn away from the requested model, Flowit immediately requests `turn/interrupt` and raises a non-retryable execution-contract error; preferred and inherited execution record the final routed model. Transient App Server I/O failures are reported as retryable `HOST_UNAVAILABLE`, while deterministic method/protocol/schema mismatches remain non-retryable `HOST_VERSION_INCOMPATIBLE`.",
)

replace_once(
    'docs/releases/execution-preflight-pr.md',
    "- Durable runtimes dead-letter non-retryable execution-contract failures on the first attempt.",
    "- Durable runtimes dead-letter non-retryable execution-contract failures on the first attempt.\n- Transient Codex preflight timeouts, disconnects and App Server exits surface as retryable `HOST_UNAVAILABLE`; a later healthy attempt can complete without a premature terminal receipt.",
)

print('Applied PR #23 fifth-round transient retry classification fixes')
