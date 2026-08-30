import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function scripts(): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  return manifest.scripts ?? {}
}

test('build command preserves the reviewed workspace build order', async () => {
  const value = await scripts()
  assert.equal(value.build, 'pnpm run build:packages && pnpm run build:root')
})

test('test command builds before running the deterministic suite', async () => {
  const value = await scripts()
  assert.equal(value.test, 'pnpm run build && pnpm run test:raw')
})

test('the default raw suite includes command and build contracts', async () => {
  const value = await scripts()
  assert.match(value['test:raw'], /tests\/commands\/\*\.test\.ts/)
  assert.match(value['test:raw'], /tests\/build\/\*\.test\.ts/)
})

test('dependency installation has no automatic lifecycle build', async () => {
  const value = await scripts()

  for (const command of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(value[command], undefined)
  }
})
