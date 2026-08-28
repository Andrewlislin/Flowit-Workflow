import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  HostSetupRegistry,
  WorkBuddySetupProvider,
  applySetupMutation,
  prepareSetupMutation,
  type HostSetupContext,
} from '../src/setup/index.js'

async function fixture(): Promise<{
  root: string
  home: string
  project: string
  context: HostSetupContext
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-workbuddy-owned-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  await mkdir(path.join(packageRoot, 'dist'), { recursive: true })
  await mkdir(
    path.join(packageRoot, 'integrations', 'workbuddy', 'flowit-bridge-worker'),
    { recursive: true },
  )
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  await writeFile(path.join(packageRoot, 'dist', 'mcp-server.js'), '// mcp\n', 'utf8')
  await writeFile(path.join(packageRoot, 'dist', 'cli.js'), '// cli\n', 'utf8')
  await writeFile(
    path.join(packageRoot, 'integrations', 'workbuddy', 'flowit-bridge-worker', 'SKILL.md'),
    '---\nname: Flowit Workflow Bridge Worker\ndescription: test\n---\nworker\n',
    'utf8',
  )
  return {
    root,
    home,
    project,
    context: {
      cwd: project,
      homeDir: home,
      packageRoot,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: '22.20.0',
      env: { FLOWIT_WORKFLOW_WORKBUDDY_DRIVER: 'driver' },
    },
  }
}

test('setup never claims or uninstalls identical WorkBuddy assets without ownership proof', async () => {
  const f = await fixture()
  try {
    const registry = new HostSetupRegistry([new WorkBuddySetupProvider()])
    const options = { target: 'workbuddy', scope: 'user' as const, projectDir: f.project }

    // Seed the exact desired bytes, then remove the ownership manifest. This models a user or
    // older deployment that already configured Flowit identically but did not grant this
    // installer ownership of those assets.
    await applySetupMutation(
      await prepareSetupMutation('setup', f.context, registry, options),
      f.context,
      registry,
      true,
    )
    const manifestFile = path.join(
      f.home,
      '.flowit-workflow',
      'setup',
      'workbuddy-user.json',
    )
    await rm(manifestFile)

    const adopt = await prepareSetupMutation('setup', f.context, registry, options)
    assert.deepEqual(adopt.plans[0]?.actions.map(row => row.id), ['write-manifest'])
    await applySetupMutation(adopt, f.context, registry, true)

    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.mcpEntry, undefined)
    assert.equal(manifest.hookEntry, undefined)
    assert.equal(manifest.skillHash, undefined)

    const uninstall = await prepareSetupMutation('uninstall', f.context, registry, options)
    assert.deepEqual(uninstall.plans[0]?.actions.map(row => row.id), ['remove-manifest'])
    await applySetupMutation(uninstall, f.context, registry, true)

    const mcpFile = path.join(f.home, '.workbuddy', 'mcp.json')
    const mcp = JSON.parse(await readFile(mcpFile, 'utf8')) as Record<string, any>
    assert.equal(mcp.mcpServers['flowit-workflow'].env.FLOWIT_WORKFLOW_ADAPTER, 'workbuddy')
    await readFile(
      path.join(
        f.home,
        '.codebuddy',
        'skills',
        'flowit-workflow-bridge-worker',
        'SKILL.md',
      ),
      'utf8',
    )
    const settings = JSON.parse(
      await readFile(path.join(f.home, '.codebuddy', 'settings.json'), 'utf8'),
    ) as Record<string, any>
    assert.equal(settings.hooks.SessionStart.length, 1)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
