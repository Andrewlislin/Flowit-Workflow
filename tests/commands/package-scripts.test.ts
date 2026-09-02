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

test('release validation commands preserve the reviewed pack order', async () => {
  const value = await scripts()
  assert.equal(value['check:pack'], 'node scripts/check-package-packs.mjs')
  assert.equal(value['check:release'], 'node scripts/check-release-artifacts.mjs')
  assert.ok(value.check.indexOf('npm run check:pack') < value.check.indexOf('npm run check:release'))
})

test('release command contract targets v0.5.0-beta.4', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version?: string }
  assert.equal(manifest.version, '0.5.0-beta.4')

  const notes = await readFile(`docs/releases/v${manifest.version}.md`, 'utf8')
  assert.match(notes, /^# Flowit Workflow v0\.5\.0-beta\.4$/m)
})

test('release workflow publishes the exact organization package set', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8')
  const expectedPackages = [
    '@coaseedgeltd/flowit-core',
    '@coaseedgeltd/flowit-adapter-file-bridge',
    '@coaseedgeltd/flowit-adapter-claude-code',
    '@coaseedgeltd/flowit-adapter-codex',
    '@coaseedgeltd/flowit-adapter-opencode',
    '@coaseedgeltd/flowit-adapter-dsh',
    '@coaseedgeltd/flowit-adapter-workbuddy',
    '@coaseedgeltd/flowit-adapter-doubao-office',
    '@coaseedgeltd/flowit-workflow',
  ]
  const publishCommands = [...workflow.matchAll(/publish_one '([^']+)' "([^"]+)"/g)]

  assert.deepEqual(publishCommands.map(match => match[1]), expectedPackages)
  assert.deepEqual(
    publishCommands.map(match => match[2]),
    expectedPackages.map(name =>
      `.tmp-packs/${name.slice(1).replace('/', '-')}-\${VERSION}.tgz`,
    ),
  )
  assert.match(workflow, /npm dist-tag add "\$\{package_name\}@\$\{VERSION\}" latest/)
  assert.doesNotMatch(workflow, /@coaseedge\//)
})
