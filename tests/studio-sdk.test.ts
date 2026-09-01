import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createStudioScaffold,
  currentFlowitPackageVersion,
  flowitRuntimeVersionSatisfies,
  loadStudioPackage,
  packStudioProject,
  validateStudioProject,
} from '../src/studio/index.js'

test('Studio SDK scaffolds a project compatible with the Flowit version creating it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-sdk-'))
  try {
    const project = path.join(root, 'project')
    const descriptor = await createStudioScaffold(project, {
      id: 'acme.customer-research',
      displayName: 'Customer Research',
      publisherId: 'acme',
      hostId: 'codex',
    })
    assert.equal(
      flowitRuntimeVersionSatisfies(
        await currentFlowitPackageVersion(),
        descriptor.manifest.runtime.version,
      ),
      true,
    )
    const validation = await validateStudioProject(project)
    assert.equal(validation.valid, true)
    assert.deepEqual(validation.roles, ['worker'])
    assert.deepEqual(validation.nodes, ['work'])

    const packed = await packStudioProject(project, path.join(root, 'dist'))
    assert.equal(
      path.basename(packed.outputPath),
      'acme.customer-research-0.1.0.flowit',
    )
    assert.equal(
      (await loadStudioPackage(packed.outputPath)).manifest.supportedHosts[0],
      'codex',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Studio scaffold never overwrites a non-empty target without explicit force', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-sdk-force-'))
  const project = path.join(root, 'project')
  try {
    await createStudioScaffold(project, {
      id: 'acme.first',
      displayName: 'First',
      publisherId: 'acme',
    })
    await writeFile(path.join(project, 'user-note.txt'), 'keep me\n')
    await assert.rejects(
      () =>
        createStudioScaffold(project, {
          id: 'acme.second',
          displayName: 'Second',
          publisherId: 'acme',
        }),
      /not empty.*--force/,
    )
    assert.equal(await readFile(path.join(project, 'user-note.txt'), 'utf8'), 'keep me\n')

    const replaced = await createStudioScaffold(project, {
      id: 'acme.second',
      displayName: 'Second',
      publisherId: 'acme',
      force: true,
    })
    assert.equal(replaced.manifest.id, 'acme.second')
    await assert.rejects(() => readFile(path.join(project, 'user-note.txt'), 'utf8'), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
