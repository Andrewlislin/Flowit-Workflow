import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import {
  HostSetupRegistry,
  applySetupMutation,
  discoverSetupHosts,
  executeDoctorCommand,
  parseSetupCliArgs,
  prepareSetupMutation,
  runSetupCli,
  supportedNodeVersion,
  type DoctorReport,
  type HostSetupContext,
  type HostSetupProvider,
  type SetupApplyOptions,
  type SetupPlan,
  type SetupRequestOptions,
  type SetupResult,
} from '../src/setup/index.js'

class FakeProvider implements HostSetupProvider {
  readonly id = 'fake'
  readonly displayName = 'Fake Host'
  applies: string[] = []
  doctorCalls = 0

  async detect() {
    return { hostId: this.id, displayName: this.displayName, status: 'detected' as const }
  }
  async planSetup(_context: HostSetupContext, options: SetupRequestOptions) {
    return this.plan('setup', options)
  }
  async applySetup(_context: HostSetupContext, plan: SetupPlan, _options: SetupApplyOptions) {
    return this.apply(plan)
  }
  async doctor(): Promise<DoctorReport> {
    this.doctorCalls += 1
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: 'degraded',
      checks: [{ id: 'config', status: 'warning', summary: 'config missing', repairable: true }],
    }
  }
  async planRepair(_context: HostSetupContext, _report: DoctorReport, options: SetupRequestOptions) {
    return this.plan('repair', options)
  }
  async applyRepair(_context: HostSetupContext, plan: SetupPlan, _options: SetupApplyOptions) {
    return this.apply(plan)
  }
  async planUninstall(_context: HostSetupContext, options: SetupRequestOptions) {
    return this.plan('uninstall', options)
  }
  async applyUninstall(_context: HostSetupContext, plan: SetupPlan, _options: SetupApplyOptions) {
    return this.apply(plan)
  }

  private plan(operation: SetupPlan['operation'], options: SetupRequestOptions): SetupPlan {
    return {
      version: 1,
      operation,
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: `${operation} fake host`,
      actions: [
        {
          id: `${operation}-config`,
          kind: 'merge-config',
          description: `${operation} config`,
          risk: operation === 'uninstall' ? 'destructive' : 'configuration',
          requiresConfirmation: true,
          reversible: true,
        },
      ],
      warnings: [],
      manualSteps: [],
    }
  }

  private apply(plan: SetupPlan): SetupResult {
    this.applies.push(plan.operation)
    return {
      operation: plan.operation,
      hostId: this.id,
      displayName: this.displayName,
      status: 'complete',
      appliedActions: plan.actions.map(action => action.id),
      skippedActions: [],
      warnings: [],
      manualSteps: [],
    }
  }
}

const context: HostSetupContext = {
  cwd: '/project',
  homeDir: '/home/test',
  packageRoot: '/package',
  platform: process.platform,
  arch: process.arch,
  nodeVersion: '22.20.0',
  env: {},
}
const options = { target: 'fake', scope: 'project' as const, projectDir: '/project' }

test('setup registry rejects duplicate provider ids', () => {
  const registry = new HostSetupRegistry()
  registry.register(new FakeProvider())
  assert.throws(() => registry.register(new FakeProvider()), /already registered/)
})

test('setup discovery includes known hosts and registered external providers', async () => {
  const registry = new HostSetupRegistry([new FakeProvider()])
  const result = await discoverSetupHosts(context, registry)
  assert.equal(result.hosts.some(host => host.hostId === 'workbuddy'), true)
  assert.equal(result.hosts.find(host => host.hostId === 'workbuddy')?.provider, 'not-registered')
  assert.equal(result.hosts.find(host => host.hostId === 'fake')?.provider, 'registered')
  assert.equal(result.hosts.find(host => host.hostId === 'fake')?.detection?.status, 'detected')
})

test('setup mutation separates plan from apply', async () => {
  const provider = new FakeProvider()
  const registry = new HostSetupRegistry([provider])
  const prepared = await prepareSetupMutation('setup', context, registry, options)
  assert.deepEqual(provider.applies, [])
  assert.equal(prepared.plans[0]?.actions[0]?.requiresConfirmation, true)
  const applied = await applySetupMutation(prepared, context, registry, true)
  assert.deepEqual(provider.applies, ['setup'])
  assert.equal(applied.results[0]?.status, 'complete')
})

test('repair plans from the current doctor report before applying', async () => {
  const provider = new FakeProvider()
  const registry = new HostSetupRegistry([provider])
  const prepared = await prepareSetupMutation('repair', context, registry, options)
  assert.equal(provider.doctorCalls, 1)
  await applySetupMutation(prepared, context, registry, true)
  assert.deepEqual(provider.applies, ['repair'])
})

test('doctor isolates framework and provider reports', async () => {
  const provider = new FakeProvider()
  const registry = new HostSetupRegistry([provider])
  const result = await executeDoctorCommand(context, registry, options)
  assert.equal(result.reports.length, 1)
  assert.equal(result.reports[0]?.hostId, 'fake')
})

test('known host without a provider fails explicitly rather than pretending setup succeeded', async () => {
  await assert.rejects(
    prepareSetupMutation('setup', context, new HostSetupRegistry(), {
      target: 'workbuddy',
      scope: 'user',
      projectDir: '/project',
    }),
    /not implemented in this build/,
  )
})

test('CLI parser supports agent-friendly setup controls', () => {
  assert.deepEqual(
    parseSetupCliArgs(['workbuddy', '--scope=project', '--project-dir', '/repo', '--dry-run', '--yes', '--json']),
    {
      target: 'workbuddy',
      scope: 'project',
      projectDir: '/repo',
      dryRun: true,
      assumeYes: true,
      json: true,
      help: false,
    },
  )
})

test('non-interactive confirmation-gated setup requires --yes', async () => {
  const provider = new FakeProvider()
  const registry = new HostSetupRegistry([provider])
  let output = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk)
      callback()
    },
  })
  await assert.rejects(
    runSetupCli('setup', ['fake'], {
      registry,
      context,
      stdin: Readable.from([]),
      stdout,
    }),
    /rerun with --yes/,
  )
  assert.equal(output, '')
  assert.deepEqual(provider.applies, [])
})

test('supported Node version follows package engine policy', () => {
  assert.equal(supportedNodeVersion('22.18.0'), false)
  assert.equal(supportedNodeVersion('22.19.0'), true)
  assert.equal(supportedNodeVersion('23.0.0'), false)
  assert.equal(supportedNodeVersion('24.0.0'), true)
})
