import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAgentAdapter } from '../../src/adapters/codex.js'

async function fakeCodex(
  root: string,
  mode: 'complete' | 'failed' | 'interrupted' | 'approval' | 'exit' | 'timeout',
  marker?: string,
): Promise<string> {
  const file = path.join(root, `codex-${mode}`)
  const source = `#!/usr/bin/env node
const fs = require('node:fs'); const readline = require('node:readline'); const mode = ${JSON.stringify(mode)}; const marker = ${JSON.stringify(marker ?? '')};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity }); let turnId = 'turn-1';
const approvalId = 'approval-request-99';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => { const msg = JSON.parse(line); if (msg.method === 'initialized') return;
 if (msg.id === approvalId && msg.result) { if (msg.result.decision !== 'decline') process.exit(23); send({method:'turn/completed',params:{threadId:'thr-1',turn:{id:turnId,status:'completed',error:null}}}); return; }
 if (msg.id === undefined || msg.id === null) return;
 if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'fake'}});
 if (msg.method === 'thread/resume') return send({id:msg.id,result:{thread:{id:'thr-1',status:'idle',cwd:process.cwd()}}});
 if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
 if (msg.method === 'turn/start') { process.stdout.write(JSON.stringify({id:msg.id,result:{turn:{id:turnId,status:'inProgress',items:[],error:null}}}) + '\\n');
   if (mode === 'complete') return process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thr-1',turn:{id:turnId,status:'completed',error:null}}}) + '\\n');
   if (mode === 'failed') return send({method:'turn/completed',params:{threadId:'thr-1',turn:{id:turnId,status:'failed',error:{message:'boom'}}}});
   if (mode === 'interrupted') return send({method:'turn/completed',params:{threadId:'thr-1',turn:{id:turnId,status:'interrupted',error:null}}});
   if (mode === 'approval') return send({id:approvalId,method:'item/commandExecution/requestApproval',params:{threadId:'thr-1',turnId,itemId:'item-1',command:'echo hi'}});
   if (mode === 'exit') return setTimeout(() => process.exit(2), 5); return; }
 if (msg.method === 'turn/interrupt') { if (marker) fs.writeFileSync(marker, 'interrupt'); return send({id:msg.id,result:{}}); }
 if (msg.method === 'thread/read') return send({id:msg.id,result:{thread:{id:'thr-1'},turns:[{id:turnId}]}});
 if (msg.method === 'thread/list') return send({id:msg.id,result:{data:[]}});
});
`
  await writeFile(file, source, 'utf8')
  await chmod(file, 0o755)
  return file
}

function request() {
  return {
    correlationId: 'idem-1',
    sessionId: 'thr-1',
    prompt: 'do work',
    skills: [],
    contextRefs: [],
  }
}

test('completion delivered in same stdout batch is buffered instead of lost', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-complete-'))
  const adapter = new CodexAgentAdapter({
    executable: await fakeCodex(root, 'complete'),
    requestTimeoutMs: 500,
    turnTimeoutMs: 500,
  })
  try {
    const result = await adapter.dispatch(request())
    assert.equal(result.runId, 'turn-1')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('failed and interrupted turns reject instead of being recorded successful', async () => {
  for (const mode of ['failed', 'interrupted'] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `flowit-codex-${mode}-`))
    const adapter = new CodexAgentAdapter({
      executable: await fakeCodex(root, mode),
      requestTimeoutMs: 500,
      turnTimeoutMs: 500,
    })
    try {
      await assert.rejects(adapter.dispatch(request()), new RegExp(mode))
    } finally {
      await adapter.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('string-id unattended approval requests are answered fail-closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-approval-'))
  const adapter = new CodexAgentAdapter({
    executable: await fakeCodex(root, 'approval'),
    requestTimeoutMs: 500,
    turnTimeoutMs: 500,
  })
  try {
    const result = await adapter.dispatch(request())
    assert.equal(result.runId, 'turn-1')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('child exit rejects waiters and turn timeout sends turn/interrupt', async () => {
  const exitRoot = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-exit-'))
  const exitAdapter = new CodexAgentAdapter({
    executable: await fakeCodex(exitRoot, 'exit'),
    requestTimeoutMs: 500,
    turnTimeoutMs: 1000,
  })
  try {
    await assert.rejects(exitAdapter.dispatch(request()), /exited/)
  } finally {
    await exitAdapter.dispose()
    await rm(exitRoot, { recursive: true, force: true })
  }

  const timeoutRoot = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-timeout-'))
  const marker = path.join(timeoutRoot, 'interrupt.txt')
  const timeoutAdapter = new CodexAgentAdapter({
    executable: await fakeCodex(timeoutRoot, 'timeout', marker),
    requestTimeoutMs: 500,
    turnTimeoutMs: 50,
  })
  try {
    await assert.rejects(timeoutAdapter.dispatch(request()), /timed out/)
    for (let i = 0; i < 20; i++) {
      try {
        assert.equal(await readFile(marker, 'utf8'), 'interrupt')
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    assert.fail('turn/interrupt marker was not written')
  } finally {
    await timeoutAdapter.dispose()
    await rm(timeoutRoot, { recursive: true, force: true })
  }
})

test('adapter start rejects when the Codex executable cannot be spawned', async () => {
  const adapter = new CodexAgentAdapter({
    executable: path.join(os.tmpdir(), `missing-codex-${Date.now()}`),
    requestTimeoutMs: 200,
  })
  try {
    await assert.rejects(adapter.start(), /ENOENT|exited|spawn/i)
  } finally {
    await adapter.dispose()
  }
})

async function restartableCodex(root: string): Promise<string> {
  const file = path.join(root, 'codex-restartable')
  const marker = path.join(root, 'crashed-once')
  const source = `#!/usr/bin/env node
const fs = require('node:fs'); const readline = require('node:readline'); const marker = ${JSON.stringify(marker)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity }); const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => { const msg = JSON.parse(line); if (msg.method === 'initialized') return; if (msg.id === undefined || msg.id === null) return;
 if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'fake'}});
 if (msg.method === 'thread/resume') return send({id:msg.id,result:{thread:{id:'thr-1',status:'idle',cwd:process.cwd()}}});
 if (msg.method === 'skills/list') return send({id:msg.id,result:{data:[]}});
 if (msg.method === 'turn/start') { send({id:msg.id,result:{turn:{id:'turn-1',status:'inProgress'}}}); if (!fs.existsSync(marker)) { fs.writeFileSync(marker,'1'); return setTimeout(() => process.exit(2), 5); } return send({method:'turn/completed',params:{threadId:'thr-1',turn:{id:'turn-1',status:'completed',error:null}}}); }
 if (msg.method === 'thread/read') return send({id:msg.id,result:{thread:{id:'thr-1'},turns:[{id:'turn-1'}]}});
});
`
  await writeFile(file, source, 'utf8')
  await chmod(file, 0o755)
  return file
}

test('Codex adapter restarts app-server after a spontaneous child exit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-restart-'))
  const adapter = new CodexAgentAdapter({
    executable: await restartableCodex(root),
    requestTimeoutMs: 500,
    turnTimeoutMs: 1_000,
  })
  try {
    await assert.rejects(adapter.dispatch(request()), /exited/)
    const result = await adapter.dispatch(request())
    assert.equal(result.runId, 'turn-1')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
