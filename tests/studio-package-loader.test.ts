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
  StudioPackageStore,
  flowitRuntimeVersionSatisfies,
  loadStudioPackage,
  parseStudioPackageManifest,
} from '../src/studio/index.js'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'acme.saas-intelligence',
    displayName: 'SaaS Intelligence',
    publisher: { id: 'acme' },
    version: '1.2.0',
    runtime: {
      id: 'flowit-workflow',
      version: '>=0.5.0-beta.2 <2',
      bootstrap: 'official',
    },
    supportedHosts: ['claude-code', 'codex'],
    entryPreset: 'saas-intelligence',
    license: { type: 'commercial-perpetual' },
    ...overrides,
  }
}

async function createPackage(root: string, value = manifest()): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(
    path.join(root, 'flowit.package.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  )
  await mkdir(path.join(root, 'roles'), { recursive: true })
  await writeFile(
    path.join(root, 'roles', 'researcher.md'),
    'Research carefully.\n',
    'utf8',
  )
}

test('manifest parser rejects publisher-controlled install hooks and unsafe runtime ranges', () => {
  assert.throws(
    () => parseStudioPackageManifest(manifest({ installScript: './install.sh' })),
    /unsupported fields: installScript/,
  )
  assert.throws(
    () =>
      parseStudioPackageManifest(
        manifest({
          runtime: {
            id: 'flowit-workflow',
            version: '>=1',
            bootstrap: 'official',
            url: 'https://example.invalid/runtime',
          },
        }),
      ),
    /manifest.runtime contains unsupported fields: url/,
  )
  assert.throws(
    () =>
      parseStudioPackageManifest(
        manifest({
          runtime: {
            id: 'flowit-workflow',
            version: '$(touch /tmp/pwn)',
            bootstrap: 'official',
          },
        }),
      ),
    /Flowit runtime range token/,
  )
})

test('Flowit runtime ranges use a bounded semantic-version comparator grammar', () => {
  assert.equal(
    flowitRuntimeVersionSatisfies('0.5.0-beta.2', '>=0.5.0-beta.2 <2'),
    true,
  )
  assert.equal(flowitRuntimeVersionSatisfies('2.0.0', '>=0.5.0-beta.2 <2'), false)
  assert.throws(
    () => flowitRuntimeVersionSatisfies('0.5.0-beta.2', '^0.5.0'),
    /full semantic version|numeric semantic-version components/,
  )
})

test('loader normalizes a valid declarative Studio manifest', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-load-'))
  try {
    await createPackage(dir)
    const descriptor = await loadStudioPackage(dir)
    assert.equal(descriptor.manifest.id, 'acme.saas-intelligence')
    assert.deepEqual(descriptor.manifest.supportedHosts, ['claude-code', 'codex'])
    assert.equal(descriptor.manifest.runtime.bootstrap, 'official')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('package store stages external bytes before review and commits the immutable snapshot', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-store-'))
  const source = path.join(dir, 'source')
  const storeRoot = path.join(dir, 'store')
  try {
    await createPackage(source)
    const store = new StudioPackageStore({ rootDir: storeRoot })
    const snapshot = await store.stageFromDirectory(source)

    await writeFile(
      path.join(source, 'roles', 'researcher.md'),
      'Source changed after review.\n',
      'utf8',
    )

    const first = await store.commitSnapshot(snapshot)
    const installedPrompt = await readFile(
      path.join(first.installDir, 'roles', 'researcher.md'),
      'utf8',
    )
    assert.match(installedPrompt, /Research carefully/)
    assert.doesNotMatch(installedPrompt, /Source changed/)

    const second = await store.installFromDirectory(first.installDir)
    assert.equal(first.installDir, second.installDir)
    assert.equal(first.digest, second.digest)
    assert.equal(
      first.installDir,
      path.join(storeRoot, 'acme', 'acme.saas-intelligence', '1.2.0'),
    )
    assert.equal((await store.listInstalled()).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('same publisher/id/version with different package bytes fails closed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-conflict-'))
  const firstSource = path.join(dir, 'first')
  const secondSource = path.join(dir, 'second')
  const store = new StudioPackageStore({ rootDir: path.join(dir, 'store') })
  try {
    await createPackage(firstSource)
    await createPackage(secondSource)
    await writeFile(
      path.join(secondSource, 'roles', 'researcher.md'),
      'Different package content.\n',
      'utf8',
    )
    await store.installFromDirectory(firstSource)
    await assert.rejects(
      () => store.installFromDirectory(secondSource),
      /already exists with different content/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('package store rejects symbolic links in the copied Flowit-owned snapshot', async t => {
  if (process.platform === 'win32') return t.skip('symlink privileges vary on Windows')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-symlink-'))
  const source = path.join(dir, 'source')
  try {
    await createPackage(source)
    await writeFile(path.join(dir, 'outside.txt'), 'outside\n', 'utf8')
    await symlink(path.join(dir, 'outside.txt'), path.join(source, 'escape.txt'))
    const store = new StudioPackageStore({ rootDir: path.join(dir, 'store') })
    await assert.rejects(
      () => store.stageFromDirectory(source),
      /must not contain symbolic links/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('commit rechecks a staged snapshot before atomic rename', async t => {
  if (process.platform === 'win32') return t.skip('symlink privileges vary on Windows')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-staged-race-'))
  const source = path.join(dir, 'source')
  const store = new StudioPackageStore({ rootDir: path.join(dir, 'store') })
  try {
    await createPackage(source)
    const snapshot = await store.stageFromDirectory(source)
    const prompt = path.join(snapshot.snapshotDir, 'roles', 'researcher.md')
    await rm(prompt)
    await writeFile(path.join(dir, 'outside.txt'), 'outside\n', 'utf8')
    await symlink(path.join(dir, 'outside.txt'), prompt)
    await assert.rejects(
      () => store.commitSnapshot(snapshot),
      /must not contain symbolic links/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
