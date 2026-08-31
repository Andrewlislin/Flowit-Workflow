from pathlib import Path
import re

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


def regex_replace_once(path: str, pattern: str, replacement: str, flags: int = 0) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: regex expected one occurrence, found {count}: {pattern[:160]!r}")
    write(path, updated)


# ---------------------------------------------------------------------------
# Common Core execution error contract
# ---------------------------------------------------------------------------
execution_error = """import type { AgentExecutionBlockerCode } from './types.js'

const EXECUTION_ERROR_MARKER =
  '@coaseedgeltd/flowit-core/agent-execution-error'

export class AgentExecutionError extends Error {
  readonly executionErrorMarker = EXECUTION_ERROR_MARKER

  constructor(
    readonly code: AgentExecutionBlockerCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'AgentExecutionError'
  }
}

export function isAgentExecutionError(
  value: unknown,
): value is AgentExecutionError {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AgentExecutionError>
  return (
    candidate.executionErrorMarker === EXECUTION_ERROR_MARKER &&
    typeof candidate.code === 'string' &&
    typeof candidate.retryable === 'boolean'
  )
}

export function isNonRetryableExecutionError(value: unknown): boolean {
  return isAgentExecutionError(value) && value.retryable === false
}
"""
write('packages/core/src/core/execution-error.ts', execution_error)

replace_once(
    'packages/core/src/core/index.ts',
    "export * from './domain.js'\n",
    "export * from './domain.js'\nexport * from './execution-error.js'\n",
)

replace_once(
    'packages/core/src/core/domain.ts',
    "import { nonEmpty, normalizeStringList } from './utils.js'\n",
    "import { AgentExecutionError } from './execution-error.js'\n"
    "import { nonEmpty, normalizeStringList } from './utils.js'\n",
)

new_assert = """export function assertExecutionPreflightReady(
  adapterId: AdapterId,
  requirement: AgentExecutionRequirement | undefined,
  result: AgentExecutionPreflightResult,
): void {
  if (result.status !== 'ready' || result.blockers.length > 0) {
    const details = result.blockers.length
      ? result.blockers.map(item => `${item.code}: ${item.message}`).join('; ')
      : `status=${result.status}`
    const blocker =
      result.blockers.find(item => item.retryable === false) ??
      result.blockers[0]
    throw new AgentExecutionError(
      blocker?.code ?? 'UNSUPPORTED',
      `Adapter ${adapterId} execution preflight blocked: ${details}`,
      blocker?.retryable ?? false,
    )
  }
  const requested = requirement?.runtime
  if (requested?.match !== 'exact' && requested?.match !== 'preferred') return
  const actual = result.evidence.runtime
  if (actual?.verified !== true) {
    throw new AgentExecutionError(
      'HOST_VERSION_INCOMPATIBLE',
      `Adapter ${adapterId} execution preflight returned ready without verified runtime evidence`,
      false,
    )
  }
  if (requested.model) {
    if (!actual.actualModel) {
      throw new AgentExecutionError(
        'MODEL_UNAVAILABLE',
        `Adapter ${adapterId} execution preflight did not report an actual model for ${requested.match} model ${requested.model}`,
        false,
      )
    }
    if (requested.match === 'exact' && actual.actualModel !== requested.model) {
      throw new AgentExecutionError(
        'MODEL_UNAVAILABLE',
        `Adapter ${adapterId} execution preflight reported actual model ${actual.actualModel} instead of exact model ${requested.model}`,
        false,
      )
    }
  }
  if (requested.reasoningEffort) {
    if (!actual.actualReasoningEffort) {
      throw new AgentExecutionError(
        'REASONING_EFFORT_UNAVAILABLE',
        `Adapter ${adapterId} execution preflight did not report an actual reasoning effort for ${requested.match} effort ${requested.reasoningEffort}`,
        false,
      )
    }
    if (
      requested.match === 'exact' &&
      actual.actualReasoningEffort !== requested.reasoningEffort
    ) {
      throw new AgentExecutionError(
        'REASONING_EFFORT_UNAVAILABLE',
        `Adapter ${adapterId} execution preflight reported actual reasoning effort ${actual.actualReasoningEffort} instead of exact effort ${requested.reasoningEffort}`,
        false,
      )
    }
  }
}
"""
regex_replace_once(
    'packages/core/src/core/domain.ts',
    r"export function assertExecutionPreflightReady\([\s\S]*?\n}\n\nfunction normalizeRuntimeRequirement",
    new_assert + "\nfunction normalizeRuntimeRequirement",
)

replace_once(
    'packages/core/src/core/dispatcher.ts',
    "import { SkillBinder } from './skill-binding.js'\n",
    "import { SkillBinder } from './skill-binding.js'\n"
    "import { AgentExecutionError } from './execution-error.js'\n",
)
replace_once(
    'packages/core/src/core/dispatcher.ts',
    """          throw new Error(
            `Adapter ${adapterId} cannot verify the requested execution contract`,
          )
""",
    """          throw new AgentExecutionError(
            'UNSUPPORTED',
            `Adapter ${adapterId} cannot verify the requested execution contract`,
            false,
          )
""",
)

# ---------------------------------------------------------------------------
# Retry classification in durable runtimes
# ---------------------------------------------------------------------------
replace_once(
    'packages/core/src/core/run-once.ts',
    "import { predecessorIds, topologicalOrder } from './domain.js'\n",
    "import { predecessorIds, topologicalOrder } from './domain.js'\n"
    "import { isNonRetryableExecutionError } from './execution-error.js'\n",
)
replace_once(
    'packages/core/src/core/run-once.ts',
    """      const message = error instanceof Error ? error.message : String(error)
      if (running.attempt >= this.options.maxAttempts) {
""",
    """      const message = error instanceof Error ? error.message : String(error)
      const deadLetter =
        isNonRetryableExecutionError(error) ||
        running.attempt >= this.options.maxAttempts
      if (deadLetter) {
""",
)

replace_once(
    'packages/core/src/core/pipeline.ts',
    "import { startLeaseHeartbeat } from './lease.js'\n",
    "import { startLeaseHeartbeat } from './lease.js'\n"
    "import { isNonRetryableExecutionError } from './execution-error.js'\n",
)
replace_once(
    'packages/core/src/core/pipeline.ts',
    """    } catch (error: unknown) { const message = error instanceof Error ? error.message : String(error); try { await this.store.failRun(running.id, this.options.workerId, message, { retryDelayMs: this.options.retryDelayMs, deadLetter: running.attempt >= this.options.maxAttempts }) } catch {} throw error }
""",
    """    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const deadLetter =
        isNonRetryableExecutionError(error) ||
        running.attempt >= this.options.maxAttempts
      try {
        await this.store.failRun(
          running.id,
          this.options.workerId,
          message,
          { retryDelayMs: this.options.retryDelayMs, deadLetter },
        )
      } catch {}
      throw error
    }
""",
)

replace_once(
    'packages/core/src/core/scheduler.ts',
    "import { startLeaseHeartbeat } from './lease.js'\n",
    "import { startLeaseHeartbeat } from './lease.js'\n"
    "import { isNonRetryableExecutionError } from './execution-error.js'\n",
)
replace_once(
    'packages/core/src/core/scheduler.ts',
    """    catch (error: unknown) { const failedAt = new Date(); const message = error instanceof Error ? error.message : String(error); const deadLetter = claim.run.attempt >= this.options.maxAttempts; try { await this.store.failRun(claim.run.id, this.options.workerId, message, { retryDelayMs: this.options.retryDelayMs, deadLetter }, failedAt) } catch {} if (deadLetter) await this.settleOccurrence(task, scheduledAt, triggerKey, 'failed', failedAt) }
""",
    """    catch (error: unknown) {
      const failedAt = new Date()
      const message = error instanceof Error ? error.message : String(error)
      const deadLetter =
        isNonRetryableExecutionError(error) ||
        claim.run.attempt >= this.options.maxAttempts
      try {
        await this.store.failRun(
          claim.run.id,
          this.options.workerId,
          message,
          { retryDelayMs: this.options.retryDelayMs, deadLetter },
          failedAt,
        )
      } catch {}
      if (deadLetter) {
        await this.settleOccurrence(task, scheduledAt, triggerKey, 'failed', failedAt)
      }
    }
""",
)

# ---------------------------------------------------------------------------
# Codex: standard error type, immediate exact-reroute interrupt, thread paging
# ---------------------------------------------------------------------------
replace_once(
    'packages/adapter-codex/src/index.ts',
    "import { randomUUID } from 'node:crypto'\nimport type {\n",
    "import { randomUUID } from 'node:crypto'\n"
    "import { AgentExecutionError } from '@coaseedgeltd/flowit-core'\n"
    "import type {\n",
)

replace_once(
    'packages/adapter-codex/src/index.ts',
    """class CodexCapabilityError extends Error {
  constructor(
    readonly code: AgentExecutionBlockerCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}
""",
    """class CodexCapabilityError extends AgentExecutionError {
  constructor(
    code: AgentExecutionBlockerCode,
    message: string,
    retryable = false,
  ) {
    super(code, message, retryable)
    this.name = 'CodexCapabilityError'
  }
}
""",
)

replace_once(
    'packages/adapter-codex/src/index.ts',
    """  async listSessions(query = '', signal?: AbortSignal): Promise<AgentSessionDescriptor[]> {
    const selected = await this.selectClient(signal)
    const result = (await selected.client.request(
      'thread/list',
      { limit: 200 },
      signal,
    )) as any
    return descriptors(result, query)
  }
""",
    """  async listSessions(query = '', signal?: AbortSignal): Promise<AgentSessionDescriptor[]> {
    const selected = await this.selectClient(signal)
    return this.listSessionDescriptors(selected.client, query, signal)
  }
""",
)

replace_once(
    'packages/adapter-codex/src/index.ts',
    """      const existingSessionId = request.session.sessionId
      const result = (await selected.client.request(
        'thread/list',
        { limit: 200 },
        signal,
      )) as any
      const exact = descriptors(result, existingSessionId).filter(
        session => session.sessionId === existingSessionId,
      )
""",
    """      const existingSessionId = request.session.sessionId
      const exact = (
        await this.listSessionDescriptors(
          selected.client,
          existingSessionId,
          signal,
        )
      ).filter(session => session.sessionId === existingSessionId)
""",
)

old_reroute_block = """    const reroutes: ModelRerouteRecord[] = []
    const stopReroutes = selected.client.onNotification((method, params) => {
      if (method !== 'model/rerouted') return
      const reroute = parseModelReroute(params)
      if (reroute?.threadId === request.sessionId) reroutes.push(reroute)
    })
    let started: any
    try {
      started = await selected.client.request(
        'turn/start',
        {
          threadId: request.sessionId,
          input,
          ...(resumedRuntime.actualModel
            ? { model: resumedRuntime.actualModel }
            : {}),
          ...(resumedRuntime.actualReasoningEffort
            ? { effort: resumedRuntime.actualReasoningEffort }
            : {}),
        },
        signal,
      ) as any
    } catch (error) {
      stopReroutes()
      throw error
    }
    const turnId = String(started?.turn?.id ?? started?.id ?? '')
    if (!turnId) {
      stopReroutes()
      throw new Error('Codex turn/start returned no turn id')
    }
    let completion: any
    try {
      completion = await selected.client.waitFor(
        'turn/completed',
        params =>
          String(params?.threadId ?? params?.thread_id ?? '') === request.sessionId &&
          String(params?.turn?.id ?? params?.turnId ?? '') === turnId,
        signal,
        this.config.turnTimeoutMs,
      )
    } catch (error: unknown) {
      stopReroutes()
      await selected.client
        .request('turn/interrupt', { threadId: request.sessionId, turnId }, undefined, 5_000)
        .catch(() => undefined)
      throw error
    }
    stopReroutes()
    const turnReroutes = reroutes.filter(reroute => reroute.turnId === turnId)
"""
new_reroute_block = """    const reroutes: ModelRerouteRecord[] = []
    let activeTurnId: string | undefined
    let violationResolved = false
    let resolveViolation:
      | ((value: {
          error: CodexCapabilityError
          interrupt: Promise<void>
        }) => void)
      | undefined
    const violationPromise = new Promise<{
      error: CodexCapabilityError
      interrupt: Promise<void>
    }>(resolve => {
      resolveViolation = resolve
    })
    const signalExactRerouteViolation = (
      reroute: ModelRerouteRecord,
    ): void => {
      const requestedModel =
        runtimeRequirement?.match === 'exact'
          ? runtimeRequirement.model
          : undefined
      if (
        violationResolved ||
        !requestedModel ||
        !activeTurnId ||
        reroute.turnId !== activeTurnId ||
        reroute.toModel === requestedModel
      ) {
        return
      }
      violationResolved = true
      const error = new CodexCapabilityError(
        'MODEL_UNAVAILABLE',
        `Codex rerouted exact model ${requestedModel} from ${reroute.fromModel} to ${reroute.toModel}`,
      )
      const interrupt = selected.client
        .request(
          'turn/interrupt',
          { threadId: request.sessionId, turnId: activeTurnId },
          undefined,
          5_000,
        )
        .then(
          () => undefined,
          () => undefined,
        )
      resolveViolation?.({ error, interrupt })
    }
    const stopReroutes = selected.client.onNotification((method, params) => {
      if (method !== 'model/rerouted') return
      const reroute = parseModelReroute(params)
      if (reroute?.threadId !== request.sessionId) return
      reroutes.push(reroute)
      signalExactRerouteViolation(reroute)
    })
    let started: any
    try {
      started = await selected.client.request(
        'turn/start',
        {
          threadId: request.sessionId,
          input,
          ...(resumedRuntime.actualModel
            ? { model: resumedRuntime.actualModel }
            : {}),
          ...(resumedRuntime.actualReasoningEffort
            ? { effort: resumedRuntime.actualReasoningEffort }
            : {}),
        },
        signal,
      ) as any
    } catch (error) {
      stopReroutes()
      throw error
    }
    const turnId = String(started?.turn?.id ?? started?.id ?? '')
    if (!turnId) {
      stopReroutes()
      throw new Error('Codex turn/start returned no turn id')
    }
    activeTurnId = turnId
    for (const reroute of reroutes) signalExactRerouteViolation(reroute)
    let completion: any
    let interruptedForViolation = false
    try {
      const outcome = await Promise.race([
        selected.client.waitFor(
          'turn/completed',
          params =>
            String(params?.threadId ?? params?.thread_id ?? '') === request.sessionId &&
            String(params?.turn?.id ?? params?.turnId ?? '') === turnId,
          signal,
          this.config.turnTimeoutMs,
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
    } catch (error: unknown) {
      stopReroutes()
      if (!interruptedForViolation) {
        await selected.client
          .request(
            'turn/interrupt',
            { threadId: request.sessionId, turnId },
            undefined,
            5_000,
          )
          .catch(() => undefined)
      }
      throw error
    }
    stopReroutes()
    const turnReroutes = reroutes.filter(reroute => reroute.turnId === turnId)
"""
replace_once(
    'packages/adapter-codex/src/index.ts',
    old_reroute_block,
    new_reroute_block,
)

session_helper = """  private async listSessionDescriptors(
    client: CodexAppServerClient,
    query: string,
    signal?: AbortSignal,
  ): Promise<AgentSessionDescriptor[]> {
    const rows: any[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 1_000; page += 1) {
      const result = (await client.request(
        'thread/list',
        {
          limit: 200,
          ...(cursor ? { cursor } : {}),
        },
        signal,
      )) as any
      const pageRows = Array.isArray(result?.data) ? result.data : []
      rows.push(...pageRows)
      const nextCursor = firstString(result?.nextCursor, result?.next_cursor)
      if (!nextCursor) break
      if (seenCursors.has(nextCursor)) {
        throw new CodexCapabilityError(
          'HOST_VERSION_INCOMPATIBLE',
          `Codex app-server repeated thread/list cursor ${nextCursor}`,
        )
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
      if (page === 999) {
        throw new CodexCapabilityError(
          'HOST_VERSION_INCOMPATIBLE',
          'Codex app-server exceeded the thread catalog pagination limit',
        )
      }
    }
    return descriptors({ data: rows }, query)
  }

"""
replace_once(
    'packages/adapter-codex/src/index.ts',
    "  private async inspectRuntime(\n",
    session_helper + "  private async inspectRuntime(\n",
)

# ---------------------------------------------------------------------------
# Regression tests
# ---------------------------------------------------------------------------
replace_once(
    'tests/core-execution-contract.test.ts',
    "import { FlowitOrchestrationCore } from '../src/core/runtime.js'\n",
    "import { AgentExecutionError } from '../src/core/index.js'\n"
    "import { FlowitOrchestrationCore } from '../src/core/runtime.js'\n",
)
replace_once(
    'tests/core-execution-contract.test.ts',
    "  readonly preflights: AgentExecutionPreflightRequest[] = []\n",
    "  readonly preflights: AgentExecutionPreflightRequest[] = []\n"
    "  dispatchError: Error | undefined\n",
)
replace_once(
    'tests/core-execution-contract.test.ts',
    """  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.dispatches.push(structuredClone(request))
    return {
""",
    """  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.dispatches.push(structuredClone(request))
    if (this.dispatchError) throw this.dispatchError
    return {
""",
)
replace_once(
    'tests/core-execution-contract.test.ts',
    "    maxPipelineAttempts: 1,\n",
    "    maxPipelineAttempts: 3,\n",
)
replace_once(
    'tests/core-execution-contract.test.ts',
    """    await assert.rejects(core.pipelines.run(pipeline.id), /execution preflight blocked/)
    assert.equal(adapter.preflights.length, 1)
    assert.equal(adapter.dispatches.length, 0)
""",
    """    await assert.rejects(core.pipelines.run(pipeline.id), /execution preflight blocked/)
    assert.equal(adapter.preflights.length, 1)
    assert.equal(adapter.dispatches.length, 0)
    const run = (await core.store.snapshot()).runs.find(
      candidate => candidate.definitionId === pipeline.id,
    )
    assert.equal(run?.status, 'dead_letter')
    assert.equal(run?.attempt, 1)
""",
)
replace_once(
    'tests/core-execution-contract.test.ts',
    "    maxScheduleAttempts: 1,\n",
    "    maxScheduleAttempts: 3,\n",
)

run_once_test = """
test('run-once execution-contract failures dead-letter on the first attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-core-execution-run-once-'))
  const adapter = new ContractAdapter('run-once-contract-adapter', true)
  adapter.dispatchError = new AgentExecutionError(
    'MODEL_UNAVAILABLE',
    'exact model rerouted',
    false,
  )
  const core = new FlowitOrchestrationCore({
    storageFile: path.join(root, 'workflow.json'),
    defaultAdapterId: adapter.id,
    activeWorkers: true,
    leaseDurationMs: 1_000,
    retryDelayMs: 10,
    maxPipelineAttempts: 3,
  }, [adapter])
  try {
    await core.ready
    const admitted = await core.runOncePipelines.startRunOnce({
      definitionId: 'execution-contract-run-once',
      triggerKey: 'execution-contract-trigger',
      snapshot: {
        version: 1,
        name: 'execution contract run-once',
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
      (await core.runOncePipelines.getRun(admitted.runId!))?.status === 'dead-letter',
    )
    const status = await core.runOncePipelines.getRun(admitted.runId!)
    assert.equal(status?.attempt, 1)
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
    run_once_test + "\ntest('scheduled target execution cannot bypass Core execution preflight'",
)

replace_once(
    'tests/contracts/codex-execution-preflight.test.ts',
    "import { CodexAgentAdapter } from '../../src/adapters/codex.js'\n",
    "import { CodexAgentAdapter } from '../../src/adapters/codex.js'\n"
    "import { isAgentExecutionError } from '../../src/core/index.js'\n",
)

old_reroute_fixture = """async function reroutingCodex(root: string): Promise<string> {
  const executable = path.join(root, 'codex-rerouting')
  const rows = [
    model('picker-a', 'model-a', ['high'], true, 'high'),
    model('picker-b', 'model-b', ['high'], false, 'high'),
  ]
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const models = ${JSON.stringify(rows)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let turn = 0;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'rerouting'}});
  if (msg.method === 'model/list') return send({id:msg.id,result:{data:models,nextCursor:null}});
  if (msg.method === 'thread/resume') return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle',cwd:${JSON.stringify(root)}},model:msg.params.model,reasoningEffort:'high',cwd:${JSON.stringify(root)}}});
  if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
  if (msg.method === 'turn/start') {
    const turnId = 'reroute-turn-' + (++turn);
    send({id:msg.id,result:{turn:{id:turnId,status:'inProgress'}}});
    send({method:'model/rerouted',params:{threadId:msg.params.threadId,turnId,fromModel:'model-a',toModel:'model-b',reason:'safety'}});
    return send({method:'turn/completed',params:{threadId:msg.params.threadId,turn:{id:turnId,status:'completed',error:null}}});
  }
  if (msg.method === 'thread/read') return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle'},turns:[]}});
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return executable
}
"""
new_reroute_fixture = """async function reroutingCodex(
  root: string,
): Promise<{ executable: string; marker: string }> {
  const executable = path.join(root, 'codex-rerouting')
  const marker = path.join(root, 'reroute-requests.jsonl')
  const rows = [
    model('picker-a', 'model-a', ['high'], true, 'high'),
    model('picker-b', 'model-b', ['high'], false, 'high'),
  ]
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const models = ${JSON.stringify(rows)};
const marker = ${JSON.stringify(marker)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let turn = 0;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'rerouting'}});
  if (msg.method === 'model/list') return send({id:msg.id,result:{data:models,nextCursor:null}});
  if (msg.method === 'thread/resume') return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle',cwd:${JSON.stringify(root)}},model:msg.params.model,reasoningEffort:'high',cwd:${JSON.stringify(root)}}});
  if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
  if (msg.method === 'turn/start') {
    const turnId = 'reroute-turn-' + (++turn);
    send({id:msg.id,result:{turn:{id:turnId,status:'inProgress'}}});
    send({method:'model/rerouted',params:{threadId:msg.params.threadId,turnId,fromModel:'model-a',toModel:'model-b',reason:'safety'}});
    if (turn > 1) {
      return send({method:'turn/completed',params:{threadId:msg.params.threadId,turn:{id:turnId,status:'completed',error:null}}});
    }
    return;
  }
  if (msg.method === 'turn/interrupt') {
    fs.appendFileSync(marker, JSON.stringify(msg.params) + '\\n');
    return send({id:msg.id,result:{}});
  }
  if (msg.method === 'thread/read') return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle'},turns:[]}});
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return { executable, marker }
}
"""
replace_once(
    'tests/contracts/codex-execution-preflight.test.ts',
    old_reroute_fixture,
    new_reroute_fixture,
)

replace_once(
    'tests/contracts/codex-execution-preflight.test.ts',
    """  const adapter = new CodexAgentAdapter({
    executable: await reroutingCodex(root),
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
  })
  try {
    await assert.rejects(
      adapter.dispatch({
""",
    """  const fake = await reroutingCodex(root)
  const adapter = new CodexAgentAdapter({
    executable: fake.executable,
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
  })
  try {
    await assert.rejects(
      adapter.dispatch({
""",
)

replace_once(
    'tests/contracts/codex-execution-preflight.test.ts',
    """      /rerouted exact model model-a from model-a to model-b/,
    )

    const preferred = await adapter.dispatch({
""",
    """      (error: unknown) => {
        assert.ok(isAgentExecutionError(error))
        assert.equal(error.code, 'MODEL_UNAVAILABLE')
        assert.equal(error.retryable, false)
        assert.match(
          error.message,
          /rerouted exact model model-a from model-a to model-b/,
        )
        return true
      },
    )
    const interruptsAfterExact = (await readFile(fake.marker, 'utf8'))
      .trim()
      .split('\\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
    assert.deepEqual(interruptsAfterExact, [{
      threadId: 'reroute-session',
      turnId: 'reroute-turn-1',
    }])

    const preferred = await adapter.dispatch({
""",
)
replace_once(
    'tests/contracts/codex-execution-preflight.test.ts',
    """    assert.equal(preferred.executionEvidence?.runtime?.actualModel, 'model-b')
    assert.equal(preferred.executionEvidence?.runtime?.actualReasoningEffort, 'high')
""",
    """    assert.equal(preferred.executionEvidence?.runtime?.actualModel, 'model-b')
    assert.equal(preferred.executionEvidence?.runtime?.actualReasoningEffort, 'high')
    const allInterrupts = (await readFile(fake.marker, 'utf8'))
      .trim()
      .split('\\n')
      .filter(Boolean)
    assert.equal(allInterrupts.length, 1)
""",
)

thread_paging_fixture = """
async function pagedThreadCodex(root: string, marker: string): Promise<string> {
  const executable = path.join(root, 'codex-paged-threads')
  const rows = [model('picker-thread', 'thread-model', ['high'], true, 'high')]
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const models = ${JSON.stringify(rows)};
const marker = ${JSON.stringify(marker)};
const root = ${JSON.stringify(root)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'paged-threads'}});
  if (msg.method === 'model/list') return send({id:msg.id,result:{data:models,nextCursor:null}});
  if (msg.method === 'thread/list') {
    fs.appendFileSync(marker, JSON.stringify(msg.params || {}) + '\\n');
    if (msg.params && msg.params.cursor === 'thread-page-2') {
      return send({id:msg.id,result:{data:[{id:'late-session',status:'notLoaded',cwd:root}],nextCursor:null}});
    }
    return send({id:msg.id,result:{data:[{id:'first-session',status:'notLoaded',cwd:root}],nextCursor:'thread-page-2'}});
  }
  if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return executable
}

test('Codex Session discovery exhausts paginated thread catalogs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-thread-pages-'))
  const marker = path.join(root, 'thread-list.jsonl')
  const adapter = new CodexAgentAdapter({
    executable: await pagedThreadCodex(root, marker),
    requestTimeoutMs: 1_000,
  })
  try {
    const sessions = await adapter.listSessions('late-session')
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.sessionId, 'late-session')

    await writeFile(marker, '', 'utf8')
    const preflight = await adapter.preflightExecution({
      correlationId: 'paged-session',
      session: { kind: 'existing', sessionId: 'late-session' },
      requirement: {
        runtime: {
          model: 'thread-model',
          reasoningEffort: 'high',
          match: 'exact',
        },
      },
      skills: [],
    })
    assert.equal(preflight.status, 'ready')
    const requests = (await readFile(marker, 'utf8'))
      .trim()
      .split('\\n')
      .map(line => JSON.parse(line))
    assert.equal(requests.length, 2)
    assert.equal(requests[1]?.cursor, 'thread-page-2')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
"""
replace_once(
    'tests/contracts/codex-execution-preflight.test.ts',
    "\ntest('Codex capability requirements fail closed without permission evidence'",
    thread_paging_fixture + "\ntest('Codex capability requirements fail closed without permission evidence'",
)

# ---------------------------------------------------------------------------
# Documentation
# ---------------------------------------------------------------------------
replace_once(
    'docs/execution-preflight.md',
    "For Codex, the Adapter exhausts paginated `model/list` results during preflight, uses `thread/start` for a dedicated Session, and sends explicit `model`/`effort` fields at the turn boundary. Exact requests disable provider fallback. Catalog selection is not reused as actual execution evidence: nullable `thread/start` / `thread/resume` runtime fields are validated independently, and `model/rerouted` notifications determine the final model used by a turn.",
    "For Codex, the Adapter exhausts paginated `model/list` and `thread/list` results, uses `thread/start` for a dedicated Session, and sends explicit `model`/`effort` fields at the turn boundary. Exact requests disable provider fallback. Catalog selection is not reused as actual execution evidence: nullable `thread/start` / `thread/resume` runtime fields are validated independently. If `model/rerouted` moves an active exact-model turn away from the requested model, Flowit immediately requests `turn/interrupt` and raises a non-retryable execution-contract error; preferred and inherited execution record the final routed model.",
)

replace_once(
    'docs/adapter-contract.md',
    "Adapters must return structured blockers such as `MODEL_UNAVAILABLE`, `SESSION_BUSY`, `SESSION_WRITER_LOCKED`, `PERMISSION_UNAVAILABLE` or `HOST_VERSION_INCOMPATIBLE`. Do not turn every preflight failure into an unclassified string. The Core dispatcher enforces this contract for direct dispatch, persistent Pipelines, Schedules and run-once recovery: exact/preferred runtime or required-capability targets cannot reach `dispatch()` unless the Adapter advertises and passes `preflightExecution()` immediately before execution.",
    "Adapters must return structured blockers such as `MODEL_UNAVAILABLE`, `SESSION_BUSY`, `SESSION_WRITER_LOCKED`, `PERMISSION_UNAVAILABLE` or `HOST_VERSION_INCOMPATIBLE`. Do not turn every preflight failure into an unclassified string. The Core dispatcher enforces this contract for direct dispatch, persistent Pipelines, Schedules and run-once recovery: exact/preferred runtime or required-capability targets cannot reach `dispatch()` unless the Adapter advertises and passes `preflightExecution()` immediately before execution. Deterministic execution-contract violations use `AgentExecutionError`; errors with `retryable=false` are dead-lettered on the current attempt rather than replaying forbidden substitute execution.",
)

replace_once(
    'docs/releases/execution-preflight-pr.md',
    "- Model catalog preflight follows `nextCursor` pagination and Core independently checks exact/preferred actual evidence.",
    "- Model and Session discovery follow `nextCursor` pagination and Core independently checks exact/preferred actual evidence.\n"
    "- Exact-model reroutes immediately request `turn/interrupt` and surface a non-retryable execution-contract error; preferred reroutes update final evidence.\n"
    "- Durable runtimes dead-letter non-retryable execution-contract failures on the first attempt.",
)

print('Applied PR #23 fourth-round execution-contract fixes')
