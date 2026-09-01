import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAgentAdapter } from '../src/adapters/codex.js'

async function turnHistoryCodex(root: string): Promise<string> {
  const executable = path.join(root, 'codex-turn-history')
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') return send({id:msg.id,result:{userAgent:'codex-turn-output-test',protocolVersion:'v2'}});
  if (msg.method === 'thread/resume') return send({id:msg.id,result:{thread:{id:msg.params.threadId,status:'idle',cwd:${JSON.stringify(root)}},cwd:${JSON.stringify(root)}}});
  if (msg.method === 'turn/start') {
    send({id:msg.id,result:{turn:{id:'current-turn',status:'inProgress'}}});
    return send({method:'turn/completed',params:{threadId:msg.params.threadId,turn:{id:'current-turn',status:'completed',error:null}}});
  }
  if (msg.method === 'thread/read') return send({id:msg.id,result:{thread:{id:msg.params.threadId,turns:[
    {id:'old-turn',items:[{type:'agentMessage',text:'OLD_SENTINEL must never leak'}]},
    {id:'current-turn',items:[{type:'userMessage',text:'current request'},{type:'agentMessage',text:'NEW_SENTINEL current answer'}]}
  ]}}});
  if (msg.method === 'turn/interrupt') return send({id:msg.id,result:{}});
});
`
  await writeFile(executable, source, 'utf8')
  await chmod(executable, 0o755)
  return executable
}

test('Codex dispatch returns only the exact completed turn output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-turn-output-'))
  const adapter = new CodexAgentAdapter({
    executable: await turnHistoryCodex(root),
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 1_000,
  })
  try {
    const result = await adapter.dispatch({
      correlationId: 'turn-output-1',
      sessionId: 'thread-1',
      prompt: 'produce a report',
      skills: [],
      contextRefs: [],
    })
    assert.equal(result.runId, 'current-turn')
    assert.equal(result.outputSummary, 'NEW_SENTINEL current answer')
    assert.doesNotMatch(result.outputSummary ?? '', /OLD_SENTINEL/)
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
