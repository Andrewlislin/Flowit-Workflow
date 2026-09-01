import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { builtInPreset } from '../src/preset/builtins.js'
import type { PresetRoleBinding } from '../src/preset/types.js'
import {
  COMMUNITY_STUDIO_IDS,
  communityStudioRoot,
  loadDeclarativeStudioPreset,
  loadStudioPackage,
  validateCommunityStudios,
} from '../src/studio/index.js'

test('all built-in Community work modes ship as valid Studio Package v1 applications', async () => {
  const results = await validateCommunityStudios(path.resolve('.'))
  assert.deepEqual(
    results.map(result => result.presetId),
    [...COMMUNITY_STUDIO_IDS],
  )
  assert.deepEqual(
    results.map(result => result.descriptor.manifest.metadata?.legacyPresetId),
    [...COMMUNITY_STUDIO_IDS],
  )
  for (const result of results) {
    assert.equal(result.descriptor.manifest.publisher.id, 'coaseedge')
    assert.equal(result.descriptor.manifest.license.type, 'open-source')
  }
})

test('Community Studio topology remains structurally compatible with the legacy built-in work modes', async () => {
  for (const id of COMMUNITY_STUDIO_IDS) {
    const descriptor = await loadStudioPackage(communityStudioRoot(path.resolve('.'), id))
    const packaged = (await loadDeclarativeStudioPreset(descriptor)).definition
    const legacy = builtInPreset(id)
    assert.ok(legacy, `missing legacy preset ${id}`)
    assert.deepEqual(
      packaged.roles.map(role => role.id),
      legacy.roles.map(role => role.id),
      `${id} role order drifted`,
    )

    const bindings = Object.fromEntries(
      packaged.roles.map((role, index) => [
        role.id,
        {
          roleId: role.id,
          adapterId: 'claude-code',
          sessionId: `session-${index}`,
          skills: [],
        } satisfies PresetRoleBinding,
      ]),
    )
    const request = {
      pipelineName: `Compatibility ${id}`,
      workspace: '/tmp/flowit-community-compatibility',
      ...(packaged.inputRequired ? { input: 'Compatibility input' } : {}),
      bindings,
    }
    const packagedPipeline = packaged.render(request)
    const legacyPipeline = legacy.render(request)
    assert.deepEqual(shape(packagedPipeline), shape(legacyPipeline), `${id} topology drifted`)
  }
})

test('Community content Studio retains the human-review publishing boundary', async () => {
  const descriptor = await loadStudioPackage(
    communityStudioRoot(path.resolve('.'), 'content-studio'),
  )
  const definition = (await loadDeclarativeStudioPreset(descriptor)).definition
  const bindings = Object.fromEntries(
    definition.roles.map((role, index) => [
      role.id,
      {
        roleId: role.id,
        adapterId: 'claude-code',
        sessionId: `session-${index}`,
        skills: [],
      } satisfies PresetRoleBinding,
    ]),
  )
  const pipeline = definition.render({
    pipelineName: 'Content boundary',
    workspace: '/tmp/flowit-content-boundary',
    bindings,
  })
  const editor = pipeline.nodes.at(-1)
  assert.equal(editor?.id, 'editor')
  assert.match(editor?.target.prompt ?? '', /Do not publish|human-review/i)
})

function shape(pipeline: {
  nodes: readonly {
    id: string
    target: { adapterId?: string; sessionId: string }
    inheritUpstreamContext: boolean
  }[]
  edges: readonly { from: string; to: string }[]
}) {
  return {
    nodes: pipeline.nodes.map(node => ({
      id: node.id,
      adapterId: node.target.adapterId,
      sessionId: node.target.sessionId,
      inheritUpstreamContext: node.inheritUpstreamContext,
    })),
    edges: pipeline.edges.map(edge => ({ ...edge })),
  }
}
