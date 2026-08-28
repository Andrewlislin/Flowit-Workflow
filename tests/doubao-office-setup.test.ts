import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DoubaoOfficeSetupProvider,
  createDefaultHostSetupRegistry,
  type HostSetupContext,
  type SetupApplyOptions,
  type SetupRequestOptions,
} from '../src/setup/index.js'
import {
  DOUBAO_OFFICE_SKILL_NAME,
  doubaoOfficeSetupPaths,
} from '../src/setup/providers/doubao-office-state.js'
import { WORKBUDDY_BRIDGE_DIRS } from '../src/setup/providers/workbuddy-files.js'

interface Fixture {
  root: string
  home: string
  project: string
  packageRoot: string
  context: HostSetupContext
  provider: DoubaoOfficeSetupProvider
  skillContent: string
}

async function fixture(env: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-doubao-setup-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  const skillDir = path.join(
    packageRoot,
    'integrations',
    'doubao-office',
    DOUBAO_OFFICE_SKILL_NAME,
  )
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(skillDir, { recursive: true }),
  ])
  const skillContent = `---\nname: Flowit Workflow Bridge Worker\ndescription: fixture\n---\n\n# Worker\n`
  await writeFile(path.join(skillDir, 'SKILL.md'), skillContent, 'utf8')
  const context: HostSetupContext = {
    cwd: project,
    homeDir: home,
    packageRoot,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    env: { ...env },
  }
  return {
    root,
    home,
    project,
    packageRoot,
    context,
    provider: new DoubaoOfficeSetupProvider(),
    skillContent,
  }
}

const userOptions = (projectDir: string): SetupRequestOptions => ({ scope: 'user', projectDir })
const userApply = (projectDir: string): SetupApplyOptions => ({ scope: 'user', projectDir, assumeYes: true })
const projectOptions = (projectDir: string): SetupRequestOptions => ({ scope: 'project', projectDir })
const projectApply = (projectDir: string): SetupApplyOptions => ({ scope: 'project', projectDir, assumeYes: true })

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

test('default setup registry includes the 豆包办公 provider', () => {
  assert.equal(
    createDefaultHostSetupRegistry().get('doubao-office') instanceof DoubaoOfficeSetupProvider,
    true,
  )
})

test('豆包办公 user setup stages the Worker, creates durable Bridge directories, and is idempotent', async () => {
  const f = await fixture()
  const paths = doubaoOfficeSetupPaths(f.context, userOptions(f.project))
  try {
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions.map(row => row.id), [
      'write-manifest',
      'write-staged-skill',
      'ensure-bridge-directories',
    ])
    assert.equal(plan.actions.every(row => row.requiresConfirmation), true)

    const result = await f.provider.applySetup(f.context, plan, userApply(f.project))
    assert.equal(result.status, 'manual-action-required')
    assert.equal(await readFile(paths.stagedSkillFile, 'utf8'), f.skillContent)
    for (const directory of WORKBUDDY_BRIDGE_DIRS) {
      assert.equal(await exists(path.join(paths.bridgeRoot, directory)), true)
    }
    assert.equal(result.manualSteps.some(step => /import\/enable/i.test(step)), true)
    assert.equal(result.manualSteps.some(step => /scheduled task/i.test(step)), true)

    const second = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(second.actions, [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('豆包办公 setup deploys to an explicitly configured managed Skill directory', async () => {
  const managedDir = path.join(os.tmpdir(), `flowit-doubao-managed-${Date.now()}-${Math.random()}`)
  const f = await fixture({ FLOWIT_WORKFLOW_DOUBAO_SKILL_DIR: managedDir })
  const paths = doubaoOfficeSetupPaths(f.context, userOptions(f.project))
  try {
    assert.equal(paths.managedSkillFile, path.join(managedDir, 'SKILL.md'))
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.equal(plan.actions.some(row => row.id === 'write-managed-skill'), true)
    const result = await f.provider.applySetup(f.context, plan, userApply(f.project))
    assert.equal(result.status, 'manual-action-required')
    assert.equal(await readFile(path.join(managedDir, 'SKILL.md'), 'utf8'), f.skillContent)
    assert.equal(result.manualSteps.some(step => /managed Flowit Bridge Worker Skill/i.test(step)), true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(managedDir, { recursive: true, force: true })
  }
})

test('豆包办公 project scope stages the Skill in the project while keeping shared Bridge state in the user home', async () => {
  const f = await fixture()
  const paths = doubaoOfficeSetupPaths(f.context, projectOptions(f.project))
  try {
    const plan = await f.provider.planSetup(f.context, projectOptions(f.project))
    const result = await f.provider.applySetup(f.context, plan, projectApply(f.project))
    assert.equal(result.status, 'manual-action-required')
    assert.equal(paths.stagedSkillFile.startsWith(path.join(f.project, '.flowit-workflow')), true)
    assert.equal(paths.bridgeRoot, path.join(f.home, '.flowit-workflow', 'bridges', 'doubao-office'))
    assert.equal(await exists(paths.stagedSkillFile), true)
    assert.equal(
      await exists(path.join(f.home, '.flowit-workflow', 'integrations', 'doubao-office', DOUBAO_OFFICE_SKILL_NAME, 'SKILL.md')),
      false,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('豆包办公 setup fails closed on a conflicting unowned managed Skill', async () => {
  const managedDir = path.join(os.tmpdir(), `flowit-doubao-conflict-${Date.now()}-${Math.random()}`)
  const f = await fixture({ FLOWIT_WORKFLOW_DOUBAO_SKILL_DIR: managedDir })
  try {
    await mkdir(managedDir, { recursive: true })
    await writeFile(path.join(managedDir, 'SKILL.md'), '# custom user skill\n', 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions, [])
    assert.equal(plan.warnings.some(warning => /not owned by Flowit setup/i.test(warning)), true)
    assert.equal(await readFile(path.join(managedDir, 'SKILL.md'), 'utf8'), '# custom user skill\n')
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(managedDir, { recursive: true, force: true })
  }
})

test('豆包办公 setup never claims an identical pre-existing managed Skill without ownership proof', async () => {
  const managedDir = path.join(os.tmpdir(), `flowit-doubao-identical-${Date.now()}-${Math.random()}`)
  const f = await fixture({ FLOWIT_WORKFLOW_DOUBAO_SKILL_DIR: managedDir })
  const paths = doubaoOfficeSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(managedDir, { recursive: true })
    await writeFile(path.join(managedDir, 'SKILL.md'), f.skillContent, 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.equal(plan.actions.some(row => row.id === 'write-managed-skill'), false)
    await f.provider.applySetup(f.context, plan, userApply(f.project))

    const manifest = JSON.parse(await readFile(paths.setupManifestFile, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.ownedManagedSkillHash, undefined)
    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    assert.equal(uninstall.actions.some(row => row.id === 'remove-managed-skill'), false)
    await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(await readFile(path.join(managedDir, 'SKILL.md'), 'utf8'), f.skillContent)
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(managedDir, { recursive: true, force: true })
  }
})

test('豆包办公 apply rejects a stale plan when the staged Skill changes after planning', async () => {
  const f = await fixture()
  const paths = doubaoOfficeSetupPaths(f.context, userOptions(f.project))
  try {
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    await mkdir(path.dirname(paths.stagedSkillFile), { recursive: true })
    await writeFile(paths.stagedSkillFile, '# appeared after plan\n', 'utf8')
    await assert.rejects(
      f.provider.applySetup(f.context, plan, userApply(f.project)),
      /changed after planning|changed while setup was running/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('豆包办公 repair restores a missing installer-owned staged Skill', async () => {
  const f = await fixture()
  const paths = doubaoOfficeSetupPaths(f.context, userOptions(f.project))
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    await rm(paths.stagedSkillFile, { force: true })

    const report = await f.provider.doctor(f.context, userOptions(f.project))
    assert.equal(report.status, 'unhealthy')
    const repair = await f.provider.planRepair(f.context, report, userOptions(f.project))
    assert.equal(repair.actions.some(row => row.id === 'write-staged-skill'), true)
    const result = await f.provider.applyRepair(f.context, repair, userApply(f.project))
    assert.equal(result.status, 'manual-action-required')
    assert.equal(await readFile(paths.stagedSkillFile, 'utf8'), f.skillContent)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('豆包办公 uninstall removes only installer-owned Skills and retains Bridge state', async () => {
  const managedDir = path.join(os.tmpdir(), `flowit-doubao-uninstall-${Date.now()}-${Math.random()}`)
  const f = await fixture({ FLOWIT_WORKFLOW_DOUBAO_SKILL_DIR: managedDir })
  const paths = doubaoOfficeSetupPaths(f.context, userOptions(f.project))
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    await writeFile(path.join(paths.bridgeRoot, 'inbox', 'pending.json'), '{}\n', 'utf8')

    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    const result = await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(result.status, 'complete')
    assert.equal(await exists(paths.stagedSkillFile), false)
    assert.equal(await exists(path.join(managedDir, 'SKILL.md')), false)
    assert.equal(await exists(paths.setupManifestFile), false)
    assert.equal(await exists(path.join(paths.bridgeRoot, 'inbox', 'pending.json')), true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(managedDir, { recursive: true, force: true })
  }
})

test('豆包办公 uninstall preserves a user-modified installer-owned Skill and reports partial cleanup', async () => {
  const f = await fixture()
  const paths = doubaoOfficeSetupPaths(f.context, userOptions(f.project))
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    await writeFile(paths.stagedSkillFile, `${f.skillContent}\n# user edit\n`, 'utf8')

    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    assert.equal(uninstall.actions.some(row => row.id === 'remove-staged-skill'), false)
    const result = await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(result.status, 'partial')
    assert.match(await readFile(paths.stagedSkillFile, 'utf8'), /user edit/)
    assert.equal(await exists(paths.setupManifestFile), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('豆包办公 setup fails closed on a malformed ownership manifest', async () => {
  const f = await fixture()
  const paths = doubaoOfficeSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(path.dirname(paths.setupManifestFile), { recursive: true })
    await writeFile(paths.setupManifestFile, '{broken', 'utf8')
    await assert.rejects(
      f.provider.planSetup(f.context, userOptions(f.project)),
      /invalid 豆包办公 setup ownership manifest/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
