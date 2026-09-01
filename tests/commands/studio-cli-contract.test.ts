import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('package exposes the Studio SDK and dedicated Studio CLI entrypoint', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    exports?: Record<string, { types?: string; default?: string }>
    bin?: Record<string, string>
  }
  assert.deepEqual(manifest.exports?.['./studio'], {
    types: './dist/studio/index.d.ts',
    default: './dist/studio/index.js',
  })
  assert.equal(manifest.bin?.['flowit-studio'], 'dist/studio/cli-entry.js')
})

test('Studio CLI entry delegates argv to the reviewed Studio command dispatcher', async () => {
  const source = await readFile('src/studio/cli-entry.ts', 'utf8')
  assert.match(source, /^#!\/usr\/bin\/env node/m)
  assert.match(source, /runStudioCli\(process\.argv\.slice\(2\)\)/)
  assert.match(source, /process\.exitCode = 1/)
})
