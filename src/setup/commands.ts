import path from 'node:path'
import { KNOWN_SETUP_HOSTS } from './catalog.js'
import { doctorSetupFramework } from './framework-doctor.js'
import type { HostSetupRegistry } from './registry.js'
import type {
  DoctorReport,
  HostDetection,
  HostSetupContext,
  HostSetupProvider,
  SetupApplyOptions,
  SetupOperation,
  SetupPlan,
  SetupRequestOptions,
  SetupResult,
  SetupScope,
} from './types.js'

export interface SetupCommandOptions {
  readonly target?: string
  readonly scope: SetupScope
  readonly projectDir: string
}

export interface SetupDiscoveryRow {
  readonly hostId: string
  readonly displayName: string
  readonly integrationMode: string
  readonly provider: 'registered' | 'not-registered'
  readonly detection?: HostDetection
}

export interface SetupDiscoveryResult {
  readonly kind: 'discovery'
  readonly hosts: readonly SetupDiscoveryRow[]
}

export interface SetupDoctorResult {
  readonly kind: 'doctor'
  readonly reports: readonly DoctorReport[]
}

export interface PreparedSetupMutation {
  readonly kind: 'mutation-plan'
  readonly operation: SetupOperation
  readonly options: SetupCommandOptions
  readonly plans: readonly SetupPlan[]
}

export interface AppliedSetupMutation {
  readonly kind: 'mutation-result'
  readonly operation: SetupOperation
  readonly results: readonly SetupResult[]
}

export async function discoverSetupHosts(
  context: HostSetupContext,
  registry: HostSetupRegistry,
): Promise<SetupDiscoveryResult> {
  const detections = new Map((await registry.detectAll(context)).map(row => [row.hostId, row]))
  const knownIds = new Set(KNOWN_SETUP_HOSTS.map(host => host.id))
  const hosts: SetupDiscoveryRow[] = KNOWN_SETUP_HOSTS.map(host => {
    const detection = detections.get(host.id)
    return {
      hostId: host.id,
      displayName: host.displayName,
      integrationMode: host.integrationMode,
      provider: registry.get(host.id) ? 'registered' : 'not-registered',
      ...(detection ? { detection } : {}),
    }
  })
  for (const provider of registry.list()) {
    if (knownIds.has(provider.id as (typeof KNOWN_SETUP_HOSTS)[number]['id'])) continue
    const detection = detections.get(provider.id)
    hosts.push({
      hostId: provider.id,
      displayName: provider.displayName,
      integrationMode: 'external',
      provider: 'registered',
      ...(detection ? { detection } : {}),
    })
  }
  return { kind: 'discovery', hosts }
}

export async function executeDoctorCommand(
  context: HostSetupContext,
  registry: HostSetupRegistry,
  options: SetupCommandOptions,
): Promise<SetupDoctorResult> {
  const request = requestOptions(options)
  if (options.target && options.target !== 'all') {
    const provider = requireProvider(registry, options.target)
    return { kind: 'doctor', reports: [await provider.doctor(context, request)] }
  }

  const reports: DoctorReport[] = [await doctorSetupFramework(context, registry)]
  for (const provider of registry.list()) {
    try {
      reports.push(await provider.doctor(context, request))
    } catch (error: unknown) {
      reports.push({
        hostId: provider.id,
        displayName: provider.displayName,
        status: 'unhealthy',
        checks: [
          {
            id: 'provider-doctor',
            status: 'error',
            summary: 'Host doctor failed',
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      })
    }
  }
  return { kind: 'doctor', reports }
}

export async function prepareSetupMutation(
  operation: SetupOperation,
  context: HostSetupContext,
  registry: HostSetupRegistry,
  options: SetupCommandOptions,
): Promise<PreparedSetupMutation> {
  const providers = selectProviders(registry, options.target)
  const request = requestOptions(options)
  const plans: SetupPlan[] = []
  for (const provider of providers) {
    const plan = await planProvider(operation, provider, context, request)
    validatePlan(operation, provider, plan, request.scope)
    plans.push(plan)
  }
  return { kind: 'mutation-plan', operation, options, plans }
}

export async function applySetupMutation(
  prepared: PreparedSetupMutation,
  context: HostSetupContext,
  registry: HostSetupRegistry,
  assumeYes: boolean,
): Promise<AppliedSetupMutation> {
  const applyOptions: SetupApplyOptions = {
    ...requestOptions(prepared.options),
    assumeYes,
  }
  const results: SetupResult[] = []
  for (const plan of prepared.plans) {
    const provider = requireProvider(registry, plan.hostId)
    const result = await applyProvider(prepared.operation, provider, context, plan, applyOptions)
    validateResult(prepared.operation, provider, result)
    results.push(result)
  }
  return { kind: 'mutation-result', operation: prepared.operation, results }
}

export function mutationNeedsConfirmation(prepared: PreparedSetupMutation): boolean {
  return prepared.plans.some(plan => plan.actions.some(action => action.requiresConfirmation))
}

function selectProviders(registry: HostSetupRegistry, target: string | undefined): HostSetupProvider[] {
  if (!target) throw new Error('a host id or "all" is required for this command')
  if (target === 'all') {
    const providers = registry.list()
    if (providers.length === 0) throw new Error('no host setup providers are registered in this build')
    return providers
  }
  return [requireProvider(registry, target)]
}

function requireProvider(registry: HostSetupRegistry, id: string): HostSetupProvider {
  const provider = registry.get(id)
  if (provider) return provider
  const known = KNOWN_SETUP_HOSTS.find(host => host.id === id)
  if (known) {
    throw new Error(
      `${known.displayName} setup is known but its HostSetupProvider is not implemented in this build yet`,
    )
  }
  throw new Error(`unknown setup host ${id}`)
}

function requestOptions(options: SetupCommandOptions): SetupRequestOptions {
  return {
    scope: options.scope,
    projectDir: path.resolve(options.projectDir),
  }
}

async function planProvider(
  operation: SetupOperation,
  provider: HostSetupProvider,
  context: HostSetupContext,
  options: SetupRequestOptions,
): Promise<SetupPlan> {
  switch (operation) {
    case 'setup':
      return provider.planSetup(context, options)
    case 'repair': {
      const report = await provider.doctor(context, options)
      return provider.planRepair(context, report, options)
    }
    case 'uninstall':
      return provider.planUninstall(context, options)
  }
}

async function applyProvider(
  operation: SetupOperation,
  provider: HostSetupProvider,
  context: HostSetupContext,
  plan: SetupPlan,
  options: SetupApplyOptions,
): Promise<SetupResult> {
  switch (operation) {
    case 'setup':
      return provider.applySetup(context, plan, options)
    case 'repair':
      return provider.applyRepair(context, plan, options)
    case 'uninstall':
      return provider.applyUninstall(context, plan, options)
  }
}

function validatePlan(
  operation: SetupOperation,
  provider: HostSetupProvider,
  plan: SetupPlan,
  scope: SetupScope,
): void {
  if (plan.version !== 1) throw new Error(`setup provider ${provider.id} returned unsupported plan version`)
  if (plan.operation !== operation)
    throw new Error(`setup provider ${provider.id} returned a ${plan.operation} plan for ${operation}`)
  if (plan.hostId !== provider.id)
    throw new Error(`setup provider ${provider.id} returned plan for host ${plan.hostId}`)
  if (plan.scope !== scope)
    throw new Error(`setup provider ${provider.id} returned plan for scope ${plan.scope}, expected ${scope}`)
  const actionIds = new Set<string>()
  for (const action of plan.actions) {
    if (!action.id.trim()) throw new Error(`setup provider ${provider.id} returned an action with empty id`)
    if (actionIds.has(action.id))
      throw new Error(`setup provider ${provider.id} returned duplicate action id ${action.id}`)
    actionIds.add(action.id)
  }
}

function validateResult(
  operation: SetupOperation,
  provider: HostSetupProvider,
  result: SetupResult,
): void {
  if (result.operation !== operation)
    throw new Error(`setup provider ${provider.id} returned ${result.operation} result for ${operation}`)
  if (result.hostId !== provider.id)
    throw new Error(`setup provider ${provider.id} returned result for host ${result.hostId}`)
}
