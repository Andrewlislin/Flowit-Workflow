import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

test('build emits the public Studio SDK and CLI artifacts declared by package.json', async () => {
  await assert.doesNotReject(access('dist/studio/index.js'))
  await assert.doesNotReject(access('dist/studio/index.d.ts'))
  await assert.doesNotReject(access('dist/studio/cli-entry.js'))

  const studio = await import('../../dist/studio/index.js') as Record<string, unknown>
  assert.equal(typeof studio.createStudioScaffold, 'function')
  assert.equal(typeof studio.validateStudioProject, 'function')
  assert.equal(typeof studio.packStudioProject, 'function')

  const cli = await readFile('dist/studio/cli-entry.js', 'utf8')
  assert.match(cli, /^#!\/usr\/bin\/env node/m)
})
