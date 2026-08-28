import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FlowitOrchestrationCore } from '../src/core/runtime.js'
import { JsonWorkflowStore } from '../src/core/store.js'
import type {
  AgentAdapter,
  AgentDispatchRequest,
  AgentDispatchResult,
} from '../src/core/types.js'
import { applyPresetInstall, preparePresetInstall } from '../src/preset/install.js'
import { createDefaultPresetRegistry } from '../src/preset/registry.js'

class HarnessRuntimeAdapter implements AgentAdapter {
  readonly id = 'deepseek-harness'
  readonly capabilities = {
    coldResume: true,
    liveDispatch: false,
    skillBinding: true,
    contextReference: 'native' as const,
    eventSubscription: false,
  }
  readonly requests: AgentDispatchRequest[] = []

  async listSessions() {
    return [{ adapterId: this.id, sessionId: 'dsh-session', status: 'idle' as const }]
  }

  async dispatch(request: AgentDispatchRequest): Promise<AgentDispatchResult> {
    this.requests.push(request)
    return {
      sessionId: request.sessionId,
      loadedSkills: request.skills,
      referencedSessions: request.contextRefs.map(ref => ref.sessionId),
      outputSummary: 'done',
    }
  }
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition timed out')
}

test('scheduled DSH preset persists runtime adapter ids and resolves in the Harness registry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-dsh-scheduled-preset-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  try {
    const plan = await preparePresetInstall({
      presetId: 'agent-team',
      adapterId: 'dsh',
      allSession: 'dsh-session',
      input: 'Review a repository',
      projectDir: project,
      scheduleMode: 'every',
      everySeconds: 60,
    }, createDefaultPresetRegistry(), { cwd: project, homeDir: home, env: {} })

    assert.equal(plan.storageFile, path.join(home, '.flowit-workflow', 'dsh', 'workflow.json'))
    assert.equal(
      plan.pipeline?.nodes.every(node => node.target.adapterId === 'deepseek-harness'),
      true,
    )

    const installed = await applyPresetInstall(plan)
    assert.ok(installed.scheduleId)

    const store = new JsonWorkflowStore(plan.storageFile)
    await store.transact(state => {
      const schedule = state.schedules.find(item => item.id === installed.scheduleId)
      assert.ok(schedule)
      schedule.nextRunAt = new Date(Date.now() + 200).toISOString()
      schedule.updatedAt = new Date().toISOString()
    })

    const adapter = new HarnessRuntimeAdapter()
    const runtime = new FlowitOrchestrationCore(
      {
        storageFile: plan.storageFile,
        defaultAdapterId: adapter.id,
        workerId: 'dsh-preset-runtime',
        leaseDurationMs: 1_000,
      },
      [adapter],
    )
    try {
      await runtime.ready
      await waitUntil(() => adapter.requests.length === 4)
      await waitUntil(async () => Boolean(
        (await runtime.store.snapshot()).schedules.find(item => item.id === installed.scheduleId)
          ?.lastRunAt,
      ))
      assert.equal(adapter.requests.every(request => request.sessionId === 'dsh-session'), true)
    } finally {
      await runtime.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
