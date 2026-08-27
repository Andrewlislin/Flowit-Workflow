import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentAdapterRegistry } from '../src/core/adapter.js'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import { executeControl } from '../src/control.js'
import type { AgentAdapter, AgentDispatchRequest, AgentEvent } from '../src/core/types.js'

class StartupAdapter implements AgentAdapter {
  readonly id: string
  readonly capabilities = {
    coldResume: true,
    liveDispatch: true,
    skillBinding: true,
    contextReference: 'summary' as const,
    eventSubscription: true,
  }
  starts = 0
  subscriptions = 0
  aborted = false
  disposals = 0
  private resolveStart?: () => void
  private rejectStart?: (error: Error) => void
  readonly gate = new Promise<void>((resolve, reject) => {
    this.resolveStart = resolve
    this.rejectStart = reject
  })
  constructor(
    id = 'startup',
    private readonly ignoreAbort = false,
  ) {
    this.id = id
  }
  async start(signal?: AbortSignal): Promise<void> {
    this.starts += 1
    if (this.ignoreAbort || !signal) {
      await this.gate
      return
    }
    signal.throwIfAborted()
    await Promise.race([
      this.gate,
      new Promise<never>((_, reject) => {
        const abort = (): void => {
          this.aborted = true
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        signal.addEventListener('abort', abort, { once: true })
        void this.gate
          .finally(() => signal.removeEventListener('abort', abort))
          .catch(() => undefined)
      }),
    ])
  }
  succeed(): void {
    this.resolveStart?.()
  }
  fail(error: Error): void {
    this.rejectStart?.(error)
  }
  async listSessions() {
    return [{ adapterId: this.id, sessionId: 's1', status: 'idle' as const }]
  }
  async dispatch(request: AgentDispatchRequest) {
    return { sessionId: request.sessionId, loadedSkills: request.skills, referencedSessions: [] }
  }
  subscribe(_listener: (event: AgentEvent) => Promise<void> | void): () => void {
    this.subscriptions += 1
    return () => {
      this.subscriptions -= 1
    }
  }
  async dispose(): Promise<void> {
    this.disposals += 1
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition timed out')
}

test('core.ready waits for adapter start before event subscriptions become active', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-ready-'))
  const adapter = new StartupAdapter()
  const core = new FlowitOrchestrationCore(
    { storageFile: path.join(root, 'state.json'), defaultAdapterId: adapter.id },
    [adapter],
  )
  try {
    await waitUntil(() => adapter.starts === 1)
    assert.equal(adapter.subscriptions, 0)
    adapter.succeed()
    await core.ready
    assert.equal(adapter.subscriptions, 1)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('adapter startup failure rejects core.ready and never advertises an event subscription', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-ready-fail-'))
  const adapter = new StartupAdapter()
  const core = new FlowitOrchestrationCore(
    { storageFile: path.join(root, 'state.json'), defaultAdapterId: adapter.id },
    [adapter],
  )
  try {
    await waitUntil(() => adapter.starts === 1)
    adapter.fail(new Error('host unavailable'))
    await assert.rejects(core.ready, /host unavailable/)
    assert.equal(adapter.subscriptions, 0)
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('dispose aborts a startup that would otherwise never finish', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-ready-abort-'))
  const adapter = new StartupAdapter()
  const core = new FlowitOrchestrationCore(
    { storageFile: path.join(root, 'state.json'), defaultAdapterId: adapter.id },
    [adapter],
  )
  try {
    await waitUntil(() => adapter.starts === 1)
    await core.dispose()
    assert.equal(adapter.aborted, true)
    await assert.rejects(core.ready, /disposed|abort/i)
  } finally {
    adapter.succeed()
    await rm(root, { recursive: true, force: true })
  }
})

test('inactive control plane starts a host lazily when a host operation is requested', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-ready-control-'))
  const adapter = new StartupAdapter()
  const core = new FlowitOrchestrationCore(
    {
      storageFile: path.join(root, 'state.json'),
      defaultAdapterId: adapter.id,
      activeWorkers: false,
    },
    [adapter],
  )
  try {
    await core.ready
    assert.equal(adapter.starts, 0)
    adapter.succeed()
    const sessions = (await executeControl(core, {
      op: 'sessions.list',
      adapterId: adapter.id,
    })) as Array<{ sessionId: string }>
    assert.equal(adapter.starts, 1)
    assert.equal(sessions[0]?.sessionId, 's1')
  } finally {
    await core.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('same-id adapter replacement fences an old generation even when its start ignores abort', async () => {
  const registry = new AgentAdapterRegistry()
  const first = new StartupAdapter('same', true)
  const removeFirst = registry.register(first)
  const firstStart = registry.start(first)
  await waitUntil(() => first.starts === 1)
  removeFirst()
  await assert.rejects(firstStart, /unregistered/)

  const second = new StartupAdapter('same')
  registry.register(second)
  second.succeed()
  await registry.start(second)
  assert.equal(second.starts, 1)
  assert.equal(registry.require('same'), second)

  first.succeed()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(registry.require('same'), second)
  await registry.dispose()
})

test('unregister disposes the removed adapter generation', async () => {
  const registry = new AgentAdapterRegistry()
  const adapter = new StartupAdapter('disposable')
  adapter.succeed()
  const unregister = registry.register(adapter)
  await registry.start(adapter)
  unregister()
  await waitUntil(() => adapter.disposals === 1)
  assert.equal(registry.get(adapter.id), undefined)
  await registry.dispose()
  assert.equal(adapter.disposals, 1)
})
