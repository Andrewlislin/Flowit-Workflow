import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createRuntimeHandoffArgs,
  OFFICIAL_FLOWIT_NPM_PACKAGE,
  OFFICIAL_FLOWIT_NPM_REGISTRY,
  StudioRuntimeHandoffRequired,
  prepareStudioForCurrentAgent,
} from '../src/studio/index.js'

async function createIncompatibleStudio(root: string): Promise<void> {
  await mkdir(path.join(root, 'presets'), { recursive: true })
  await mkdir(path.join(root, 'roles'), { recursive: true })
  await writeFile(
    path.join(root, 'flowit.package.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme.future-studio',
      displayName: 'Future Studio A',
      publisher: { id: 'acme' },
      version: '1.0.0',
      runtime: {
        id: 'flowit-workflow',
        version: '>=1.0.0 <2',
        bootstrap: 'official',
      },
      supportedHosts: ['claude-code'],
      entryPreset: 'future-studio',
      license: { type: 'freeware' },
    }),
  )
  await writeFile(
    path.join(root, 'presets', 'future-studio.json'),
    JSON.stringify({
      version: 1,
      id: 'future-studio',
      displayName: 'Future Studio A',
      description: 'Future runtime Studio',
      input: { required: false, label: 'Goal' },
      roles: [{ id: 'worker', displayName: 'Worker', description: 'Work' }],
      nodes: [{ id: 'work', roleId: 'worker', promptFile: 'roles/worker.md' }],
      edges: [],
    }),
  )
  await writeFile(path.join(root, 'roles', 'worker.md'), 'ORIGINAL A\n')
}

test('runtime handoff preserves the exact frozen Studio snapshot instead of reopening source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-consumer-runtime-'))
  const source = path.join(root, 'studio')
  const homeDir = path.join(root, 'home')
  const storeRoot = path.join(root, 'store')
  await createIncompatibleStudio(source)

  const runCommand = async (_command: string, args: readonly string[]) => {
    assert.ok(args.includes(`--registry=${OFFICIAL_FLOWIT_NPM_REGISTRY}`))
    if (args[0] === 'view') return { stdout: '"1.2.0"\n', stderr: '' }
    if (args[0] === 'install') {
      const prefixIndex = args.indexOf('--prefix')
      const runtimeRoot = args[prefixIndex + 1]!
      const packageRoot = path.join(
        runtimeRoot,
        'node_modules',
        '@coaseedgeltd',
        'flowit-workflow',
      )
      await mkdir(path.join(packageRoot, 'dist', 'studio'), { recursive: true })
      await writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: OFFICIAL_FLOWIT_NPM_PACKAGE, version: '1.2.0' }),
      )
      await writeFile(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n')
      await writeFile(
        path.join(packageRoot, 'dist', 'studio', 'cli-entry.js'),
        '#!/usr/bin/env node\n',
      )
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected npm command: ${args.join(' ')}`)
  }

  let handoff: StudioRuntimeHandoffRequired | undefined
  try {
    try {
      await prepareStudioForCurrentAgent(
        { sourceRoot: source, storeRoot, sourceLabel: '/downloads/studio' },
        {
          homeDir,
          bootstrap: { homeDir, npmCommand: 'npm', runCommand },
        },
      )
    } catch (error: unknown) {
      if (error instanceof StudioRuntimeHandoffRequired) handoff = error
      else throw error
    }
    assert.ok(handoff)
    assert.equal(handoff.runtime.version, '1.2.0')
    assert.equal(handoff.requiredRange, '>=1.0.0 <2')
    assert.equal(handoff.runtime.registry, OFFICIAL_FLOWIT_NPM_REGISTRY)
    assert.equal(handoff.sourceLabel, '/downloads/studio')

    await writeFile(path.join(source, 'roles', 'worker.md'), 'REPLACEMENT B\n')
    assert.equal(
      await readFile(path.join(handoff.snapshot.snapshotDir, 'roles', 'worker.md'), 'utf8'),
      'ORIGINAL A\n',
    )

    const childArgs = createRuntimeHandoffArgs(
      ['install', source, '--store', storeRoot, '--source=untrusted-replacement'],
      handoff,
    )
    assert.equal(childArgs[0], 'install')
    assert.equal(childArgs[1], handoff.snapshot.snapshotDir)
    assert.ok(childArgs.includes(`--handoff-digest=${handoff.snapshot.digest}`))
    assert.ok(childArgs.includes('--source=/downloads/studio'))
    assert.equal(childArgs.includes(source), false)

    // A child that sees different bytes at the handoff path must fail before runtime/Host work.
    await writeFile(path.join(handoff.snapshot.snapshotDir, 'roles', 'worker.md'), 'TAMPERED\n')
    await assert.rejects(
      () =>
        prepareStudioForCurrentAgent(
          {
            sourceRoot: handoff!.snapshot.snapshotDir,
            storeRoot,
            expectedSourceDigest: handoff!.snapshot.digest,
            sourceLabel: handoff!.sourceLabel,
          },
          { homeDir },
        ),
      /handoff snapshot digest does not match/,
    )
  } finally {
    if (handoff) await handoff.releaseSnapshot().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
