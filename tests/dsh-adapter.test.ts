import assert from 'node:assert/strict'
import test from 'node:test'
import { DshAgentAdapter } from '../src/adapters/dsh.js'

function request() {
  return {
    correlationId: 'dsh-correlation',
    sessionId: 'dsh-session',
    prompt: 'do work',
    skills: [],
    contextRefs: [],
  }
}

function fakeHarness(initialStatus: 'idle' | 'running' = 'idle') {
  let idleResolve: (() => void) | undefined
  let followups = 0
  const cancellations: Array<{ cause: unknown; options: unknown }> = []
  const agent: any = {
    id: 'dsh-session',
    status: initialStatus,
    session: { header: { id: 'dsh-session', cwd: '/tmp' } },
    followup() {
      followups += 1
      agent.status = 'running'
    },
    inject() {},
    whenIdle() {
      if (agent.status === 'idle') return Promise.resolve()
      return new Promise<void>(resolve => {
        idleResolve = resolve
      })
    },
    cancel(cause: unknown, options: unknown) {
      cancellations.push({ cause, options })
      agent.status = 'idle'
      idleResolve?.()
      idleResolve = undefined
    },
  }
  const ctx: any = {
    agents: {
      get: () => agent,
      roots: () => [agent],
      resume: async () => ({ agent, dispose: async () => undefined }),
    },
    skills: { get: async () => undefined },
    on: () => () => undefined,
  }
  return { ctx, agent, cancellations, followups: () => followups }
}

async function nextTurn(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('DSH adapter refuses dispatch into an already-running session', async () => {
  const harness = fakeHarness('running')
  const adapter = new DshAgentAdapter(harness.ctx)
  assert.equal(adapter.capabilities.liveDispatch, false)
  await assert.rejects(adapter.dispatch(request()), /already running|refuses concurrent dispatch/)
  assert.equal(harness.followups(), 0)
  assert.equal(harness.cancellations.length, 0)
})

test('DSH adapter cancels the owned turn when the orchestration signal is lost', async () => {
  const harness = fakeHarness('idle')
  const adapter = new DshAgentAdapter(harness.ctx)
  const controller = new AbortController()
  const dispatch = adapter.dispatch(request(), controller.signal)
  await nextTurn()
  assert.equal(harness.followups(), 1)
  controller.abort(new Error('lease lost'))
  await assert.rejects(dispatch, /lease lost/)
  assert.deepEqual(harness.cancellations, [
    { cause: { kind: 'parent' }, options: { keepInbox: true } },
  ])
})
