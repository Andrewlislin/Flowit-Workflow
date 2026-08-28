import os from 'node:os'
import path from 'node:path'
import { FlowitOrchestrationCore } from '../core/runtime.js'
import type { CreatePipelineInput, PipelineDefinition } from '../core/types.js'
import { defaultStoragePath, isBuiltInAdapterId, resolveConfiguredRuntime } from '../runtime-factory.js'
import { knownSetupHost } from '../setup/catalog.js'
import type { PresetRegistry } from './registry.js'
import type {
  AppliedPresetInstall,
  PreparedPresetInstall,
  PresetRoleBinding,
} from './types.js'

export interface PresetInstallOptions {
  readonly presetId: string
  readonly pipelineName?: string
  readonly adapterId?: string
  readonly roleAdapters?: Readonly<Record<string, string>>
  readonly sessions?: Readonly<Record<string, string>>
  readonly allSession?: string
  readonly skills?: Readonly<Record<string, readonly string[]>>
  readonly allSkills?: readonly string[]
  readonly input?: string
  readonly workspace?: string
  readonly projectDir: string
  readonly instanceId?: string
  readonly storageFile?: string
}

export interface PresetInstallRuntime {
  readonly cwd?: string
  readonly homeDir?: string
  readonly env?: Readonly<NodeJS.ProcessEnv>
}

export async function preparePresetInstall(
  options: PresetInstallOptions,
  registry: PresetRegistry,
  runtime: PresetInstallRuntime = {},
): Promise<PreparedPresetInstall> {
  const preset = registry.require(options.presetId)
  const projectDir = path.resolve(runtime.cwd ?? process.cwd(), options.projectDir)
  const pipelineName = options.pipelineName?.trim() || `Flowit Preset: ${preset.displayName}`
  const workspace = path.resolve(projectDir, options.workspace ?? path.join('.flowit-workflow', 'preset-workspaces', preset.id))
  const bindings = resolveBindings(preset.roles.map(role => role.id), options, runtime.env ?? process.env)
  const missingRoles = preset.roles.map(role => role.id).filter(roleId => !bindings[roleId])
  const boundAdapters = [...new Set(Object.values(bindings).map(binding => binding.adapterId))]
  const warnings: string[] = []

  if (boundAdapters.includes('dsh') && boundAdapters.some(adapter => adapter !== 'dsh')) {
    warnings.push('DeepSeek Harness uses an embedded Core/store and cannot share a runnable root-daemon preset with non-DSH adapters. Use DSH-only role bindings or separate presets.')
  }
  if (preset.inputRequired && !options.input?.trim()) {
    warnings.push(`${preset.displayName} requires ${preset.inputLabel}; pass --input before installing.`)
  }

  const defaultAdapterId = options.adapterId?.trim() || boundAdapters[0]
  const storage = resolvePresetStorage(
    { ...options, projectDir },
    defaultAdapterId,
    boundAdapters,
    runtime,
  )

  if (missingRoles.length > 0 || (preset.inputRequired && !options.input?.trim()) || warnings.some(row => /cannot share a runnable/.test(row))) {
    return {
      kind: 'preset-install-plan',
      preset: descriptor(preset),
      pipelineName,
      storageFile: storage.storageFile,
      instanceId: storage.instanceId,
      workspace,
      ...(defaultAdapterId ? { defaultAdapterId } : {}),
      bindings: Object.values(bindings),
      missingRoles,
      action: 'incomplete',
      warnings,
    }
  }

  if (!defaultAdapterId) throw new Error('preset install requires --adapter or per-role adapter bindings')
  const pipeline = preset.render({
    pipelineName,
    workspace,
    ...(options.input?.trim() ? { input: options.input.trim() } : {}),
    bindings,
  })
  const existing = await inspectExistingPipeline(storage, defaultAdapterId, pipeline)
  return {
    kind: 'preset-install-plan',
    preset: descriptor(preset),
    pipelineName,
    storageFile: storage.storageFile,
    instanceId: storage.instanceId,
    workspace,
    defaultAdapterId,
    bindings: Object.values(bindings),
    missingRoles: [],
    action: existing ? 'reuse' : 'create',
    ...(existing ? { existingPipelineId: existing.id } : {}),
    pipeline,
    warnings,
  }
}

export async function applyPresetInstall(plan: PreparedPresetInstall): Promise<AppliedPresetInstall> {
  if (plan.action === 'incomplete' || !plan.pipeline || !plan.defaultAdapterId) {
    throw new Error(`preset ${plan.preset.id} install plan is incomplete; review missing roles/input before applying`)
  }
  const storage = { storageFile: plan.storageFile, legacyStorageFiles: [] as string[], instanceId: plan.instanceId }
  const core = new FlowitOrchestrationCore({
    storageFile: storage.storageFile,
    legacyStorageFiles: storage.legacyStorageFiles,
    defaultAdapterId: plan.defaultAdapterId,
    activeWorkers: false,
  })
  try {
    await core.ready
    const sameName = (await core.pipelines.list()).filter(pipeline => pipeline.name === plan.pipelineName)
    const exact = sameName.filter(pipeline => pipelineEquivalent(pipeline, plan.pipeline!))
    if (sameName.length > 0 && exact.length !== 1) {
      throw new Error(
        `pipeline name ${JSON.stringify(plan.pipelineName)} is already used by a different or ambiguous definition; choose --name to avoid replacing user work`,
      )
    }
    if (exact.length === 1) {
      return result(plan, 'reused', exact[0]!.id)
    }
    const created = await core.pipelines.create(plan.pipeline)
    return result(plan, 'created', created.id)
  } finally {
    await core.dispose()
  }
}

function resolveBindings(
  roleIds: readonly string[],
  options: PresetInstallOptions,
  env: Readonly<NodeJS.ProcessEnv>,
): Record<string, PresetRoleBinding> {
  const result: Record<string, PresetRoleBinding> = {}
  const globalAdapter = options.adapterId?.trim() || env.FLOWIT_WORKFLOW_ADAPTER?.trim()
  for (const roleId of roleIds) {
    const sessionId = options.sessions?.[roleId]?.trim() || options.allSession?.trim()
    const adapterId = options.roleAdapters?.[roleId]?.trim() || globalAdapter
    if (!sessionId || !adapterId) continue
    if (!knownSetupHost(adapterId)) throw new Error(`unknown preset adapter ${adapterId} for role ${roleId}`)
    const roleSkills = options.skills?.[roleId] ?? options.allSkills ?? []
    result[roleId] = {
      roleId,
      adapterId,
      sessionId,
      skills: [...new Set(roleSkills.map(value => value.trim()).filter(Boolean))],
    }
  }
  for (const roleId of Object.keys(options.sessions ?? {})) {
    if (roleId !== 'all' && !roleIds.includes(roleId)) throw new Error(`unknown preset role in --session: ${roleId}`)
  }
  for (const roleId of Object.keys(options.roleAdapters ?? {})) {
    if (!roleIds.includes(roleId)) throw new Error(`unknown preset role in --role-adapter: ${roleId}`)
  }
  for (const roleId of Object.keys(options.skills ?? {})) {
    if (!roleIds.includes(roleId)) throw new Error(`unknown preset role in --skill: ${roleId}`)
  }
  return result
}

function resolvePresetStorage(
  options: PresetInstallOptions,
  defaultAdapterId: string | undefined,
  adapters: readonly string[],
  runtime: PresetInstallRuntime,
): { storageFile: string; legacyStorageFiles: string[]; instanceId: string } {
  const instanceId = normalizeInstanceId(options.instanceId ?? runtime.env?.FLOWIT_WORKFLOW_INSTANCE_ID ?? 'default')
  if (options.storageFile?.trim()) {
    return { storageFile: path.resolve(runtime.cwd ?? process.cwd(), options.storageFile), legacyStorageFiles: [], instanceId }
  }
  if (adapters.length > 0 && adapters.every(adapter => adapter === 'dsh')) {
    return {
      storageFile: path.join(runtime.homeDir ?? os.homedir(), '.flowit-workflow', 'dsh', 'workflow.json'),
      legacyStorageFiles: [],
      instanceId: 'dsh',
    }
  }
  if (defaultAdapterId && isBuiltInAdapterId(defaultAdapterId)) {
    const resolved = resolveConfiguredRuntime({
      defaultAdapterId,
      activeWorkers: false,
      instanceId,
    })
    return {
      storageFile: resolved.storageFile,
      legacyStorageFiles: resolved.legacyStorageFiles,
      instanceId: resolved.instanceId,
    }
  }
  return {
    storageFile: defaultStoragePath(instanceId),
    legacyStorageFiles: [],
    instanceId,
  }
}

async function inspectExistingPipeline(
  storage: { storageFile: string; legacyStorageFiles: string[]; instanceId: string },
  defaultAdapterId: string,
  desired: CreatePipelineInput,
): Promise<PipelineDefinition | undefined> {
  const core = new FlowitOrchestrationCore({
    storageFile: storage.storageFile,
    legacyStorageFiles: storage.legacyStorageFiles,
    defaultAdapterId,
    activeWorkers: false,
  })
  try {
    await core.ready
    const sameName = (await core.pipelines.list()).filter(pipeline => pipeline.name === desired.name)
    const exact = sameName.filter(pipeline => pipelineEquivalent(pipeline, desired))
    if (sameName.length === 0) return undefined
    if (sameName.length === 1 && exact.length === 1) return exact[0]
    throw new Error(
      `pipeline name ${JSON.stringify(desired.name)} is already used by a different or ambiguous definition; choose --name to preserve the existing pipeline`,
    )
  } finally {
    await core.dispose()
  }
}

function pipelineEquivalent(existing: PipelineDefinition, desired: CreatePipelineInput): boolean {
  return canonicalJson({
    name: existing.name,
    trigger: existing.trigger,
    nodes: existing.nodes,
    edges: existing.edges,
  }) === canonicalJson(desired)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const rows = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${rows.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function descriptor(preset: { version: 1; id: string; displayName: string; description: string; roles: readonly { id: string; displayName: string; description: string }[]; inputRequired: boolean; inputLabel: string }) {
  return {
    version: preset.version,
    id: preset.id,
    displayName: preset.displayName,
    description: preset.description,
    roles: preset.roles,
    inputRequired: preset.inputRequired,
    inputLabel: preset.inputLabel,
  }
}

function result(
  plan: PreparedPresetInstall,
  action: 'created' | 'reused',
  pipelineId: string,
): AppliedPresetInstall {
  return {
    kind: 'preset-install-result',
    presetId: plan.preset.id,
    action,
    pipelineId,
    pipelineName: plan.pipelineName,
    storageFile: plan.storageFile,
    instanceId: plan.instanceId,
    workspace: plan.workspace,
    warnings: plan.warnings,
  }
}

function normalizeInstanceId(value: string): string {
  const normalized = value.trim()
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error('preset instance id may contain only letters, numbers, dot, underscore, and hyphen')
  }
  return normalized
}
