import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { HostSetupRegistry } from '../src/setup/registry.js'
import type {
  DoctorReport,
  HostSetupContext,
  HostSetupProvider,
  SetupPlan,
  SetupResult,
} from '../src/setup/types.js'
import {
  StudioPackageStore,
  applyStudioInstallTransaction,
  createStudioInstallIntent,
  prepareStudioInstallTransaction,
} from '../src/studio/index.js'

class FakeSetupProvider implements HostSetupProvider {
  readonly id = 'fake-host'
  readonly displayName = 'Fake Host'
  assumeYes: boolean | undefined
  doctorStatus: DoctorReport['status'] = 'healthy'
  setupStatus: SetupResult['status'] = 'complete'

  async detect() {
    return { hostId: this.id, displayName: this.displayName, status: 'detected' as const }
  }
  async planSetup(
    _context: HostSetupContext,
    options: { scope: 'user' | 'project' },
  ): Promise<SetupPlan> {
    return {
      version: 1,
      operation: 'setup',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: 'Configure Flowit integration',
      actions: [
        {
          id: 'configure',
          kind: 'config',
          description: 'Configure managed Flowit integration',
          risk: 'configuration',
          requiresConfirmation: true,
          reversible: true,
        },
      ],
      warnings: [],
      manualSteps: [],
    }
  }
  async applySetup(
    _context: HostSetupContext,
    plan: SetupPlan,
    options: { assumeYes: boolean },
  ): Promise<SetupResult> {
    this.assumeYes = options.assumeYes
    return {
      operation: 'setup',
      hostId: this.id,
      displayName: this.displayName,
      status: this.setupStatus,
      appliedActions: plan.actions.map(action => action.id),
      skippedActions: [],
      warnings: [],
      manualSteps: [],
      doctor: await this.doctor(),
    }
  }
  async doctor(): Promise<DoctorReport> {
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: this.doctorStatus,
      checks: [
        {
          id: 'configured',
          status: this.doctorStatus === 'healthy' ? 'ok' : 'error',
          summary: 'Configured',
        },
      ],
    }
  }
  async planRepair(
    context: HostSetupContext,
    _report: DoctorReport,
    options: { scope: 'user' | 'project' },
  ) {
    return this.planSetup(context, options)
  }
  async applyRepair(
    context: HostSetupContext,
    plan: SetupPlan,
    options: { assumeYes: boolean },
  ) {
    return this.applySetup(context, { ...plan, operation: 'repair' }, options)
  }
  async planUninstall(
    _context: HostSetupContext,
    options: { scope: 'user' | 'project' },
  ): Promise<SetupPlan> {
    return {
      version: 1,
      operation: 'uninstall',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: 'Uninstall',
      actions: [],
      warnings: [],
      manualSteps: [],
    }
  }
  async applyUninstall(): Promise<SetupResult> {
    return {
      operation: 'uninstall',
      hostId: this.id,
      displayName: this.displayName,
      status: 'complete',
      appliedActions: [],
      skippedActions: [],
      warnings: [],
      manualSteps: [],
    }
  }
}

async function createStudio(root: string, elevated = false): Promise<void> {
  await mkdir(path.join(root, 'presets'), { recursive: true })
  await mkdir(path.join(root, 'roles'), { recursive: true })
  await writeFile(
    path.join(root, 'flowit.package.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme.safe-studio',
      displayName: 'Safe Studio',
      publisher: { id: 'acme' },
      version: '1.0.0',
      runtime: {
        id: 'flowit-workflow',
        version: '>=0.5.0-beta.2 <2',
        bootstrap: 'official',
      },
      supportedHosts: ['fake-host'],
      entryPreset: 'safe-studio',
      license: { type: 'freeware' },
      ...(elevated
        ? {
            permissions: [
              {
                id: 'external-publish',
                description: 'Publish externally',
                risk: 'elevated',
                reason: 'This Studio can publish final output',
              },
            ],
          }
        : {}),
    }),
  )
  await writeFile(
    path.join(root, 'presets', 'safe-studio.json'),
    JSON.stringify({
      version: 1,
      id: 'safe-studio',
      displayName: 'Safe Studio',
      description: 'A safe Studio',
      input: { required: false, label: 'Goal' },
      roles: [{ id: 'worker', displayName: 'Worker', description: 'Work' }],
      nodes: [{ id: 'work', roleId: 'worker', promptFile: 'roles/worker.md' }],
      edges: [],
    }),
  )
  await writeFile(path.join(root, 'roles', 'worker.md'), 'Do the work.\n')
}

function context(root: string): HostSetupContext {
  return {
    cwd: root,
    homeDir: root,
    packageRoot: root,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    env: {},
  }
}

function store(root: string): StudioPackageStore {
  return new StudioPackageStore({ rootDir: path.join(root, 'store') })
}

test('one Studio install intent covers standard host setup confirmation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-install-'))
  try {
    const source = path.join(root, 'source')
    await createStudio(source)
    const provider = new FakeSetupProvider()
    const registry = new HostSetupRegistry([provider])
    const packageStore = store(root)
    const intent = createStudioInstallIntent({ studioId: 'acme.safe-studio', source })
    const prepared = await prepareStudioInstallTransaction(
      { sourceRoot: source, hostId: 'fake-host', scope: 'user', projectDir: root, intent },
      context(root),
      registry,
      packageStore,
    )
    assert.equal(prepared.canApplyWithoutAdditionalConfirmation, true)
    const result = await applyStudioInstallTransaction(
      prepared,
      context(root),
      registry,
      packageStore,
    )
    assert.equal(result.status, 'complete')
    assert.equal(provider.assumeYes, true)
    assert.equal(result.installed.digest, prepared.snapshot.digest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepare and apply are bound to one Flowit-owned package snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-snapshot-'))
  try {
    const source = path.join(root, 'source')
    await createStudio(source)
    const provider = new FakeSetupProvider()
    const registry = new HostSetupRegistry([provider])
    const packageStore = store(root)
    const intent = createStudioInstallIntent({ studioId: 'acme.safe-studio', source })
    const prepared = await prepareStudioInstallTransaction(
      { sourceRoot: source, hostId: 'fake-host', scope: 'user', projectDir: root, intent },
      context(root),
      registry,
      packageStore,
    )

    await writeFile(path.join(source, 'roles', 'worker.md'), 'MUTATED AFTER PREPARE.\n')

    const result = await applyStudioInstallTransaction(
      prepared,
      context(root),
      registry,
      packageStore,
    )
    assert.equal(
      await readFile(path.join(result.installed.installDir, 'roles', 'worker.md'), 'utf8'),
      'Do the work.\n',
    )
    assert.equal(result.installed.digest, prepared.snapshot.digest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('elevated Studio permissions stay outside the standard install intent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-elevated-'))
  try {
    const source = path.join(root, 'source')
    await createStudio(source, true)
    const registry = new HostSetupRegistry([new FakeSetupProvider()])
    const packageStore = store(root)
    const intent = createStudioInstallIntent({ studioId: 'acme.safe-studio', source })
    const prepared = await prepareStudioInstallTransaction(
      { sourceRoot: source, hostId: 'fake-host', scope: 'user', projectDir: root, intent },
      context(root),
      registry,
      packageStore,
    )
    assert.equal(prepared.canApplyWithoutAdditionalConfirmation, false)
    assert.equal(prepared.elevatedPermissions.length, 1)
    await assert.rejects(
      () =>
        applyStudioInstallTransaction(
          prepared,
          context(root),
          registry,
          packageStore,
        ),
      /requires elevated permissions/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a partial Host setup never reports a complete Studio install even with healthy Doctor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-host-partial-'))
  try {
    const source = path.join(root, 'source')
    await createStudio(source)
    const provider = new FakeSetupProvider()
    provider.setupStatus = 'partial'
    provider.doctorStatus = 'healthy'
    const registry = new HostSetupRegistry([provider])
    const packageStore = store(root)
    const intent = createStudioInstallIntent({ studioId: 'acme.safe-studio', source })
    const prepared = await prepareStudioInstallTransaction(
      { sourceRoot: source, hostId: 'fake-host', scope: 'user', projectDir: root, intent },
      context(root),
      registry,
      packageStore,
    )
    const result = await applyStudioInstallTransaction(
      prepared,
      context(root),
      registry,
      packageStore,
    )
    assert.equal(result.hostSetup.results[0]?.status, 'partial')
    assert.equal(result.status, 'partial')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unhealthy post-apply Doctor never reports a complete install', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-doctor-'))
  try {
    const source = path.join(root, 'source')
    await createStudio(source)
    const provider = new FakeSetupProvider()
    provider.doctorStatus = 'unhealthy'
    const registry = new HostSetupRegistry([provider])
    const packageStore = store(root)
    const intent = createStudioInstallIntent({ studioId: 'acme.safe-studio', source })
    const prepared = await prepareStudioInstallTransaction(
      { sourceRoot: source, hostId: 'fake-host', scope: 'user', projectDir: root, intent },
      context(root),
      registry,
      packageStore,
    )
    const result = await applyStudioInstallTransaction(
      prepared,
      context(root),
      registry,
      packageStore,
    )
    assert.equal(result.status, 'partial')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
