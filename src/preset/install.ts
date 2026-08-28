import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FlowitOrchestrationCore } from '../core/runtime.js'
import type { CreatePipelineInput, PipelineDefinition, ScheduledTask, ScheduleTiming } from '../core/types.js'
import { defaultStoragePath, isBuiltInAdapterId, resolveConfiguredRuntime } from '../runtime-factory.js'
import { knownSetupHost } from '../setup/catalog.js'
import type { PresetRegistry } from './registry.js'
import type {
  AppliedPresetInstall,
  PreparedPresetInstall,
  PreparedPresetSchedule,
  PresetRoleBinding,
  PresetScheduleMode,
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
  readonly scheduleMode?: PresetScheduleMode
  readonly scheduleName?: string
  readonly scheduleTime?: string
  readonly timeZone?: string
  readonly everySeconds?: number
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
  const requestedSchedule = resolveRequestedSchedule(options)

  const common = {
    kind: 'preset-install-plan' as const,
    preset: descriptor(preset),
    pipelineName,
    storageFile: storage.storageFile,
    legacyStorageFiles: storage.legacyStorageFiles,
    instanceId: storage.instanceId,
    workspace,
    ...(defaultAdapterId ? { defaultAdapterId } : {}),
    bindings: Object.values(bindings),
    missingRoles,
    warnings,
  }

  if (missingRoles.length > 0 || (preset.inputRequired && !options.input?.trim()) || warnings.some(row => /cannot share a runnable/.test(row))) {
    return { ...common, action: 'incomplete', schedule: { ...requestedSchedule, action: 'none' } }
  }

  if (!defaultAdapterId) throw new Error('preset install requires --adapter or per-role adapter bindings')
  const pipeline = preset.render({
    pipelineName,
    workspace,
    ...(options.input?.trim() ? { input: options.input.trim() } : {}),
    bindings,
  })
  const existing = await inspectExistingPipeline(storage, defaultAdapterId, pipeline)
  const schedule = await prepareSchedulePlan(
    storage,
    defaultAdapterId,
    requestedSchedule,
    existing?.id,
  )
  return {
    ...common,
    defaultAdapterId,
    missingRoles: [],
    action: existing ? 'reuse' : 'create',
    ...(existing ? { existingPipelineId: existing.id } : {}),
    pipeline,
    schedule,
  }
}

export async function applyPresetInstall(plan: PreparedPresetInstall): Promise<AppliedPresetInstall> {
  if (plan.action === 'incomplete' || !plan.pipeline || !plan.defaultAdapterId) {
    throw new Error(`preset ${plan.preset.id} install plan is incomplete; review missing roles/input before applying`)
  }
  await mkdir(plan.workspace, { recursive: true })
  const core = new FlowitOrchestrationCore({
    storageFile: plan.storageFile,
    legacyStorageFiles: [...plan.legacyStorageFiles],
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
    const pipeline = exact.length === 1 ? exact[0]! : await core.pipelines.create(plan.pipeline)
    const pipelineAction = exact.length === 1 ? 'reused' as const : 'created' as const

    if (plan.schedule.mode === 'manual' || plan.schedule.action === 'none' || !plan.schedule.timing) {
      return result(plan, pipelineAction, pipeline.id, 'none')
    }

    const sameScheduleName = (await core.scheduler.list()).filter(task => task.name === plan.schedule.scheduleName)
    const exactSchedules = sameScheduleName.filter(task => scheduleEquivalent(task, pipeline.id, plan.schedule.timing!))
    if (sameScheduleName.length > 0 && exactSchedules.length !== 1) {
      throw new Error(
        `schedule name ${JSON.stringify(plan.schedule.scheduleName)} is already used by a different or ambiguous definition; choose --schedule-name to preserve existing automation`,
      )
    }
    if (exactSchedules.length === 1) {
      const schedule = exactSchedules[0]!
      return result(plan, pipelineAction, pipeline.id, 'reused', schedule)
    }
    const schedule = await core.scheduler.create({
      name: plan.schedule.scheduleName,
      pipelineId: pipeline.id,
      timing: plan.schedule.timing,
    })
    return result(plan, pipelineAction, pipeline.id, 'created', schedule)
  } finally {
    await core.dispose()
  }
}

function resolveRequestedSchedule(options: PresetInstallOptions): Omit<PreparedPresetSchedule, 'action' | 'existingScheduleId'> {
  const mode = options.scheduleMode ?? 'manual'
  const scheduleName = options.scheduleName?.trim() || `${options.pipelineName?.trim() || 'Flowit preset'} schedule`
  if (mode === 'manual') return { mode, scheduleName }
  if (mode === 'every') {
    if (!Number.isSafeInteger(options.everySeconds) || (options.everySeconds ?? 0) < 60) {
      throw new Error('--schedule=every requires --every-seconds=<integer >= 60>')
    }
    return { mode, scheduleName, timing: { kind: 'every', everySeconds: options.everySeconds! } }
  }
  const { hour, minute } = parseClockTime(options.scheduleTime)
  const timeZone = options.timeZone?.trim() || systemTimeZone()
  return {
    mode,
    scheduleName,
    timing: {
      kind: 'calendar',
      timeZone,
      hour,
      minute,
      ...(mode === 'weekdays' ? { daysOfWeek: [1, 2, 3, 4, 5] } : {}),
    },
  }
}

async function prepareSchedulePlan(
  storage: { storageFile: string; legacyStorageFiles: string[]; instanceId: string },
  defaultAdapterId: string,
  requested: Omit<PreparedPresetSchedule, 'action' | 'existingScheduleId'>,
  existingPipelineId?: string,
): Promise<PreparedPresetSchedule> {
  if (requested.mode === 'manual' || !requested.timing) return { ...requested, action: 'none' }
  if (!existingPipelineId) return { ...requested, action: 'create' }
  const core = new FlowitOrchestrationCore({
    storageFile: storage.storageFile,
    legacyStorageFiles: storage.legacyStorageFiles,
    defaultAdapterId,
    activeWorkers: false,
  })
  try {
    await core.ready
    const sameName = (await core.scheduler.list()).filter(task => task.name === requested.scheduleName)
    const exact = sameName.filter(task => scheduleEquivalent(task, existingPipelineId, requested.timing!))
    if (sameName.length === 0) return { ...requested, action: 'create' }
    if (sameName.length === 1 && exact.length === 1) {
      return { ...requested, action: 'reuse', existingScheduleId: exact[0]!.id }
    }
    throw new Error(
      `schedule name ${JSON.stringify(requested.scheduleName)} is already used by a different or ambiguous definition; choose --schedule-name to preserve existing automation`,
    )
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
    if (!roleIds.includes(roleId)) throw new Error(`unknown preset role in --session: ${roleId}`)
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
    return {
      storageFile: path.resolve(runtime.cwd ?? process.cwd(), options.storageFile),
      legacyStorageFiles: [],
      instanceId,
    }
  }
  if (adapters.length > 0 && adapters.every(adapter => adapter === 'dsh')) {
    return {
      storageFile: path.join(runtime.homeDir ?? os.homedir(), '.flowit-workflow', 'dsh', 'workflow.json'),
      legacyStorageFiles: [],
      instanceId: 'dsh',
    }
  }
  if (defaultAdapterId && isBuiltInAdapterId(defaultAdapterId)) {
    const resolved = resolveConfiguredRuntime({ defaultAdapterId, activeWorkers: false, instanceId })
    return {
      storageFile: resolved.storageFile,
      legacyStorageFiles: resolved.legacyStorageFiles,
      instanceId: resolved.instanceId,
    }
  }
  return { storageFile: defaultStoragePath(instanceId), legacyStorageFiles: [], instanceId }
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

function scheduleEquivalent(existing: ScheduledTask, pipelineId: string, timing: ScheduleTiming): boolean {
  return typeof existing.pipelineId === 'string'
    && existing.pipelineId === pipelineId
    && canonicalJson(existing.timing) === canonicalJson(timing)
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
  scheduleAction: 'none' | 'created' | 'reused',
  schedule?: ScheduledTask,
): AppliedPresetInstall {
  return {
    kind: 'preset-install-result',
    presetId: plan.preset.id,
    action,
    pipelineId,
    pipelineName: plan.pipelineName,
    scheduleAction,
    ...(schedule ? { scheduleId: schedule.id } : {}),
    ...(schedule?.nextRunAt ? { nextRunAt: schedule.nextRunAt } : {}),
    storageFile: plan.storageFile,
    instanceId: plan.instanceId,
    workspace: plan.workspace,
    warnings: plan.warnings,
  }
}

function parseClockTime(value: string | undefined): { hour: number; minute: number } {
  if (!value?.trim()) throw new Error('--schedule=daily or weekdays requires --time=HH:MM')
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) throw new Error('--time must use 24-hour HH:MM format')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23 || !Number.isSafeInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('--time must be a valid 24-hour clock time')
  }
  return { hour, minute }
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function normalizeInstanceId(value: string): string {
  const normalized = value.trim()
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error('preset instance id may contain only letters, numbers, dot, underscore, and hyphen')
  }
  return normalized
}