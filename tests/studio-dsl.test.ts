import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  loadDeclarativeStudioPreset,
  loadStudioPackage,
  parseStudioPresetDsl,
} from '../src/studio/index.js'

async function createStudio(
  root: string,
  supportedHosts: readonly string[] = ['claude-code'],
): Promise<void> {
  await mkdir(path.join(root, 'presets'), { recursive: true })
  await mkdir(path.join(root, 'roles'), { recursive: true })
  await writeFile(
    path.join(root, 'flowit.package.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme.research',
      displayName: 'ACME Research',
      publisher: { id: 'acme' },
      version: '1.0.0',
      runtime: {
        id: 'flowit-workflow',
        version: '>=0.5.0-beta.2 <2',
        bootstrap: 'official',
      },
      supportedHosts,
      entryPreset: 'deep-research',
      license: { type: 'commercial-perpetual' },
    }),
  )
  await writeFile(
    path.join(root, 'presets', 'deep-research.json'),
    JSON.stringify({
      version: 1,
      id: 'deep-research',
      displayName: 'Deep Research',
      description: 'Evidence-first research',
      input: { required: true, label: 'Research question' },
      roles: [
        {
          id: 'researcher',
          displayName: 'Researcher',
          description: 'Collect evidence',
        },
        {
          id: 'reviewer',
          displayName: 'Reviewer',
          description: 'Review evidence',
        },
      ],
      nodes: [
        {
          id: 'research',
          roleId: 'researcher',
          promptFile: 'roles/researcher.md',
          skills: ['web'],
        },
        {
          id: 'review',
          roleId: 'reviewer',
          promptFile: 'roles/reviewer.md',
        },
      ],
      edges: [{ from: 'research', to: 'review' }],
    }),
  )
  await writeFile(
    path.join(root, 'roles', 'researcher.md'),
    'Research {{input}} and write into {{workspace}}.\n',
  )
  await writeFile(
    path.join(root, 'roles', 'reviewer.md'),
    'Review {{pipelineName}}.\n',
  )
}

test('declarative Studio DSL compiles into the existing Preset/Pipeline contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-dsl-'))
  try {
    await createStudio(root)
    const descriptor = await loadStudioPackage(root)
    const { definition } = await loadDeclarativeStudioPreset(descriptor)
    const pipeline = definition.render({
      pipelineName: 'Customer research',
      workspace: '/tmp/workspace',
      input: 'Agent workflow platforms',
      bindings: {
        researcher: {
          roleId: 'researcher',
          adapterId: 'claude-code',
          sessionId: 's1',
          skills: ['sources'],
        },
        reviewer: {
          roleId: 'reviewer',
          adapterId: 'claude-code',
          sessionId: 's2',
          skills: [],
        },
      },
    })
    assert.equal(pipeline.trigger.kind, 'manual')
    assert.equal(pipeline.nodes.length, 2)
    assert.match(pipeline.nodes[0]!.target.prompt, /Agent workflow platforms/)
    assert.deepEqual(pipeline.nodes[0]!.target.skills, ['web', 'sources'])
    assert.deepEqual(pipeline.edges, [{ from: 'research', to: 'review' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('declarative Studio uses the same Setup Host to runtime Adapter normalization as built-ins', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-dsh-'))
  try {
    await createStudio(root, ['dsh'])
    const descriptor = await loadStudioPackage(root)
    const { definition } = await loadDeclarativeStudioPreset(descriptor)
    const pipeline = definition.render({
      pipelineName: 'DSH research',
      workspace: '/tmp/workspace',
      input: 'Question',
      bindings: {
        researcher: {
          roleId: 'researcher',
          adapterId: 'dsh',
          sessionId: 's1',
          skills: [],
        },
        reviewer: {
          roleId: 'reviewer',
          adapterId: 'dsh',
          sessionId: 's2',
          skills: [],
        },
      },
    })
    assert.deepEqual(
      pipeline.nodes.map(node => node.target.adapterId),
      ['deepseek-harness', 'deepseek-harness'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Studio entry preset must itself be a regular package file', async t => {
  if (process.platform === 'win32') return t.skip('symlink privileges vary on Windows')
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-entry-symlink-'))
  const outside = path.join(os.tmpdir(), `outside-${path.basename(root)}.json`)
  try {
    await createStudio(root)
    const entry = path.join(root, 'presets', 'deep-research.json')
    await writeFile(outside, await readFile(entry))
    await rm(entry)
    await symlink(outside, entry)
    const descriptor = await loadStudioPackage(root)
    await assert.rejects(
      () => loadDeclarativeStudioPreset(descriptor),
      /entry preset must be a regular package file/,
    )
  } finally {
    await rm(outside, { force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('Studio DSL rejects cycles and package path escapes', () => {
  assert.throws(
    () =>
      parseStudioPresetDsl({
        version: 1,
        id: 'bad',
        displayName: 'Bad',
        description: 'Bad graph',
        input: { required: false, label: 'Input' },
        roles: [{ id: 'worker', displayName: 'Worker', description: 'Work' }],
        nodes: [
          { id: 'a', roleId: 'worker', promptFile: 'roles/a.md' },
          { id: 'b', roleId: 'worker', promptFile: 'roles/b.md' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    /acyclic/,
  )
  assert.throws(
    () =>
      parseStudioPresetDsl({
        version: 1,
        id: 'bad-path',
        displayName: 'Bad path',
        description: 'Bad path',
        input: { required: false, label: 'Input' },
        roles: [{ id: 'worker', displayName: 'Worker', description: 'Work' }],
        nodes: [{ id: 'a', roleId: 'worker', promptFile: '../outside.md' }],
        edges: [],
      }),
    /must stay inside/,
  )
})
