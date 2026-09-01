import assert from 'node:assert/strict'
import test from 'node:test'
import { McpPeer } from '../src/mcp/peer.js'

test('MCP peer issues server requests and consumes exact responses', async () => {
  const sent: any[] = []
  const peer = new McpPeer(message => sent.push(message), {
    idPrefix: 'flowit:test',
    defaultTimeoutMs: 1_000,
  })
  try {
    const pending = peer.request('elicitation/create', { message: 'approve?' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].jsonrpc, '2.0')
    assert.equal(sent[0].method, 'elicitation/create')
    assert.match(sent[0].id, /^flowit:test:/)

    assert.equal(peer.acceptResponse({
      jsonrpc: '2.0',
      id: sent[0].id,
      result: { action: 'accept', content: { approve: true } },
    }), true)
    assert.deepEqual(await pending, {
      action: 'accept',
      content: { approve: true },
    })
  } finally {
    peer.dispose()
  }
})

test('MCP peer swallows unknown responses but not incoming Host requests', () => {
  const peer = new McpPeer(() => undefined)
  try {
    assert.equal(peer.acceptResponse({ id: 'unknown', result: {} }), true)
    assert.equal(peer.acceptResponse({ id: 1, method: 'tools/list', params: {} }), false)
    assert.equal(peer.acceptResponse({ method: 'notifications/initialized' }), false)
  } finally {
    peer.dispose()
  }
})

test('MCP peer timeout, abort, and disposal reject pending requests', async () => {
  const timeoutPeer = new McpPeer(() => undefined, { defaultTimeoutMs: 20 })
  await assert.rejects(
    timeoutPeer.request('elicitation/create', {}),
    /timed out/,
  )
  timeoutPeer.dispose()

  const abortPeer = new McpPeer(() => undefined)
  const controller = new AbortController()
  const aborted = abortPeer.request('elicitation/create', {}, controller.signal)
  controller.abort(new Error('test abort'))
  await assert.rejects(aborted, /test abort/)
  abortPeer.dispose()

  const disposePeer = new McpPeer(() => undefined)
  const disposed = disposePeer.request('elicitation/create', {})
  disposePeer.dispose(new Error('connection closed'))
  await assert.rejects(disposed, /connection closed/)
  await assert.rejects(
    disposePeer.request('elicitation/create', {}),
    /connection closed/,
  )
})
