import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { OpenCodeAgentAdapter, mapOpenCodeEvent } from '../../src/adapters/opencode.js'

test('pinned official OpenCode SDK exposes the V2 resources used by Flowit', () => {
  const client = createOpencodeClient({ baseUrl: 'http://example.invalid' })
  assert.equal(typeof client.v2.session.list, 'function')
  assert.equal(typeof client.v2.session.get, 'function')
  assert.equal(typeof client.v2.session.active, 'function')
  assert.equal(typeof client.v2.session.prompt, 'function')
  assert.equal(typeof client.v2.session.wait, 'function')
  assert.equal(typeof client.v2.session.context, 'function')
  assert.equal(typeof client.v2.skill.list, 'function')
  assert.equal(typeof client.v2.event.subscribe, 'function')
})

test('OpenCode host event ids remain stable across duplicate delivery', () => {
  const raw = { id: 'evt-stable-1', type: 'session.idle', data: { sessionID: 's1' } }
  const first = mapOpenCodeEvent(raw)
  const replay = mapOpenCodeEvent(structuredClone(raw))
  assert.equal(first?.eventId, 'evt-stable-1')
  assert.equal(replay?.eventId, first?.eventId)
  assert.equal(first?.kind, 'turn_completed')
})

test('official SDK property events and durable data events both normalize correctly', () => {
  const current = { id: 'evt-status', type: 'session.status', properties: { sessionID: 's2', status: { type: 'idle' } } }
  const currentEvent = mapOpenCodeEvent(current)
  assert.equal(currentEvent?.kind, 'turn_completed')
  assert.equal(currentEvent?.sessionId, 's2')
  assert.equal(currentEvent?.eventId, 'evt-status')

  const durable = { type: 'session.status', data: { sessionID: 's2', status: { type: 'idle' } }, durable: { aggregateID: 'session-s2', seq: 41 } }
  const durableEvent = mapOpenCodeEvent(durable)
  assert.equal(durableEvent?.kind, 'turn_completed')
  assert.equal(durableEvent?.sessionId, 's2')
  assert.equal(durableEvent?.eventId, 'session-s2:41')
})

test('event fallback never depends on wall clock or object key order', () => {
  const firstRaw = { type: 'session.idle', data: { sessionID: 's3', detail: { b: 2, a: 1 } }, location: { directory: '/tmp/project', workspace: 'w' } }
  const reordered = { location: { workspace: 'w', directory: '/tmp/project' }, data: { detail: { a: 1, b: 2 }, sessionID: 's3' }, type: 'session.idle' }
  const first = mapOpenCodeEvent(firstRaw)
  const second = mapOpenCodeEvent(reordered)
  assert.equal(first?.eventId, second?.eventId)
  assert.match(first?.eventId ?? '', /^opencode:/)
})

test('adapter startup preflights the host and event stream reconnects after failure', async () => {
  let activeCalls = 0
  let subscriptions = 0
  const client = {
    v2: {
      session: {
        active: async () => { activeCalls += 1; return { data: {} } },
      },
      skill: {},
      event: {
        subscribe: async ({ signal }: { signal: AbortSignal }) => {
          subscriptions += 1
          const attempt = subscriptions
          return {
            stream: (async function* () {
              if (attempt === 1) {
                yield { id: 'evt-one', type: 'session.idle', data: { sessionID: 'source' } }
                throw new Error('stream dropped')
              }
              yield { id: 'evt-two', type: 'session.status', properties: { sessionID: 'source', status: { type: 'idle' } } }
              await new Promise<void>(resolve => {
                if (signal.aborted) { resolve(); return }
                signal.addEventListener('abort', () => resolve(), { once: true })
              })
            })(),
          }
        },
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
