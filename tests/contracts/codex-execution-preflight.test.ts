import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAgentAdapter } from '../../src/adapters/codex.js'

async function executionAwareCodex(root: string): Promise<{ executable: string; marker: string }> {
  const executable = path.join(root, 'codex-execution-aware')
  const marker = path.join(root, 'requests.jsonl')
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const marker = ${JSON.stringify(marker)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (name, params) => fs.appendFileSync(marker, JSON.stringify({ name, params }) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'codex-test/9.9.9',protocolVersion:'v2'}});
  if (msg.method === 'model/list') return send({id:msg.id,result:{data:[
    {id:'gpt-test-luna',isDefault:true,supportedReasoningEfforts:['low','medium','high']},
    {id:'gpt-test-sol',supportedReasoningEfforts:['medium']}
  ]}});
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

test('Codex preflight validates exact runtime and maps notLoaded Sessions as idle', async () => {
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

    const unavailable = await adapter.preflightExecution({
      correlationId: 'preflight-2',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        runtime: { model: 'missing-model', match: 'exact' },
      },
      skills: [],
    })
    assert.equal(unavailable.status, 'blocked')
    assert.equal(unavailable.blockers[0]?.code, 'MODEL_UNAVAILABLE')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex provisions after preflight and sends model/effort as protocol parameters', async () => {
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
    assert.equal(start?.params.allowProviderModelFallback, false)
    const turn = rows.find(row => row.name === 'turn/start')
    assert.equal(turn?.params.model, 'gpt-test-luna')
    assert.equal(turn?.params.effort, 'high')
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
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const models = ${JSON.stringify(models)};
const marker = ${JSON.stringify(marker)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:${JSON.stringify(name)}}});
  if (msg.method === 'model/list') return send({id:msg.id,result:{data:models.map((id,index)=>({id,isDefault:index===0,supportedReasoningEfforts:['high']}))}});
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
