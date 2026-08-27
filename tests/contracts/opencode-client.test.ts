import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenCode } from '@opencode-ai/client'
import { OpenCodeAgentAdapter, mapOpenCodeEvent } from '../../src/adapters/opencode.js'

test('pinned OpenCode generated client exposes the V2 resources used by Flowit', () => {
  const client = OpenCode.make({ baseUrl: 'http://example.invalid' })
  assert.equal(typeof client.sessions.list, 'function')
  assert.equal(typeof client.sessions.get, 'function')
  assert.equal(typeof client.sessions.active, 'function')
  assert.equal(typeof client.sessions.prompt, 'function')
  assert.equal(typeof client.sessions.wait, 'function')
  assert.equal(typeof client.sessions.context, 'function')
  assert.equal(typeof client.skills.list, 'function')
  assert.equal(typeof client.events.subscribe, 'function')
})

test('OpenCode host event ids remain stable across duplicate delivery', () => {
  const raw = { id: 'evt-stable-1', type: 'session.idle', data: { sessionID: 's1' } } as any
  const first = mapOpenCodeEvent(raw)
  const replay = mapOpenCodeEvent(structuredClone(raw))
  assert.equal(first?.eventId, 'evt-stable-1')
  assert.equal(replay?.eventId, first?.eventId)
  assert.equal(first?.kind, 'turn_completed')
})

test('session.status idle maps to turn_completed and durable identity is deterministic', () => {
  const raw = { type: 'session.status', data: { sessionID: 's2', status: { type: 'idle' } }, durable: { aggregateID: 'session-s2', seq: 41 } } as any
  const event = mapOpenCodeEvent(raw)
  assert.equal(event?.kind, 'turn_completed')
  assert.equal(event?.sessionId, 's2')
  assert.equal(event?.eventId, 'session-s2:41')
})

test('event fallback never depends on wall clock or object key order', () => {
  const firstRaw = { type: 'session.idle', data: { sessionID: 's3', detail: { b: 2, a: 1 } }, location: { directory: '/tmp/project', workspace: 'w' } } as any
  const reordered = { location: { workspace: 'w', directory: '/tmp/project' }, data: { detail: { a: 1, b: 2 }, sessionID: 's3' }, type: 'session.idle' } as any
  const first = mapOpenCodeEvent(firstRaw)
  const second = mapOpenCodeEvent(reordered)
  assert.equal(first?.eventId, second?.eventId)
  assert.match(first?.eventId ?? '', /^opencode:/)
})

test('adapter startup preflights the host and event stream reconnects after failure', async () => {
  let activeCalls = 0
  let subscriptions = 0
  const client = {
    sessions: {
      active: async () => { activeCalls += 1; return {} },
    },
    skills: {},
    events: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        subscriptions += 1
        const attempt = subscriptions
        return (async function* () {
          if (attempt === 1) {
            yield { id: 'evt-one', type: 'session.idle', data: { sessionID: 'source' } }
            throw new Error('stream dropped')
          }
          yield { id: 'evt-two', type: 'session.status', data: { sessionID: 'source', status: { type: 'idle' } } }
          await new Promise<void>(resolve => {
            if (signal.aborted) { resolve(); return }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        })()
      },
    },
  } as any
  const adapter = new OpenCodeAgentAdapter({ clientFactory: () => client, reconnectMinMs: 5, reconnectMaxMs: 10 })
  const seen: string[] = []
  try {
    await adapter.start()
    assert.equal(activeCalls, 1)
    const stop = adapter.subscribe(event => { seen.push(event.eventId) })
    const deadline = Date.now() + 1_000
    while (seen.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    stop()
    assert.deepEqual(seen, ['evt-one', 'evt-two'])
    assert.ok(subscriptions >= 2)
  } finally { await adapter.dispose() }
})
