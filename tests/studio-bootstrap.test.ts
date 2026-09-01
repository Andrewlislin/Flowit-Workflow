import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  OFFICIAL_FLOWIT_NPM_PACKAGE,
  OFFICIAL_FLOWIT_NPM_REGISTRY,
  bootstrapStudioRuntime,
  createStudioInstallIntent,
} from '../src/studio/index.js'

test('official bootstrap pins both default and CoaseEdge scope registries', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'flowit-bootstrap-'))
  let installs = 0
  const observed: readonly string[][] = [] as string[][]
  const runCommand = async (_command: string, args: readonly string[]) => {
    ;(observed as string[][]).push([...args])
    assert.ok(args.includes(`--registry=${OFFICIAL_FLOWIT_NPM_REGISTRY}`))
    assert.ok(
      args.includes(`--@coaseedgeltd:registry=${OFFICIAL_FLOWIT_NPM_REGISTRY}`),
    )
    if (args[0] === 'view') return { stdout: '"0.5.0-beta.2"\n', stderr: '' }
    if (args[0] === 'install') {
      installs += 1
      assert.ok(args.includes('--ignore-scripts'))
      const prefixIndex = args.indexOf('--prefix')
      const root = args[prefixIndex + 1]!
      const packageRoot = path.join(
        root,
        'node_modules',
        '@coaseedgeltd',
        'flowit-workflow',
      )
      await mkdir(path.join(packageRoot, 'dist', 'studio'), { recursive: true })
      await writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: OFFICIAL_FLOWIT_NPM_PACKAGE,
          version: '0.5.0-beta.2',
        }),
      )
      await writeFile(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n')
      await writeFile(
        path.join(packageRoot, 'dist', 'studio', 'cli-entry.js'),
        '#!/usr/bin/env node\n',
      )
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected command ${args.join(' ')}`)
  }

  try {
    const intent = createStudioInstallIntent({
      studioId: 'acme.studio',
      source: 'skillhub',
    })
    const range = '>=0.5.0-beta.2 <1'
    const first = await bootstrapStudioRuntime(intent, range, {
      homeDir,
      npmCommand: 'npm',
      runCommand,
    })
    const second = await bootstrapStudioRuntime(intent, range, {
      homeDir,
      npmCommand: 'npm',
      runCommand,
    })
    assert.equal(first.version, '0.5.0-beta.2')
    assert.equal(first.registry, OFFICIAL_FLOWIT_NPM_REGISTRY)
    assert.equal(first.reused, false)
    assert.equal(second.reused, true)
    assert.equal(installs, 1)
    assert.equal(
      first.rootDir,
      path.join(homeDir, '.flowit-workflow', 'runtime', 'versions', '0.5.0-beta.2'),
    )
    assert.ok(observed.some(args => args[0] === 'view'))
    assert.ok(observed.some(args => args[0] === 'install'))
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('bootstrap rejects an existing runtime without trusted provenance metadata', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'flowit-bootstrap-untrusted-'))
  try {
    const target = path.join(
      homeDir,
      '.flowit-workflow',
      'runtime',
      'versions',
      '0.5.0-beta.2',
    )
    const packageRoot = path.join(
      target,
      'node_modules',
      '@coaseedgeltd',
      'flowit-workflow',
    )
    await mkdir(path.join(packageRoot, 'dist', 'studio'), { recursive: true })
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: OFFICIAL_FLOWIT_NPM_PACKAGE,
        version: '0.5.0-beta.2',
      }),
    )
    await writeFile(path.join(packageRoot, 'dist', 'cli.js'), 'malicious\n')
    await writeFile(path.join(packageRoot, 'dist', 'studio', 'cli-entry.js'), 'malicious\n')

    const intent = createStudioInstallIntent({
      studioId: 'acme.studio',
      source: 'skillhub',
    })
    const runCommand = async (_command: string, args: readonly string[]) => {
      if (args[0] === 'view') return { stdout: '"0.5.0-beta.2"', stderr: '' }
      throw new Error('install must not proceed over an untrusted pre-existing runtime')
    }
    await assert.rejects(
      () =>
        bootstrapStudioRuntime(intent, '>=0.5.0-beta.2 <1', {
          homeDir,
          npmCommand: 'npm',
          runCommand,
        }),
      /predates trusted official provenance/,
    )
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})
