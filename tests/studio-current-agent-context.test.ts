import assert from 'node:assert/strict'
import test from 'node:test'
import { HostSetupRegistry } from '../src/setup/registry.js'
import type { HostSetupContext, HostSetupProvider, SetupPlan, SetupResult } from '../src/setup/types.js'
import { resolveCurrentAgentContext, type StudioPackageManifest } from '../src/studio/index.js'

class DetectionProvider implements HostSetupProvider {
  constructor(readonly id: string, readonly detected: boolean) {}
  readonly displayName = 'Detection Host'
  async detect() {
    return { hostId: this.id, displayName: this.displayName, status: this.detected ? 'detected' as const : 'not-detected' as const }
  }
  async planSetup(_context: HostSetupContext, options: { scope: 'user' | 'project' }): Promise<SetupPlan> {
    return { version: 1, operation: 'setup', hostId: this.id, displayName: this.displayName, scope: options.scope, summary: 'setup', actions: [], warnings: [], manualSteps: [] }
  }
  async applySetup(): Promise<SetupResult> {
    return { operation: 'setup', hostId: this.id, displayName: this.displayName, status: 'complete', appliedActions: [], skippedActions: [], warnings: [], manualSteps: [] }
  }
  async doctor() { return { hostId: this.id, displayName: this.displayName, status: 'healthy' as const, checks: [] } }
  async planRepair(context: HostSetupContext, _report: unknown, options: { scope: 'user' | 'project' }) { return this.planSetup(context, options) }
  async applyRepair(): Promise<SetupResult> { return { operation: 'repair', hostId: this.id, displayName: this.displayName, status: 'complete', appliedActions: [], skippedActions: [], warnings: [], manualSteps: [] } }
  async planUninstall(_context: HostSetupContext, options: { scope: 'user' | 'project' }): Promise<SetupPlan> { return { version: 1, operation: 'uninstall', hostId: this.id, displayName: this.displayName, scope: options.scope, summary: 'uninstall', actions: [], warnings: [], manualSteps: [] } }
  async applyUninstall(): Promise<SetupResult> { return { operation: 'uninstall', hostId: this.id, displayName: this.displayName, status: 'complete', appliedActions: [], skippedActions: [], warnings: [], manualSteps: [] } }
}

const manifest: StudioPackageManifest = {
  schemaVersion: 1,
  id: 'acme.studio',
  displayName: 'Studio',
  publisher: { id: 'acme' },
  version: '1.0.0',
  runtime: { id: 'flowit-workflow', version: '>=1', bootstrap: 'official' },
  supportedHosts: ['host-a', 'host-b'],
  entryPreset: 'studio',
  license: { type: 'freeware' },
}

const setupContext: HostSetupContext = {
  cwd: '/workspace',
  homeDir: '/home/test',
  packageRoot: '/package',
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  env: {},
}

test('current Agent context auto-selects the one detected supported Host', async () => {
  const registry = new HostSetupRegistry([
    new DetectionProvider('host-a', false),
    new DetectionProvider('host-b', true),
  ])
  const context = await resolveCurrentAgentContext(
    manifest,
    { projectDir: '/workspace', sessionId: 'current-session' },
    setupContext,
    registry,
  )
  assert.equal(context.hostId, 'host-b')
  assert.equal(context.sessionId, 'current-session')
  assert.equal(context.source, 'detected')
})

test('current Agent context refuses to guess when multiple supported Hosts are active', async () => {
  const registry = new HostSetupRegistry([
    new DetectionProvider('host-a', true),
    new DetectionProvider('host-b', true),
  ])
  await assert.rejects(
    () => resolveCurrentAgentContext(manifest, { projectDir: '/workspace' }, setupContext, registry),
    /multiple supported Agent hosts/,
  )
})
