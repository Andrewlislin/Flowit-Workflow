import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAgentAdapter } from '../../src/adapters/codex.js'

function model(
  id: string,
  runtimeModel: string,
  efforts: string[],
  isDefault = false,
  defaultReasoningEffort = 'medium',
) {
  return {
    id,
    model: runtimeModel,
    isDefault,
    defaultReasoningEffort,
    description: runtimeModel,
    displayName: runtimeModel,
    hidden: false,
    supportedReasoningEfforts: efforts.map(reasoningEffort => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
  }
}

async function executionAwareCodex(root: string): Promise<{ executable: string; marker: string }> {
  const executable = path.join(root, 'codex-execution-aware')
  const marker = path.join(root, 'requests.jsonl')
  const models = [
    model('picker-entry-luna', 'gpt-test-luna', ['low', 'medium', 'high'], true),
    model('picker-entry-sol', 'gpt-test-sol', ['medium']),
    model('picker-entry-empty', 'gpt-test-empty', [], false, 'medium'),
  ]
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const marker = ${JSON.stringify(marker)};
const models = ${JSON.stringify(models)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (name, params) => fs.appendFileSync(marker, JSON.stringify({ name, params }) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'codex-test/9.9.9',protocolVersion:'v2'}});
  if (msg.method === 'model/list') return send({id:msg.id,result:{data:models}});
  if (msg.method === 'thread/list') return send({id:msg.id,result:{data:[{id:'stored',status:'notLoaded',cwd:${JSON.stringify(root)}}]}});
  if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
  if (msg.method === 'thread/start') {
    record('thread/start', msg.params);
    const effort = msg.params && msg.params.config && msg.params.config.model_reasoning_effort;
    return send({id:msg.id,result:{thread:{id:'dedicated-1',status:'idle',cwd:msg.params.cwd},model:msg.params.model,reasoningEffort:effort,cwd:msg.params.cwd}});
  }
  if (msg.method === 'thread/resume') {
    record('thread/resume', msg.params);
    const effort = msg.params && msg.params.config && msg.params.config.model_reasoning_effort;
    return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle',cwd:${JSON.stringify(root)}},model:msg.params.model,reasoningEffort:effort,cwd:${JSON.stringify(root)}}});
  }
  if (msg.method === 'turn/start') {
    record('turn/start', msg.params);
    send({id:msg.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
    return send({method:'turn/completed',params:{threadId:msg.params.threadId,turn:{id:'turn-1',status:'completed',error:null}}});
  }
  if (msg.method === 'thread/read') return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle',cwd:${JSON.stringify(root)}},turns:[{id:'turn-1'}]}});
  if (msg.method === 'thread/archive') return send({id:msg.id,result:{}});
  if (msg.method === 'turn/interrupt') return send({id:msg.id,result:{}});
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

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition timed out')
}

test('Codex preflight validates the runtime model field and maps notLoaded Sessions as idle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-preflight-'))
  const fake = await executionAwareCodex(root)
  const adapter = new CodexAgentAdapter({
    executable: fake.executable,
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
  })
  try {
    const sessions = await adapter.listSessions('stored')
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.status, 'idle')

    const preflight = await adapter.preflightExecution({
      correlationId: 'preflight-1',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        runtime: {
          model: 'gpt-test-luna',
          reasoningEffort: 'high',
          match: 'exact',
        },
      },
      skills: [],
    })
    assert.equal(preflight.status, 'ready')
    assert.equal(preflight.blockers.length, 0)
    assert.equal(preflight.evidence.runtime?.actualModel, 'gpt-test-luna')
    assert.equal(preflight.evidence.runtime?.actualReasoningEffort, 'high')
    assert.equal(preflight.evidence.host?.executable, fake.executable)

    const pickerIdIsNotRuntimeModel = await adapter.preflightExecution({
      correlationId: 'preflight-picker-id',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        runtime: { model: 'picker-entry-luna', match: 'exact' },
      },
      skills: [],
    })
    assert.equal(pickerIdIsNotRuntimeModel.status, 'blocked')
    assert.equal(pickerIdIsNotRuntimeModel.blockers[0]?.code, 'MODEL_UNAVAILABLE')

    const emptyEffortCatalog = await adapter.preflightExecution({
      correlationId: 'preflight-empty-efforts',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        runtime: {
          model: 'gpt-test-empty',
          reasoningEffort: 'high',
          match: 'exact',
        },
      },
      skills: [],
    })
    assert.equal(emptyEffortCatalog.status, 'blocked')
    assert.equal(emptyEffortCatalog.blockers[0]?.code, 'REASONING_EFFORT_UNAVAILABLE')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex provisions and dispatches with the catalog runtime model, not the picker id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-provision-'))
  const fake = await executionAwareCodex(root)
  const adapter = new CodexAgentAdapter({
    executable: fake.executable,
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
  })
  const requirement = {
    runtime: {
      model: 'gpt-test-luna',
      reasoningEffort: 'high',
      match: 'exact' as const,
    },
  }
  try {
    const provisioned = await adapter.provisionSession({
      correlationId: 'provision-1',
      session: { kind: 'dedicated', cwd: root },
      requirement,
      skills: [],
    })
    assert.equal(provisioned.session.sessionId, 'dedicated-1')
    assert.equal(provisioned.managed, true)
    assert.equal(provisioned.evidence.runtime?.actualModel, 'gpt-test-luna')
    assert.equal(provisioned.evidence.runtime?.actualReasoningEffort, 'high')

    const result = await adapter.dispatch({
      correlationId: 'dispatch-1',
      sessionId: provisioned.session.sessionId,
      prompt: 'create the game',
      skills: [],
      contextRefs: [],
      execution: requirement,
    })
    assert.equal(result.runId, 'turn-1')
    assert.equal(result.executionEvidence?.runtime?.actualModel, 'gpt-test-luna')
    assert.equal(result.executionEvidence?.runtime?.actualReasoningEffort, 'high')

    const rows = await recorded(fake.marker)
    const start = rows.find(row => row.name === 'thread/start')
    assert.equal(start?.params.model, 'gpt-test-luna')
    assert.equal(start?.params.config.model_reasoning_effort, 'high')
    assert.notEqual(start?.params.model, 'picker-entry-luna')
    const turn = rows.find(row => row.name === 'turn/start')
    assert.equal(turn?.params.model, 'gpt-test-luna')
    assert.equal(turn?.params.effort, 'high')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})


async function nullReasoningCodex(root: string): Promise<string> {
  const executable = path.join(root, 'codex-null-reasoning')
  const rows = [model('picker-null', 'model-null', ['high'], true, 'high')]
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const models = ${JSON.stringify(rows)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'null-reasoning'}});
  if (msg.method === 'model/list') return send({id:msg.id,result:{data:models,nextCursor:null}});
  if (msg.method === 'thread/list') return send({id:msg.id,result:{data:[{id:'stored-null',status:'notLoaded',cwd:${JSON.stringify(root)}}]}});
  if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
  if (msg.method === 'thread/start') return send({id:msg.id,result:{thread:{id:'created-null',status:'idle',cwd:msg.params.cwd},model:msg.params.model,reasoningEffort:null,cwd:msg.params.cwd}});
  if (msg.method === 'thread/resume') return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle',cwd:${JSON.stringify(root)}},model:msg.params.model,reasoningEffort:null,cwd:${JSON.stringify(root)}}});
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return executable
}

test('Codex never backfills a null Host reasoning effort from catalog evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-null-reasoning-'))
  const adapter = new CodexAgentAdapter({
    executable: await nullReasoningCodex(root),
    requestTimeoutMs: 1_000,
  })
  const execution = {
    runtime: {
      model: 'model-null',
      reasoningEffort: 'high',
      match: 'exact' as const,
    },
  }
  try {
    await assert.rejects(
      adapter.provisionSession({
        correlationId: 'null-start',
        session: { kind: 'dedicated', cwd: root },
        requirement: execution,
        skills: [],
      }),
      /did not report an actual reasoning effort/,
    )
    await assert.rejects(
      adapter.dispatch({
        correlationId: 'null-resume',
        sessionId: 'stored-null',
        prompt: 'work',
        skills: [],
        contextRefs: [],
        execution,
      }),
      /did not report an actual reasoning effort/,
    )
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function reroutingCodex(root: string): Promise<string> {
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

test('model/rerouted violates exact execution and updates preferred evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-reroute-'))
  const adapter = new CodexAgentAdapter({
    executable: await reroutingCodex(root),
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
  })
  try {
    await assert.rejects(
      adapter.dispatch({
        correlationId: 'reroute-exact',
        sessionId: 'reroute-session',
        prompt: 'work',
        skills: [],
        contextRefs: [],
        execution: {
          runtime: {
            model: 'model-a',
            reasoningEffort: 'high',
            match: 'exact',
          },
        },
      }),
      /rerouted exact model model-a from model-a to model-b/,
    )

    const preferred = await adapter.dispatch({
      correlationId: 'reroute-preferred',
      sessionId: 'reroute-session',
      prompt: 'work',
      skills: [],
      contextRefs: [],
      execution: {
        runtime: {
          model: 'model-a',
          reasoningEffort: 'high',
          match: 'preferred',
        },
      },
    })
    assert.equal(preferred.executionEvidence?.runtime?.actualModel, 'model-b')
    assert.equal(preferred.executionEvidence?.runtime?.actualReasoningEffort, 'high')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function pagedCatalogCodex(root: string, marker: string): Promise<string> {
  const executable = path.join(root, 'codex-paged-catalog')
  const firstPage = [model('picker-default', 'default-model', ['medium'], true, 'medium')]
  const secondPage = [model('picker-late', 'late-model', ['high'], false, 'high')]
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const firstPage = ${JSON.stringify(firstPage)};
const secondPage = ${JSON.stringify(secondPage)};
const marker = ${JSON.stringify(marker)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'paged'}});
  if (msg.method === 'model/list') {
    fs.appendFileSync(marker, JSON.stringify(msg.params || {}) + '\\n');
    if (msg.params && msg.params.cursor === 'page-2') {
      return send({id:msg.id,result:{data:secondPage,nextCursor:null}});
    }
    return send({id:msg.id,result:{data:firstPage,nextCursor:'page-2'}});
  }
  if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return executable
}

test('Codex runtime preflight exhausts paginated model catalogs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-model-pages-'))
  const marker = path.join(root, 'model-list.jsonl')
  const adapter = new CodexAgentAdapter({
    executable: await pagedCatalogCodex(root, marker),
    requestTimeoutMs: 1_000,
  })
  try {
    const result = await adapter.preflightExecution({
      correlationId: 'paged-model',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        runtime: {
          model: 'late-model',
          reasoningEffort: 'high',
          match: 'exact',
        },
      },
      skills: [],
    })
    assert.equal(result.status, 'ready')
    assert.equal(result.evidence.runtime?.actualModel, 'late-model')
    const requests = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(requests.length, 2)
    assert.equal(requests[1]?.cursor, 'page-2')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex capability requirements fail closed without permission evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-permissions-'))
  const fake = await executionAwareCodex(root)
  const adapter = new CodexAgentAdapter({ executable: fake.executable, requestTimeoutMs: 1_000 })
  try {
    const result = await adapter.preflightExecution({
      correlationId: 'permissions-1',
      session: { kind: 'dedicated', cwd: root },
      requirement: { requiredCapabilities: ['workspace-write', 'shell'] },
      skills: [],
    })
    assert.equal(result.status, 'blocked')
    assert.equal(result.blockers[0]?.code, 'PERMISSION_UNAVAILABLE')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function catalogCodex(
  root: string,
  name: string,
  models: string[],
  marker: string,
): Promise<string> {
  const executable = path.join(root, name)
  const rows = models.map((runtimeModel, index) =>
    model(`picker-${name}-${index}`, runtimeModel, ['high'], index === 0, 'high'))
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const models = ${JSON.stringify(rows)};
const marker = ${JSON.stringify(marker)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:${JSON.stringify(name)}}});
  if (msg.method === 'model/list') return send({id:msg.id,result:{data:models}});
  if (msg.method === 'thread/list') return send({id:msg.id,result:{data:[]}});
  if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
  if (msg.method === 'thread/start') { fs.appendFileSync(marker, ${JSON.stringify(name)} + '\\n'); return send({id:msg.id,result:{thread:{id:'chosen-thread',status:'idle',cwd:msg.params.cwd},model:msg.params.model,reasoningEffort:'high',cwd:msg.params.cwd}}); }
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return executable
}

test('runtime-aware selection tries a later Codex binary after default startup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-candidates-'))
  const marker = path.join(root, 'chosen.txt')
  const first = await catalogCodex(root, 'codex-first', ['default-only'], marker)
  const second = await catalogCodex(root, 'codex-second', ['exact-model'], marker)
  const adapter = new CodexAgentAdapter({
    executableCandidates: [first, second],
    requestTimeoutMs: 1_000,
  })
  try {
    await adapter.start()
    const result = await adapter.preflightExecution({
      correlationId: 'candidate-1',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        runtime: { model: 'exact-model', reasoningEffort: 'high', match: 'exact' },
      },
      skills: [],
    })
    assert.equal(result.status, 'ready')
    assert.equal(result.evidence.host?.executable, second)
    const provisioned = await adapter.provisionSession({
      correlationId: 'candidate-2',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        runtime: { model: 'exact-model', reasoningEffort: 'high', match: 'exact' },
      },
      skills: [],
    })
    assert.equal(provisioned.evidence.host?.executable, second)
    assert.equal((await readFile(marker, 'utf8')).trim(), 'codex-second')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function concurrentCodex(
  root: string,
  name: string,
  runtimeModel: string,
  marker: string,
  gate: string,
  emitEvent = false,
): Promise<string> {
  const executable = path.join(root, name)
  const rows = [model(`picker-${name}`, runtimeModel, ['high'], true, 'high')]
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const name = ${JSON.stringify(name)};
const models = ${JSON.stringify(rows)};
const marker = ${JSON.stringify(marker)};
const gate = ${JSON.stringify(gate)};
const emitEvent = ${JSON.stringify(emitEvent)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
process.on('SIGTERM', () => { fs.appendFileSync(marker, 'sigterm:' + name + '\\n'); process.exit(0); });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:name}});
  if (msg.method === 'model/list') {
    send({id:msg.id,result:{data:models}});
    if (emitEvent) setTimeout(() => send({method:'thread/started',params:{thread:{id:'event-from-' + name}}}), 10);
    return;
  }
  if (msg.method === 'thread/list') return send({id:msg.id,result:{data:[{id:'session-a',status:'notLoaded',cwd:${JSON.stringify(root)}},{id:'session-b',status:'notLoaded',cwd:${JSON.stringify(root)}}]}});
  if (msg.method === 'thread/resume') return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle',cwd:${JSON.stringify(root)}},model:msg.params.model,reasoningEffort:'high'}});
  if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
  if (msg.method === 'turn/start') {
    fs.appendFileSync(marker, 'turn-start:' + name + '\\n');
    send({id:msg.id,result:{turn:{id:'turn-' + name,status:'inProgress'}}});
    const timer = setInterval(() => {
      if (!fs.existsSync(gate)) return;
      clearInterval(timer);
      send({method:'turn/completed',params:{threadId:msg.params.threadId,turn:{id:'turn-' + name,status:'completed',error:null}}});
    }, 10);
    return;
  }
  if (msg.method === 'thread/read') return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle'},turns:[]}});
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return executable
}

test('selecting a second executable does not interrupt an in-flight Session on the first', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-concurrent-clients-'))
  const marker = path.join(root, 'events.txt')
  const gate = path.join(root, 'complete-a')
  const first = await concurrentCodex(root, 'client-a', 'model-a', marker, gate)
  const second = await concurrentCodex(root, 'client-b', 'model-b', marker, gate)
  const adapter = new CodexAgentAdapter({
    executableCandidates: [first, second],
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 2_000,
  })
  try {
    const firstRun = adapter.dispatch({
      correlationId: 'concurrent-a',
      sessionId: 'session-a',
      prompt: 'work on a',
      skills: [],
      contextRefs: [],
      execution: {
        runtime: { model: 'model-a', reasoningEffort: 'high', match: 'exact' },
      },
    })
    await waitUntil(async () => (await readFile(marker, 'utf8').catch(() => '')).includes('turn-start:client-a'))

    const secondPreflight = await adapter.preflightExecution({
      correlationId: 'concurrent-b',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        runtime: { model: 'model-b', reasoningEffort: 'high', match: 'exact' },
      },
      skills: [],
    })
    assert.equal(secondPreflight.status, 'ready')
    assert.equal(secondPreflight.evidence.host?.executable, second)
    assert.doesNotMatch(await readFile(marker, 'utf8'), /sigterm:client-a/)

    await writeFile(gate, 'complete', 'utf8')
    const result = await firstRun
    assert.equal(result.runId, 'turn-client-a')
    assert.doesNotMatch(await readFile(marker, 'utf8'), /sigterm:client-a/)
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('adapter subscriptions receive events from clients created by later runtime selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-multi-client-events-'))
  const marker = path.join(root, 'events.txt')
  const gate = path.join(root, 'unused-gate')
  const first = await concurrentCodex(root, 'event-client-a', 'model-a', marker, gate)
  const second = await concurrentCodex(root, 'event-client-b', 'model-b', marker, gate, true)
  const adapter = new CodexAgentAdapter({
    executableCandidates: [first, second],
    requestTimeoutMs: 1_000,
  })
  const events: string[] = []
  try {
    await adapter.start()
    const stop = adapter.subscribe(event => { events.push(event.sessionId) })
    try {
      const result = await adapter.preflightExecution({
        correlationId: 'event-selection',
        session: { kind: 'dedicated', cwd: root },
        requirement: {
          runtime: { model: 'model-b', reasoningEffort: 'high', match: 'exact' },
        },
        skills: [],
      })
      assert.equal(result.status, 'ready')
      await waitUntil(() => events.includes('event-from-event-client-b'))
    } finally {
      stop()
    }
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
