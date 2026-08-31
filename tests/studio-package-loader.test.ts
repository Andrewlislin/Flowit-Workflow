import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  StudioPackageStore,
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
    runtime: { id: 'flowit-workflow', version: '>=1.0 <2', bootstrap: 'official' },
    supportedHosts: ['claude-code', 'codex'],
    entryPreset: 'saas-intelligence',
    license: { type: 'commercial-perpetual' },
    ...overrides,
  }
}

async function createPackage(root: string, value = manifest()): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'flowit.package.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await mkdir(path.join(root, 'roles'), { recursive: true })
  await writeFile(path.join(root, 'roles', 'researcher.md'), 'Research carefully.\n', 'utf8')
}

test('manifest parser rejects publisher-controlled install hooks', () => {
  assert.throws(
    () => parseStudioPackageManifest(manifest({ installScript: './install.sh' })),
    /unsupported fields: installScript/,
  )
  assert.throws(
    () =>
      parseStudioPackageManifest(
        manifest({ runtime: { id: 'flowit-workflow', version: '>=1', bootstrap: 'official', url: 'https://example.invalid/runtime' } }),
      ),
    /manifest.runtime contains unsupported fields: url/,
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

test('package store copies a safe package into Flowit-owned storage and reuses identical installs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-store-'))
  const source = path.join(dir, 'source')
  const storeRoot = path.join(dir, 'store')
  try {
    await createPackage(source)
    const store = new StudioPackageStore({ rootDir: storeRoot })
    const first = await store.installFromDirectory(source)
    const second = await store.installFromDirectory(source)
    assert.equal(first.installDir, second.installDir)
    assert.equal(first.installDir, path.join(storeRoot, 'acme', 'acme.saas-intelligence', '1.2.0'))
    assert.match(await readFile(path.join(first.installDir, 'roles', 'researcher.md'), 'utf8'), /Research carefully/)
    assert.equal((await store.listInstalled()).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('package store rejects symbolic links before copying third-party content', async t => {
  if (process.platform === 'win32') return t.skip('symlink privileges vary on Windows')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-symlink-'))
  const source = path.join(dir, 'source')
  try {
    await createPackage(source)
    await writeFile(path.join(dir, 'outside.txt'), 'outside\n', 'utf8')
    await symlink(path.join(dir, 'outside.txt'), path.join(source, 'escape.txt'))
    const store = new StudioPackageStore({ rootDir: path.join(dir, 'store') })
    await assert.rejects(() => store.installFromDirectory(source), /must not contain symbolic links/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
