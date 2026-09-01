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
  createStudioFirstRunGuide,
  installStudioForCurrentAgent,
  readStudioExperienceReport,
  recordStudioExperience,
  type StudioPackageManifest,
} from '../src/studio/index.js'

const manifest: StudioPackageManifest = {
  schemaVersion: 1,
  id: 'coaseedge.research-lab',
  displayName: '深度研究',
  publisher: { id: 'coaseedge' },
  version: '1.0.0',
  runtime: {
    id: 'flowit-workflow',
    version: '>=0.5.0-beta.2 <1',
    bootstrap: 'official',
  },
  supportedHosts: ['codex'],
  entryPreset: 'research-lab',
  license: { type: 'open-source' },
  metadata: { legacyPresetId: 'research-lab' },
}

test('local Studio diagnostics reject unknown runtime keys instead of serializing caller objects', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-diagnostics-'))
  try {
    await assert.rejects(
      () =>
        recordStudioExperience(
          {
            version: 1,
            event: 'studio_install_success',
            at: '2026-08-31T16:00:00.000Z',
            studioId: 'acme.studio',
            studioVersion: '1.0.0',
            hostId: 'codex',
            durationMs: 420,
            prompt: 'secret content',
            session: 'secret-session',
          } as unknown,
          { homeDir },
        ),
      /unsupported fields: prompt, session/,
    )
    assert.equal((await readStudioExperienceReport({ homeDir })).events, 0)

    await recordStudioExperience(
      {
        version: 1,
        event: 'studio_install_success',
        at: '2026-08-31T16:00:00.000Z',
        studioId: 'acme.studio',
        studioVersion: '1.0.0',
        hostId: 'codex',
        durationMs: 420,
      },
      { homeDir },
    )
    const report = await readStudioExperienceReport({ homeDir })
    assert.equal(report.events, 1)
    assert.equal(report.counts.studio_install_success, 1)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('complete install reports installation readiness without claiming direct Studio execution', () => {
  const complete = createStudioFirstRunGuide(manifest, {
    status: 'complete',
    manualSteps: [],
    warnings: [],
  })
  assert.equal(complete.state, 'installation-complete')
  assert.equal(complete.installationReady, true)
  assert.equal(complete.directExecutionAvailable, false)
  if (complete.state === 'installation-complete') {
    assert.equal(complete.entryPresetId, 'research-lab')
    assert.match(complete.message, /安装与 Host 集成已完成/)
    assert.match(complete.message, /尚未提供通用.*直接运行入口/)
    assert.doesNotMatch(complete.message, /可以直接开始|已准备好/)
  }

  const pending = createStudioFirstRunGuide(manifest, {
    status: 'manual-action-required',
    manualSteps: ['Approve MCP in the Host UI'],
    warnings: [],
  })
  assert.equal(pending.installationReady, false)
  assert.equal(pending.directExecutionAvailable, false)
  assert.equal(pending.state, 'pending-manual-action')

  const repair = createStudioFirstRunGuide(manifest, {
    status: 'partial',
    manualSteps: [],
    warnings: ['Doctor unhealthy'],
  })
  assert.equal(repair.installationReady, false)
  assert.equal(repair.directExecutionAvailable, false)
  assert.equal(repair.state, 'repair-required')
})

class ManualSetupProvider implements HostSetupProvider {
  readonly id = 'fake-host'
  readonly displayName = 'Fake Host'
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
      summary: 'setup',
      actions: [],
      warnings: [],
      manualSteps: ['Approve native Host trust'],
    }
  }
  async applySetup(): Promise<SetupResult> {
    return {
      operation: 'setup',
      hostId: this.id,
      displayName: this.displayName,
      status: 'manual-action-required',
      appliedActions: [],
      skippedActions: [],
      warnings: [],
      manualSteps: ['Approve native Host trust'],
    }
  }
  async doctor(): Promise<DoctorReport> {
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: 'degraded',
      checks: [],
    }
  }
  async planRepair(
    context: HostSetupContext,
    _report: unknown,
    options: { scope: 'user' | 'project' },
  ) {
    return this.planSetup(context, options)
  }
  async applyRepair(): Promise<SetupResult> {
    return {
      operation: 'repair',
      hostId: this.id,
      displayName: this.displayName,
      status: 'manual-action-required',
      appliedActions: [],
      skippedActions: [],
      warnings: [],
      manualSteps: ['Approve native Host trust'],
    }
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
      summary: 'uninstall',
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

class PartialSetupProvider extends ManualSetupProvider {
  override async planSetup(
    _context: HostSetupContext,
    options: { scope: 'user' | 'project' },
  ): Promise<SetupPlan> {
    return {
      version: 1,
      operation: 'setup',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: 'partial setup',
      actions: [],
      warnings: [],
      manualSteps: [],
    }
  }
  override async applySetup(): Promise<SetupResult> {
    return {
      operation: 'setup',
      hostId: this.id,
      displayName: this.displayName,
      status: 'partial',
      appliedActions: [],
      skippedActions: [],
      warnings: [],
      manualSteps: [],
    }
  }
  override async doctor(): Promise<DoctorReport> {
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: 'healthy',
      checks: [],
    }
  }
}

async function createManualStudio(root: string): Promise<void> {
  await mkdir(path.join(root, 'presets'), { recursive: true })
  await mkdir(path.join(root, 'roles'), { recursive: true })
  await writeFile(
    path.join(root, 'flowit.package.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme.manual-studio',
      displayName: 'Manual Studio',
      publisher: { id: 'acme' },
      version: '1.0.0',
      runtime: {
        id: 'flowit-workflow',
        version: '>=0.5.0-beta.2 <1',
        bootstrap: 'official',
      },
      supportedHosts: ['fake-host'],
      entryPreset: 'manual-studio',
      license: { type: 'freeware' },
    }),
  )
  await writeFile(
    path.join(root, 'presets', 'manual-studio.json'),
    JSON.stringify({
      version: 1,
      id: 'manual-studio',
      displayName: 'Manual Studio',
      description: 'Manual trust test',
      input: { required: false, label: 'Goal' },
      roles: [{ id: 'worker', displayName: 'Worker', description: 'Work' }],
      nodes: [{ id: 'work', roleId: 'worker', promptFile: 'roles/worker.md' }],
      edges: [],
    }),
  )
  await writeFile(path.join(root, 'roles', 'worker.md'), 'Work carefully.\n')
}

test('manual-action-required is pending, not install success, in consumer diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-pending-'))
  const source = path.join(root, 'studio')
  try {
    await createManualStudio(source)
    const result = await installStudioForCurrentAgent(
      {
        sourceRoot: source,
        hostId: 'fake-host',
        projectDir: root,
        storeRoot: path.join(root, 'store'),
      },
      {
        cwd: root,
        homeDir: root,
        setupRegistry: new HostSetupRegistry([new ManualSetupProvider()]),
        diagnostics: { homeDir: root },
      },
    )
    assert.equal(result.transaction.status, 'manual-action-required')
    assert.equal(result.firstRun.installationReady, false)
    assert.equal(result.firstRun.directExecutionAvailable, false)
    const report = await readStudioExperienceReport({ homeDir: root })
    assert.equal(report.counts.studio_install_pending_manual, 1)
    assert.equal(report.counts.studio_install_success, 0)
    assert.equal(report.counts.host_setup_success, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('partial Host setup with healthy Doctor remains repair-required and is diagnosed as host setup failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-partial-host-'))
  const source = path.join(root, 'studio')
  try {
    await createManualStudio(source)
    const result = await installStudioForCurrentAgent(
      {
        sourceRoot: source,
        hostId: 'fake-host',
        projectDir: root,
        storeRoot: path.join(root, 'store'),
      },
      {
        cwd: root,
        homeDir: root,
        setupRegistry: new HostSetupRegistry([new PartialSetupProvider()]),
        diagnostics: { homeDir: root },
      },
    )

    assert.equal(result.transaction.hostSetup.results[0]?.status, 'partial')
    assert.equal(result.transaction.status, 'partial')
    assert.equal(result.firstRun.state, 'repair-required')
    assert.equal(result.firstRun.installationReady, false)
    assert.equal(result.firstRun.directExecutionAvailable, false)

    const report = await readStudioExperienceReport({ homeDir: root })
    assert.equal(report.counts.studio_install_failed, 1)
    assert.equal(report.counts.host_setup_success, 0)
    assert.equal(report.counts.studio_install_success, 0)

    const diagnosticsFile = path.join(
      root,
      '.flowit-workflow',
      'diagnostics',
      'experience.jsonl',
    )
    const events = (await readFile(diagnosticsFile, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { event: string; failureStage?: string })
    const failed = events.find(event => event.event === 'studio_install_failed')
    assert.equal(failed?.failureStage, 'host-setup')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
