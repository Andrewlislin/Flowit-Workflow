import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import {
  assertOutputOutsideSource,
  createStudioScaffold,
  packStudioProject,
  runStudioCli,
} from '../src/studio/index.js'

function capture(): { stdout: Writable; read: () => string } {
  let text = ''
  return {
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString()
        callback()
      },
    }),
    read: () => text,
  }
}

test('artifact fence rejects source/output overlap in both directions before mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-pack-fence-'))
  const project = path.join(root, 'studio')
  try {
    await createStudioScaffold(project, {
      id: 'acme.pack-safe',
      displayName: 'Pack Safe',
      publisherId: 'acme',
    })
    await assert.rejects(
      () => packStudioProject(project, project),
      /must be disjoint from the Studio source tree/,
    )
    await assert.rejects(
      () => assertOutputOutsideSource(project, root, 'Ancestor output'),
      /must be disjoint from the Studio source tree/,
    )
    assert.match(await readFile(path.join(project, 'flowit.package.json'), 'utf8'), /acme\.pack-safe/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('artifact fence resolves existing symlink aliases before overlap comparison', async t => {
  if (process.platform === 'win32') return t.skip('symlink privileges vary on Windows')
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-pack-alias-'))
  const project = path.join(root, 'studio')
  const alias = path.join(root, 'alias')
  try {
    await createStudioScaffold(project, {
      id: 'acme.pack-alias',
      displayName: 'Pack Alias',
      publisherId: 'acme',
    })
    await symlink(project, alias, 'dir')
    await assert.rejects(
      () => assertOutputOutsideSource(project, path.join(alias, 'dist'), 'Alias output'),
      /must be disjoint from the Studio source tree/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cd studio && flowit-studio pack . chooses a safe default outside the source tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-pack-default-'))
  const project = path.join(root, 'studio')
  try {
    await createStudioScaffold(project, {
      id: 'acme.pack-default',
      displayName: 'Pack Default',
      publisherId: 'acme',
    })
    const output = capture()
    await runStudioCli(['pack', '.', '--json'], { cwd: project, stdout: output.stdout })
    const result = JSON.parse(output.read()) as { outputPath: string }
    const relative = path.relative(project, result.outputPath)
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`))
    assert.match(await readFile(path.join(project, 'flowit.package.json'), 'utf8'), /acme\.pack-default/)
    assert.match(await readFile(path.join(result.outputPath, 'flowit.package.json'), 'utf8'), /acme\.pack-default/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
