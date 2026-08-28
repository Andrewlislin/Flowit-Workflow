import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DshSetupProvider,
  createDefaultHostSetupRegistry,
  type HostSetupContext,
  type SetupApplyOptions,
  type SetupRequestOptions,
} from '../src/setup/index.js'
import {
  DSH_BLOCK_BEGIN,
  DSH_BLOCK_END,
  dshSetupPaths,
  extractDshManagedBlock,
  removeDshManagedBlock,
} from '../src/setup/providers/dsh-state.js'

interface Fixture {
  root: string
  home: string
  project: string
  packageRoot: string
  context: HostSetupContext
  provider: DshSetupProvider
}

async function fixture(env: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-dsh-setup-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  const bin = path.join(root, 'bin')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(path.join(packageRoot, 'dist', 'dsh'), { recursive: true }),
    mkdir(bin, { recursive: true }),
  ])
  await writeFile(path.join(packageRoot, 'dist', 'dsh', 'plugin.js'), '// fixture\n', 'utf8')
  const dshName = process.platform === 'win32' ? 'dsh.exe' : 'dsh'
  await writeFile(path.join(bin, dshName), '', 'utf8')
  const context: HostSetupContext = {
    cwd: project,
    homeDir: home,
    packageRoot,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    env: { PATH: bin, ...env },
  }
  return { root, home, project, packageRoot, context, provider: new DshSetupProvider() }
}

const userOptions = (projectDir: string): SetupRequestOptions => ({ scope: 'user', projectDir })
const userApply = (projectDir: string): SetupApplyOptions => ({
  scope: 'user', projectDir, assumeYes: true,
})
const projectOptions = (projectDir: string): SetupRequestOptions => ({ scope: 'project', projectDir })
const projectApply = (projectDir: string): SetupApplyOptions => ({
  scope: 'project', projectDir, assumeYes: true,
})

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

test('default setup registry includes the DeepSeek Harness provider', () => {
  assert.equal(createDefaultHostSetupRegistry().get('dsh') instanceof DshSetupProvider, true)
})

test('DeepSeek Harness user setup appends a native plugin to the home patch without replacing user entries', async () => {
  const f = await fixture()
  const paths = dshSetupPaths(f.context, userOptions(f.project))
  const original = `# user patch\n- insert:\n    - id: custom-tool\n      name: "custom-tool"\n`
  try {
    await mkdir(path.dirname(paths.patchFile), { recursive: true })
    await writeFile(paths.patchFile, original, 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions.map(row => row.id), ['write-manifest', 'upsert-plugin-patch'])
    assert.equal(plan.actions.every(row => row.requiresConfirmation), true)

    const result = await f.provider.applySetup(f.context, plan, userApply(f.project))
    assert.equal(result.status, 'complete')
    const content = await readFile(paths.patchFile, 'utf8')
    assert.equal(content.startsWith(original), true)
    assert.match(content, new RegExp(DSH_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(content, /id: flowit-workflow/)
    assert.match(content, /allowModelMutations: true/)
    assert.match(content, new RegExp(path.basename(paths.storageFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const second = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(second.actions, [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('DeepSeek Harness project scope creates an explicit --patch overlay and leaves the home patch untouched', async () => {
  const f = await fixture()
  const paths = dshSetupPaths(f.context, projectOptions(f.project))
  try {
    const plan = await f.provider.planSetup(f.context, projectOptions(f.project))
    assert.equal(plan.manualSteps.some(step => /--patch/.test(step)), true)
    const result = await f.provider.applySetup(f.context, plan, projectApply(f.project))
    assert.equal(result.status, 'manual-action-required')
    assert.equal(await exists(paths.patchFile), true)
    assert.equal(await exists(path.join(f.home, '.dsh', 'cordis.patch.yml')), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('DeepSeek Harness setup honors DSH_HOME for the persistent user patch layer', async () => {
  const customHome = path.join(os.tmpdir(), `flowit-dsh-home-${Date.now()}-${Math.random()}`)
  const f = await fixture({ DSH_HOME: customHome })
  try {
    const paths = dshSetupPaths(f.context, userOptions(f.project))
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, plan, userApply(f.project))
    assert.equal(paths.patchFile, path.join(customHome, 'cordis.patch.yml'))
    assert.equal(await exists(paths.patchFile), true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(customHome, { recursive: true, force: true })
  }
})

test('DeepSeek Harness setup refuses an unmanaged existing Flowit plugin entry', async () => {
  const f = await fixture()
  const paths = dshSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(path.dirname(paths.patchFile), { recursive: true })
    await writeFile(paths.patchFile, '- insert:\n    - id: flowit-workflow\n      name: "custom"\n', 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions, [])
    assert.equal(plan.warnings.some(warning => /unmanaged Flowit plugin entry/i.test(warning)), true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('DeepSeek Harness apply rejects a stale plan after unrelated patch changes', async () => {
  const f = await fixture()
  const paths = dshSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(path.dirname(paths.patchFile), { recursive: true })
    await writeFile(paths.patchFile, '- insert:\n    - id: one\n      name: "one"\n', 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    await writeFile(paths.patchFile, '- insert:\n    - id: two\n      name: "two"\n', 'utf8')
    await assert.rejects(
      f.provider.applySetup(f.context, plan, userApply(f.project)),
      /changed after planning|changed while setup was running/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('DeepSeek Harness repair restores a missing installer-owned patch block', async () => {
  const f = await fixture()
  const paths = dshSetupPaths(f.context, userOptions(f.project))
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    const installed = await readFile(paths.patchFile, 'utf8')
    await writeFile(paths.patchFile, removeDshManagedBlock(installed), 'utf8')

    const report = await f.provider.doctor(f.context, userOptions(f.project))
    assert.equal(report.status, 'unhealthy')
    const repair = await f.provider.planRepair(f.context, report, userOptions(f.project))
    assert.equal(repair.actions.some(row => row.id === 'upsert-plugin-patch'), true)
    const repaired = await f.provider.applyRepair(f.context, repair, userApply(f.project))
    assert.equal(repaired.status, 'complete')
    assert.notEqual(extractDshManagedBlock(await readFile(paths.patchFile, 'utf8')), undefined)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('DeepSeek Harness uninstall removes only its block and retains other home patch content and workflow state', async () => {
  const f = await fixture()
  const paths = dshSetupPaths(f.context, userOptions(f.project))
  const original = '# keep\n- insert:\n    - id: other\n      name: "other"\n'
  try {
    await mkdir(path.dirname(paths.patchFile), { recursive: true })
    await writeFile(paths.patchFile, original, 'utf8')
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    await mkdir(path.dirname(paths.storageFile), { recursive: true })
    await writeFile(paths.storageFile, '{"history":true}\n', 'utf8')

    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    const result = await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(result.status, 'complete')
    assert.equal(await readFile(paths.patchFile, 'utf8'), original)
    assert.equal(await exists(paths.storageFile), true)
    assert.equal(await exists(paths.setupManifestFile), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('DeepSeek Harness uninstall preserves a user-modified owned patch and reports partial cleanup', async () => {
  const f = await fixture()
  const paths = dshSetupPaths(f.context, userOptions(f.project))
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    const installed = await readFile(paths.patchFile, 'utf8')
    await writeFile(paths.patchFile, installed.replace('allowModelMutations: true', 'allowModelMutations: false'), 'utf8')

    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    assert.equal(uninstall.actions.some(row => row.id === 'remove-plugin-patch'), false)
    const result = await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(result.status, 'partial')
    assert.match(await readFile(paths.patchFile, 'utf8'), /allowModelMutations: false/)
    assert.equal(await exists(paths.setupManifestFile), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('DeepSeek Harness setup fails closed on malformed Flowit ownership markers', async () => {
  const f = await fixture()
  const paths = dshSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(path.dirname(paths.patchFile), { recursive: true })
    await writeFile(paths.patchFile, `${DSH_BLOCK_BEGIN}\n- insert:\n`, 'utf8')
    await assert.rejects(
      f.provider.planSetup(f.context, userOptions(f.project)),
      /malformed or duplicate Flowit ownership markers/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('DeepSeek Harness setup refuses a non-sequence home patch instead of guessing YAML structure', async () => {
  const f = await fixture()
  const paths = dshSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(path.dirname(paths.patchFile), { recursive: true })
    await writeFile(paths.patchFile, 'plugins:\n  flowit: true\n', 'utf8')
    await assert.rejects(
      f.provider.planSetup(f.context, userOptions(f.project)),
      /not a top-level YAML patch sequence/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('DeepSeek Harness setup can stage configuration when no dsh executable is installed', async () => {
  const f = await fixture({ PATH: '' })
  try {
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    const result = await f.provider.applySetup(f.context, plan, userApply(f.project))
    assert.equal(result.status, 'manual-action-required')
    assert.equal(result.manualSteps.some(step => /npx @deepseek-ai\/dsh|dump-config/.test(step)), true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
