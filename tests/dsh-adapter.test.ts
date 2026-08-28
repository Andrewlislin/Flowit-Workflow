import assert from 'node:assert/strict'
import test from 'node:test'
import { DshAgentAdapter } from '../src/adapters/dsh.js'

function request(skills: string[] = []) {
  return {
    correlationId: 'dsh-correlation',
    sessionId: 'dsh-session',
    prompt: 'do work',
    skills,
    contextRefs: [],
  }
}

interface FakeHarnessOptions {
  initialStatus?: 'idle' | 'running'
  skillLookup?: (name: string) => Promise<unknown>
  autoStart?: boolean
}

function fakeHarness(options: FakeHarnessOptions = {}) {
  type Listener = (...args: any[]) => void
  const listeners = new Map<string, Set<Listener>>()
  const on = (name: string, listener: Listener): (() => void) => {
    const rows = listeners.get(name) ?? new Set<Listener>()
    rows.add(listener)
    listeners.set(name, rows)
    return () => rows.delete(listener)
  }
  const emit = (name: string, ...args: any[]): void => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
  }

  let maintenance = false
  let wakeRequested = false
  let nextTurnNumber = 0
  let currentTurn: number | undefined
  let followups = 0
  const nextTurn: any[] = []
  const nextStep: any[] = []
  const cancellations: Array<{ cause: unknown; options: unknown }> = []
  const session: any = {
    header: { id: 'dsh-session', cwd: '/tmp' },
    events: [] as any[],
  }

  const removeMessage = (id: string): boolean => {
    for (const rows of [nextTurn, nextStep]) {
      const index = rows.findIndex(message => message.id === id)
      if (index < 0) continue
      const [message] = rows.splice(index, 1)
      emit('agent/inbox/discarded', { agent, message })
      return true
    }
    return false
  }

  const insertMessage = (target: 'next-turn' | 'next-step', message: any): void => {
    const rows = target === 'next-turn' ? nextTurn : nextStep
    rows.push(message)
    emit('agent/inbox/inserted', { agent, message })
  }

  const startDriver = (): void => {
    if (maintenance) {
      wakeRequested = true
      return
    }
    if (agent.status === 'running' || (!nextTurn.length && !nextStep.length)) return
    agent.status = 'running'
    currentTurn = ++nextTurnNumber
    const claimed = [...nextStep.splice(0), ...nextTurn.splice(0, 1)]
    for (const message of claimed) {
      emit('agent/inbox/claimed', { agent, message, turn: currentTurn })
    }
  }

  const finishCurrentTurn = (kind: 'completed' | 'aborted' = 'completed'): void => {
    if (currentTurn === undefined) throw new Error('no current turn')
    const turn = currentTurn
    const event = {
      type: 'turn/end',
      data: {
        turn,
        reason: kind === 'completed' ? { kind } : { kind, reason: { kind: 'parent' } },
      },
    }
    session.events.push(event)
    emit('session/event', session, event)
    currentTurn = undefined
    agent.status = 'idle'
  }

  const agent: any = {
    id: 'dsh-session',
    status: options.initialStatus ?? 'idle',
    session,
    inbox: {
      get nextTurn() {
        return nextTurn
      },
      get nextStep() {
        return nextStep
      },
      get hasPending() {
        return nextTurn.length > 0 || nextStep.length > 0
      },
      remove: removeMessage,
    },
    followup(message: any) {
      followups += 1
      insertMessage('next-turn', message)
      if (options.autoStart === false) wakeRequested = true
      else startDriver()
    },
    inject(message: any) {
      insertMessage('next-step', message)
    },
    runMaintenance(job: (signal: AbortSignal) => Promise<unknown>) {
      if (agent.status === 'running' || maintenance)
        throw new Error(`agent "${agent.id}" already has active work`)
      maintenance = true
      const controller = new AbortController()
      return (async () => {
        try {
          return await job(controller.signal)
        } finally {
          maintenance = false
          if (wakeRequested && options.autoStart !== false) {
            wakeRequested = false
            startDriver()
          }
        }
      })()
    },
    whenIdle() {
      return Promise.resolve()
    },
    cancel(cause: unknown, cancelOptions: unknown) {
      cancellations.push({ cause, options: cancelOptions })
      if (currentTurn !== undefined) finishCurrentTurn('aborted')
    },
  }

  const ctx: any = {
    agents: {
      get: () => agent,
      roots: () => [agent],
      resume: async () => ({ agent, dispose: async () => undefined }),
    },
    skills: {
      get: async (name: string) => options.skillLookup?.(name),
    },
    on,
  }

  return {
    ctx,
    agent,
    cancellations,
    followups: () => followups,
    finishCurrentTurn,
    startExternalTurn(): void {
      if (agent.status === 'running') throw new Error('agent already running')
      agent.status = 'running'
      currentTurn = ++nextTurnNumber
    },
    steerExternal(): void {
      insertMessage('next-step', {
        id: 'external-steer',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'external' }],
      })
    },
  }
}

async function nextTurn(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('DSH adapter refuses dispatch into an already-running session', async () => {
  const harness = fakeHarness({ initialStatus: 'running' })
  const adapter = new DshAgentAdapter(harness.ctx)
  assert.equal(adapter.capabilities.liveDispatch, false)
  await assert.rejects(adapter.dispatch(request()), /already running|refuses concurrent dispatch/)
  assert.equal(harness.followups(), 0)
  assert.equal(harness.cancellations.length, 0)
})

test('DSH adapter cancels only after its identified prompt owns the active turn', async () => {
  const harness = fakeHarness()
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

test('DSH adapter removes an unclaimed Flowit prompt without cancelling host work', async () => {
  const harness = fakeHarness({ autoStart: false })
  const adapter = new DshAgentAdapter(harness.ctx)
  const controller = new AbortController()
  const dispatch = adapter.dispatch(request(), controller.signal)
  await nextTurn()
  assert.equal(harness.followups(), 1)
  controller.abort(new Error('lease lost before claim'))
  await assert.rejects(dispatch, /lease lost before claim/)
  assert.equal(harness.agent.inbox.hasPending, false)
  assert.equal(harness.cancellations.length, 0)
})

test('DSH adapter does not cancel a later external turn after its turn has ended', async () => {
  const harness = fakeHarness()
  const adapter = new DshAgentAdapter(harness.ctx)
  const controller = new AbortController()
  const dispatch = adapter.dispatch(request(), controller.signal)
  await nextTurn()
  harness.finishCurrentTurn()
  harness.startExternalTurn()
  controller.abort(new Error('late lease loss'))
  await assert.rejects(dispatch, /late lease loss/)
  assert.equal(harness.cancellations.length, 0)
  assert.equal(harness.agent.status, 'running')
})

test('DSH adapter rechecks exclusive ownership after asynchronous Skill loading', async () => {
  let resolveSkill: ((value: unknown) => void) | undefined
  const skillGate = new Promise<unknown>(resolve => {
    resolveSkill = resolve
  })
  const harness = fakeHarness({ skillLookup: async () => skillGate })
  const adapter = new DshAgentAdapter(harness.ctx)
  const dispatch = adapter.dispatch(request(['slow-skill']))
  await nextTurn()
  harness.startExternalTurn()
  resolveSkill?.({
    name: 'slow-skill',
    description: 'slow',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime',
    provider: 'test',
    content: 'instructions',
  })
  await assert.rejects(dispatch, /already running|active work/)
  assert.equal(harness.followups(), 0)
  assert.equal(harness.cancellations.length, 0)
})

test('DSH adapter never cancels a turn after unrelated steering joins it', async () => {
  const harness = fakeHarness()
  const adapter = new DshAgentAdapter(harness.ctx)
  const controller = new AbortController()
  const dispatch = adapter.dispatch(request(), controller.signal)
  await nextTurn()
  harness.steerExternal()
  controller.abort(new Error('lease lost after external steer'))
  assert.equal(harness.cancellations.length, 0)
  harness.finishCurrentTurn()
  await assert.rejects(dispatch, /mixed-ownership|unrelated host steering/)
  assert.equal(harness.cancellations.length, 0)
})
