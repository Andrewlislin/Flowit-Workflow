import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { preparePresetInstall } from '../src/preset/install.js'
import { createDefaultPresetRegistry } from '../src/preset/registry.js'

test('default activation schedule name follows the resolved pipeline name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-preset-schedule-name-'))
  const project = path.join(root, 'project')
  try {
    const plan = await preparePresetInstall({
      presetId: 'content-studio',
      pipelineName: 'Editorial Desk',
      adapterId: 'workbuddy',
      allSession: 'editorial-session',
      input: 'AI engineering',
      projectDir: project,
      storageFile: path.join(root, 'workflow.json'),
      scheduleMode: 'every',
      everySeconds: 3600,
    }, createDefaultPresetRegistry(), { cwd: project, homeDir: path.join(root, 'home'), env: {} })

    assert.equal(plan.schedule.scheduleName, 'Editorial Desk schedule')
    assert.equal(plan.schedule.action, 'create')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})