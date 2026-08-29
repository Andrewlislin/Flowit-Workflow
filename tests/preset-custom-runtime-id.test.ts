import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { preparePresetInstall } from '../src/preset/install.js'
import { PresetRegistry } from '../src/preset/registry.js'
import type { PresetDefinition } from '../src/preset/types.js'

const customPreset: PresetDefinition = {
  version: 1,
  id: 'custom-runtime-id',
  displayName: 'Custom Runtime Id',
  description: 'Exercises runtime adapter normalization for custom presets.',
  roles: [{ id: 'worker', displayName: 'Worker', description: 'Run one step.' }],
  inputRequired: false,
  inputLabel: 'Optional input',
  render(request) {
    const binding = request.bindings.worker
    if (!binding) throw new Error('missing worker binding')
    return {
      name: request.pipelineName,
      trigger: { kind: 'manual' },
      nodes: [{
        id: 'worker',
        target: {
          adapterId: binding.adapterId,
          sessionId: binding.sessionId,
          prompt: 'work',
          skills: [...binding.skills],
          contextRefs: [],
        },
        inheritUpstreamContext: false,
      }],
      edges: [],
    }
  },
}

test('custom preset render output maps DSH setup id to the Harness runtime adapter id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-custom-preset-runtime-id-'))
  try {
    const plan = await preparePresetInstall({
      presetId: customPreset.id,
      adapterId: 'dsh',
      allSession: 'dsh-session',
      projectDir: root,
      storageFile: path.join(root, 'workflow.json'),
    }, new PresetRegistry([customPreset]), { cwd: root, homeDir: root, env: {} })

    assert.equal(plan.action, 'create')
    assert.equal(plan.pipeline?.nodes[0]?.target.adapterId, 'deepseek-harness')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
