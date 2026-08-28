import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JsonWorkflowStore } from '../src/core/store.js'
import { parsePresetCliArgs } from '../src/preset/cli.js'
import { applyPresetInstall, preparePresetInstall } from '../src/preset/install.js'
import { createDefaultPresetRegistry } from '../src/preset/registry.js'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-preset-schedule-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const storage = path.join(root, 'workflow.json')
  return {
    root,
    home,
    project,
    storage,
    runtime: { cwd: project, homeDir: home, env: {} },
    registry: createDefaultPresetRegistry(),
  }
}

function contentOptions(projectDir: string, storageFile: string) {
  return {
    presetId: 'content-studio',
    pipelineName: 'Scheduled Content Studio',
    adapterId: 'workbuddy',
    allSession: 'editorial-session',
    input: 'AI engineering',
    projectDir,
    storageFile,
  } as const
}

test('preset CLI parses daily, weekday, and interval activation controls', () => {
  const parsed = parsePresetCliArgs([
    'install',
    'content-studio',
    '--adapter=workbuddy',
    '--session=all=session-1',
    '--schedule=weekdays',
    '--time=08:30',
    '--timezone=Asia/Shanghai',
    '--schedule-name=Morning editorial run',
    '--dry-run',
  ], '/tmp/project')
  assert.equal(parsed.install?.scheduleMode, 'weekdays')
  assert.equal(parsed.install?.scheduleTime, '08:30')
  assert.equal(parsed.install?.timeZone, 'Asia/Shanghai')
  assert.equal(parsed.install?.scheduleName, 'Morning editorial run')

  const every = parsePresetCliArgs([
    'install', 'agent-team', '--schedule=every', '--every-seconds=3600', '--help',
  ])
  assert.equal(every.install?.scheduleMode, 'every')
  assert.equal(every.install?.everySeconds, 3600)
})

test('preset install creates a pipeline schedule without executing the pipeline', async () => {
  const f = await fixture()
  try {
    const plan = await preparePresetInstall({
      ...contentOptions(f.project, f.storage),
      scheduleMode: 'daily',
      scheduleTime: '08:00',
      timeZone: 'UTC',
      scheduleName: 'Daily Content Studio',
    }, f.registry, f.runtime)
    assert.equal(plan.action, 'create')
    assert.equal(plan.schedule.action, 'create')
    assert.deepEqual(plan.schedule.timing, {
      kind: 'calendar',
      timeZone: 'UTC',
      hour: 8,
      minute: 0,
    })

    const result = await applyPresetInstall(plan)
    assert.equal(result.action, 'created')
    assert.equal(result.scheduleAction, 'created')
    assert.ok(result.scheduleId)
    assert.ok(result.nextRunAt)

    const state = await new JsonWorkflowStore(f.storage).snapshot()
    assert.equal(state.pipelines.length, 1)
    assert.equal(state.schedules.length, 1)
    assert.equal(state.runs.length, 0)
    assert.equal(state.schedules[0]?.pipelineId, state.pipelines[0]?.id)
    assert.deepEqual(state.schedules[0]?.timing, {
      kind: 'calendar',
      timeZone: 'UTC',
      hour: 8,
      minute: 0,
    })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('reinstall reuses both the identical pipeline and its identical schedule', async () => {
  const f = await fixture()
  try {
    const options = {
      ...contentOptions(f.project, f.storage),
      scheduleMode: 'weekdays' as const,
      scheduleTime: '09:15',
      timeZone: 'UTC',
      scheduleName: 'Weekday Content Studio',
    }
    const firstPlan = await preparePresetInstall(options, f.registry, f.runtime)
    const first = await applyPresetInstall(firstPlan)
    const secondPlan = await preparePresetInstall(options, f.registry, f.runtime)
    assert.equal(secondPlan.action, 'reuse')
    assert.equal(secondPlan.schedule.action, 'reuse')
    assert.equal(secondPlan.existingPipelineId, first.pipelineId)
    assert.equal(secondPlan.schedule.existingScheduleId, first.scheduleId)

    const second = await applyPresetInstall(secondPlan)
    assert.equal(second.action, 'reused')
    assert.equal(second.scheduleAction, 'reused')
    const state = await new JsonWorkflowStore(f.storage).snapshot()
    assert.equal(state.pipelines.length, 1)
    assert.equal(state.schedules.length, 1)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('manual preset activation remains the default and creates no schedule', async () => {
  const f = await fixture()
  try {
    const plan = await preparePresetInstall(contentOptions(f.project, f.storage), f.registry, f.runtime)
    assert.equal(plan.schedule.mode, 'manual')
    assert.equal(plan.schedule.action, 'none')
    const result = await applyPresetInstall(plan)
    assert.equal(result.scheduleAction, 'none')
    const state = await new JsonWorkflowStore(f.storage).snapshot()
    assert.equal(state.schedules.length, 0)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('preset schedule name conflicts fail closed instead of replacing automation', async () => {
  const f = await fixture()
  try {
    const base = contentOptions(f.project, f.storage)
    await applyPresetInstall(await preparePresetInstall({
      ...base,
      scheduleMode: 'daily',
      scheduleTime: '08:00',
      timeZone: 'UTC',
      scheduleName: 'Content Automation',
    }, f.registry, f.runtime))

    await assert.rejects(
      preparePresetInstall({
        ...base,
        scheduleMode: 'daily',
        scheduleTime: '09:00',
        timeZone: 'UTC',
        scheduleName: 'Content Automation',
      }, f.registry, f.runtime),
      /schedule name .*already used by a different or ambiguous definition/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('calendar activation requires an explicit clock time and intervals enforce the safety floor', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      preparePresetInstall({
        ...contentOptions(f.project, f.storage),
        scheduleMode: 'daily',
      }, f.registry, f.runtime),
      /requires --time=HH:MM/,
    )
    await assert.rejects(
      preparePresetInstall({
        ...contentOptions(f.project, f.storage),
        scheduleMode: 'every',
        everySeconds: 30,
      }, f.registry, f.runtime),
      /every-seconds=<integer >= 60>/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})