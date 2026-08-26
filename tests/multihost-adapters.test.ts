import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { OpenCodeAgentAdapter, OPENCODE_ADAPTER_ID } from '../src/adapters/opencode.js'
import { CodexAgentAdapter, CODEX_ADAPTER_ID } from '../src/adapters/codex.js'
import { WorkBuddyAgentAdapter, WORKBUDDY_ADAPTER_ID } from '../src/adapters/workbuddy.js'
import { DoubaoOfficeAgentAdapter, DOUBAO_OFFICE_ADAPTER_ID } from '../src/adapters/doubao-office.js'
import { bridgeStatePaths } from '../src/bridge/state.js'
import { ingestBridgeHook } from '../src/bridge/hook.js'

test('built-in host adapters advertise honest capability levels', () => {
  const openCode = new OpenCodeAgentAdapter({ baseUrl: 'http://127.0.0.1:1' })
  const codex = new CodexAgentAdapter({ executable: 'codex-do-not-start-in-constructor' })
  const workBuddy = new WorkBuddyAgentAdapter()
  const doubao = new DoubaoOfficeAgentAdapter()
  assert.equal(openCode.id, OPENCODE_ADAPTER_ID)
  assert.equal(openCode.capabilities.coldResume, true)
  assert.equal(codex.id, CODEX_ADAPTER_ID)
  assert.equal(codex.capabilities.skillBinding, true)
  assert.equal(workBuddy.id, WORKBUDDY_ADAPTER_ID)
  assert.equal(workBuddy.capabilities.coldResume, false)
  assert.equal(doubao.id, DOUBAO_OFFICE_ADAPTER_ID)
  assert.equal(doubao.capabilities.coldResume, false)
  assert.equal(doubao.capabilities.eventSubscription, false)
})

test('file bridge dispatch is fail-closed on Skill attestation and returns host result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-workbuddy-bridge-'))
  const adapter = new WorkBuddyAgentAdapter({ root, pollIntervalMs: 10, dispatchTimeoutMs: 2_000 })
  const paths = bridgeStatePaths(WORKBUDDY_ADAPTER_ID, root)
  try {
    await ingestBridgeHook(WORKBUDDY_ADAPTER_ID, { session_id: 'source', hook_event_name: 'Stop', last_assistant_message: 'source summary' }, root)
    const worker = (async () => {
      await mkdir(paths.inboxDir, { recursive: true })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const files = (await readdir(paths.inboxDir)).filter(name => name.endsWith('.json'))
        if (files.length > 0) {
          const file = files[0]!
          const request = JSON.parse(await readFile(path.join(paths.inboxDir, file), 'utf8')) as { requestId: string; request: { sessionId: string; skills: string[]; contextRefs: Array<{sessionId:string}> }; context: Array<{sessionId:string;summary:string}> }
          assert.equal(request.context[0]?.summary, 'source summary')
          await mkdir(paths.outboxDir, { recursive: true })
          await writeFile(path.join(paths.outboxDir, `${request.requestId}.json`), JSON.stringify({
            sessionId: request.request.sessionId,
            loadedSkills: request.request.skills,
            referencedSessions: request.request.contextRefs.map(ref => ref.sessionId),
            outputSummary: 'done',
          }), 'utf8')
          return
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('worker did not observe bridge request')
    })()
    const result = await adapter.dispatch({
      correlationId: 'c1',
      sessionId: 'wb-session',
      prompt: 'do work',
      skills: ['research'],
      contextRefs: [{ adapterId: WORKBUDDY_ADAPTER_ID, sessionId: 'source' }],
    })
    await worker
    assert.deepEqual(result.loadedSkills, ['research'])
    assert.deepEqual(result.referencedSessions, ['source'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkBuddy bridge hooks create durable session and completion event facts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-workbuddy-hooks-'))
  try {
    await ingestBridgeHook(WORKBUDDY_ADAPTER_ID, { session_id: 's1', cwd: '/tmp/project', hook_event_name: 'SessionStart' }, root)
    await ingestBridgeHook(WORKBUDDY_ADAPTER_ID, { session_id: 's1', cwd: '/tmp/project', hook_event_name: 'Stop', last_assistant_message: 'finished' }, root)
    const paths = bridgeStatePaths(WORKBUDDY_ADAPTER_ID, root)
    const sessions = JSON.parse(await readFile(paths.sessionsFile, 'utf8')) as Array<{sessionId:string;status:string}>
    const events = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {kind:string})
    assert.equal(sessions[0]?.sessionId, 's1')
    assert.equal(sessions[0]?.status, 'idle')
    assert.deepEqual(events.map(event => event.kind), ['session_started', 'turn_completed'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex adapter speaks App Server v2 and binds native typed Skills', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-codex-app-server-'))
  const executable = path.join(root, 'fake-codex.mjs')
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (!msg.id) return
  if (msg.method === 'initialize') return send({ id: msg.id, result: {} })
  if (msg.method === 'thread/list') return send({ id: msg.id, result: { data: [{ id: 'thr-1', preview: 'Test thread', cwd: '/tmp/project', status: { type: 'notLoaded' } }] } })
  if (msg.method === 'thread/resume') return send({ id: msg.id, result: { thread: { id: 'thr-1', cwd: '/tmp/project', status: { type: 'notLoaded' } } } })
  if (msg.method === 'skills/list') return send({ id: msg.id, result: { data: [{ cwd: '/tmp/project', skills: [{ name: 'review', enabled: true, path: '/tmp/review/SKILL.md' }] }] } })
  if (msg.method === 'thread/read') return send({ id: msg.id, result: { thread: { id: 'thr-1', turns: [{ items: [{ type: 'agentMessage', text: 'done' }] }] } } })
  if (msg.method === 'turn/start') {
    const input = msg.params.input
    const text = input.find(item => item.type === 'text')?.text ?? ''
    const skill = input.find(item => item.type === 'skill')
    if (!text.includes('$review') || skill?.name !== 'review' || skill?.path !== '/tmp/review/SKILL.md') return send({ id: msg.id, error: { message: 'missing native skill binding' } })
    send({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
    setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } }), 20)
    return
  }
  send({ id: msg.id, error: { message: 'unsupported ' + msg.method } })
})
`
  await writeFile(executable, script, 'utf8')
  await chmod(executable, 0o755)
  const adapter = new CodexAgentAdapter({ executable })
  try {
    const sessions = await adapter.listSessions()
    assert.equal(sessions[0]?.sessionId, 'thr-1')
    const result = await adapter.dispatch({ correlationId: 'c-codex', sessionId: 'thr-1', prompt: 'Review changes', skills: ['review'], contextRefs: [] })
    assert.deepEqual(result.loadedSkills, ['review'])
    assert.equal(result.runId, 'turn-1')
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('OpenCode adapter resolves Skill content and bounded Session context through the V2 client contract', async () => {
  let prompted = ''
  const client = {
    session: {
      list: async () => [{ id: 'oc-1', title: 'OpenCode test', directory: '/tmp/project', status: 'idle' }],
      get: async () => ({ id: 'oc-1', directory: '/tmp/project', status: 'idle' }),
      context: async ({ sessionID }: {sessionID:string}) => sessionID === 'source' ? { messages: ['source context'] } : { messages: ['target result'] },
      prompt: async ({ text }: {text:string}) => { prompted = text },
      wait: async () => undefined,
    },
    skill: { list: async () => [{ id: 'research', content: 'Follow the research method.' }] },
    event: { subscribe: async function* () { /* no events in this test */ } },
  }
  const adapter = new OpenCodeAgentAdapter({ clientFactory: () => client })
  const sessions = await adapter.listSessions()
  assert.equal(sessions[0]?.sessionId, 'oc-1')
  const result = await adapter.dispatch({ correlationId: 'oc-c1', sessionId: 'oc-1', prompt: 'Analyze', skills: ['research'], contextRefs: [{ adapterId: OPENCODE_ADAPTER_ID, sessionId: 'source', label: 'Source' }] })
  assert.match(prompted, /<skill name="research">/)
  assert.match(prompted, /source context/)
  assert.deepEqual(result.loadedSkills, ['research'])
  assert.deepEqual(result.referencedSessions, ['source'])
})
