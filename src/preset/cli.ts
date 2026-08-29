import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import {
  applyPresetInstall,
  preparePresetInstall,
  type PresetInstallOptions,
  type PresetInstallRuntime,
} from './install.js'
import { createDefaultPresetRegistry, type PresetRegistry } from './registry.js'
import type { AppliedPresetInstall, PreparedPresetInstall, PresetDescriptor, PresetScheduleMode } from './types.js'

export type PresetCliCommand = 'list' | 'show' | 'install'

export interface PresetCliRuntime extends PresetInstallRuntime {
  readonly registry?: PresetRegistry
  readonly stdin?: Readable
  readonly stdout?: Writable
}

export interface ParsedPresetCliArgs {
  readonly command: PresetCliCommand
  readonly presetId?: string
  readonly install?: PresetInstallOptions
  readonly dryRun: boolean
  readonly assumeYes: boolean
  readonly json: boolean
  readonly help: boolean
}

export async function runPresetCli(
  args: readonly string[],
  runtime: PresetCliRuntime = {},
): Promise<void> {
  const parsed = parsePresetCliArgs(args, runtime.cwd ?? process.cwd())
  const stdout = runtime.stdout ?? process.stdout
  const registry = runtime.registry ?? createDefaultPresetRegistry()

  if (parsed.help) {
    stdout.write(`${presetHelp(parsed.command)}\n`)
    return
  }
  if (parsed.command === 'list') {
    writeOutput(stdout, registry.list().map(descriptor), parsed.json)
    return
  }
  if (!parsed.presetId) throw new Error(`preset ${parsed.command} requires a preset id`)
  if (parsed.command === 'show') {
    writeOutput(stdout, descriptor(registry.require(parsed.presetId)), parsed.json)
    return
  }

  const plan = await preparePresetInstall(parsed.install!, registry, runtime)
  if (parsed.dryRun) {
    writeOutput(stdout, plan, parsed.json)
    return
  }
  if (plan.action === 'incomplete') {
    writeOutput(stdout, plan, parsed.json)
    throw new Error(
      `preset ${plan.preset.id} is incomplete: bind roles ${plan.missingRoles.join(', ') || '(none)'} and provide required input before install`,
    )
  }
  const needsConfirmation = plan.action === 'create' || plan.schedule.action === 'create'
  if (needsConfirmation && !parsed.assumeYes) {
    const approved = await confirmInstall(plan, runtime.stdin ?? process.stdin, stdout)
    if (!approved) {
      writeOutput(stdout, { kind: 'preset-install-cancelled', presetId: plan.preset.id }, parsed.json)
      return
    }
  }
  const result = await applyPresetInstall(plan)
  writeOutput(stdout, result, parsed.json)
}

export function parsePresetCliArgs(args: readonly string[], cwd = process.cwd()): ParsedPresetCliArgs {
  const command = (args[0] ?? 'list') as PresetCliCommand
  if (command !== 'list' && command !== 'show' && command !== 'install') {
    throw new Error(`unknown preset command ${command}`)
  }
  let presetId: string | undefined
  let adapterId: string | undefined
  let pipelineName: string | undefined
  let input: string | undefined
  let workspace: string | undefined
  let projectDir = cwd
  let instanceId: string | undefined
  let storageFile: string | undefined
  let scheduleMode: PresetScheduleMode | undefined
  let scheduleName: string | undefined
  let scheduleTime: string | undefined
  let timeZone: string | undefined
  let everySeconds: number | undefined
  let dryRun = false
  let assumeYes = false
  let json = false
  let help = false
  let allSession: string | undefined
  let allSkills: string[] | undefined
  const sessions: Record<string, string> = {}
  const roleAdapters: Record<string, string> = {}
  const skills: Record<string, string[]> = {}

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--yes' || arg === '-y') { assumeYes = true; continue }
    if (arg === '--json') { json = true; continue }
    if (arg === '--help' || arg === '-h') { help = true; continue }
    if (isOption(arg, 'adapter')) { adapterId = optionValue(args, index, 'adapter'); if (arg === '--adapter') index += 1; continue }
    if (isOption(arg, 'name')) { pipelineName = optionValue(args, index, 'name'); if (arg === '--name') index += 1; continue }
    if (isOption(arg, 'input')) { input = optionValue(args, index, 'input'); if (arg === '--input') index += 1; continue }
    if (isOption(arg, 'workspace')) { workspace = optionValue(args, index, 'workspace'); if (arg === '--workspace') index += 1; continue }
    if (isOption(arg, 'project-dir')) { projectDir = optionValue(args, index, 'project-dir'); if (arg === '--project-dir') index += 1; continue }
    if (isOption(arg, 'instance')) { instanceId = optionValue(args, index, 'instance'); if (arg === '--instance') index += 1; continue }
    if (isOption(arg, 'storage')) { storageFile = optionValue(args, index, 'storage'); if (arg === '--storage') index += 1; continue }
    if (isOption(arg, 'schedule')) {
      const value = optionValue(args, index, 'schedule')
      if (arg === '--schedule') index += 1
      if (value !== 'manual' && value !== 'daily' && value !== 'weekdays' && value !== 'every') {
        throw new Error('--schedule must be manual, daily, weekdays, or every')
      }
      scheduleMode = value
      continue
    }
    if (isOption(arg, 'schedule-name')) { scheduleName = optionValue(args, index, 'schedule-name'); if (arg === '--schedule-name') index += 1; continue }
    if (isOption(arg, 'time')) { scheduleTime = optionValue(args, index, 'time'); if (arg === '--time') index += 1; continue }
    if (isOption(arg, 'timezone')) { timeZone = optionValue(args, index, 'timezone'); if (arg === '--timezone') index += 1; continue }
    if (isOption(arg, 'every-seconds')) {
      const value = optionValue(args, index, 'every-seconds')
      if (arg === '--every-seconds') index += 1
      everySeconds = Number(value)
      if (!Number.isSafeInteger(everySeconds)) throw new Error('--every-seconds must be an integer')
      continue
    }
    if (isOption(arg, 'session')) {
      const [roleId, value] = bindingValue(optionValue(args, index, 'session'), 'session')
      if (arg === '--session') index += 1
      if (roleId === 'all') allSession = value
      else sessions[roleId] = value
      continue
    }
    if (isOption(arg, 'role-adapter')) {
      const [roleId, value] = bindingValue(optionValue(args, index, 'role-adapter'), 'role-adapter')
      if (arg === '--role-adapter') index += 1
      if (roleId === 'all') throw new Error('--role-adapter=all is unnecessary; use --adapter')
      roleAdapters[roleId] = value
      continue
    }
    if (isOption(arg, 'skill')) {
      const [roleId, value] = bindingValue(optionValue(args, index, 'skill'), 'skill')
      if (arg === '--skill') index += 1
      const values = value.split(',').map(item => item.trim()).filter(Boolean)
      if (roleId === 'all') allSkills = values
      else skills[roleId] = values
      continue
    }
    if (arg.startsWith('-')) throw new Error(`unknown preset option ${arg}`)
    if (presetId) throw new Error(`unexpected extra preset argument ${arg}`)
    presetId = arg
  }

  if ((command === 'show' || command === 'install') && !presetId && !help) {
    throw new Error(`preset ${command} requires a preset id`)
  }
  if (command !== 'install') {
    return { command, ...(presetId ? { presetId } : {}), dryRun, assumeYes, json, help }
  }

  const install: PresetInstallOptions = {
    presetId: presetId ?? '',
    projectDir,
    ...(adapterId ? { adapterId } : {}),
    ...(pipelineName ? { pipelineName } : {}),
    ...(input ? { input } : {}),
    ...(workspace ? { workspace } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(storageFile ? { storageFile } : {}),
    ...(scheduleMode ? { scheduleMode } : {}),
    ...(scheduleName ? { scheduleName } : {}),
    ...(scheduleTime ? { scheduleTime } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(everySeconds !== undefined ? { everySeconds } : {}),
    ...(allSession ? { allSession } : {}),
    ...(Object.keys(sessions).length ? { sessions } : {}),
    ...(Object.keys(roleAdapters).length ? { roleAdapters } : {}),
    ...(allSkills ? { allSkills } : {}),
    ...(Object.keys(skills).length ? { skills } : {}),
  }
  return { command, presetId: presetId ?? '', install, dryRun, assumeYes, json, help }
}

async function confirmInstall(
  plan: PreparedPresetInstall,
  stdin: Readable,
  stdout: Writable,
): Promise<boolean> {
  if (!(stdin as NodeJS.ReadStream).isTTY || !(stdout as NodeJS.WriteStream).isTTY) {
    throw new Error('preset install/activation requires confirmation in a non-interactive shell; rerun with --yes after reviewing --dry-run')
  }
  renderInstallPlan(stdout, plan)
  const rl = createInterface({ input: stdin, output: stdout, terminal: true })
  try {
    const answer = await rl.question(`Apply preset plan for ${JSON.stringify(plan.pipelineName)}? [y/N] `)
    return /^(y|yes)$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

function writeOutput(stdout: Writable, value: unknown, json: boolean): void {
  if (json) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (Array.isArray(value) && value.every(isDescriptor)) {
    for (const preset of value) {
      stdout.write(`${preset.id} — ${preset.displayName}\n  ${preset.description}\n`)
    }
    return
  }
  if (isDescriptor(value)) {
    stdout.write(`${value.displayName} (${value.id})\n${value.description}\n\nRoles:\n`)
    for (const role of value.roles) stdout.write(`- ${role.id}: ${role.displayName} — ${role.description}\n`)
    stdout.write(`\nInput: ${value.inputRequired ? 'required' : 'optional'} — ${value.inputLabel}\n`)
    return
  }
  if (isInstallPlan(value)) {
    renderInstallPlan(stdout, value)
    return
  }
  if (isInstallResult(value)) {
    stdout.write(`${value.action === 'created' ? 'Created' : 'Reused'} ${value.pipelineName}\n`)
    stdout.write(`Pipeline id: ${value.pipelineId}\nStore: ${value.storageFile}\nWorkspace: ${value.workspace}\n`)
    if (value.scheduleAction !== 'none') {
      stdout.write(`${value.scheduleAction === 'created' ? 'Created' : 'Reused'} activation schedule: ${value.scheduleId ?? '(unknown)'}\n`)
      if (value.nextRunAt) stdout.write(`Next run: ${value.nextRunAt}\n`)
    } else {
      stdout.write('Activation: manual\n')
    }
    if (value.presetId === 'content-studio') stdout.write('Publishing is intentionally not automatic; review the final artifact before external side effects.\n')
    return
  }
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function renderInstallPlan(stdout: Writable, plan: PreparedPresetInstall): void {
  stdout.write(`${plan.preset.displayName} preset install plan\n`)
  stdout.write(`  Pipeline: ${plan.pipelineName}\n  Store: ${plan.storageFile}\n  Workspace: ${plan.workspace}\n  Pipeline action: ${plan.action}\n`)
  stdout.write(`  Activation: ${plan.schedule.mode} (${plan.schedule.action})\n`)
  if (plan.schedule.timing) stdout.write(`  Schedule timing: ${JSON.stringify(plan.schedule.timing)}\n`)
  if (plan.schedule.existingScheduleId) stdout.write(`  Existing schedule: ${plan.schedule.existingScheduleId}\n`)
  if (plan.bindings.length) {
    stdout.write('  Bindings:\n')
    for (const binding of plan.bindings) {
      stdout.write(`    - ${binding.roleId} -> ${binding.adapterId}:${binding.sessionId}${binding.skills.length ? ` [${binding.skills.join(', ')}]` : ''}\n`)
    }
  }
  if (plan.missingRoles.length) stdout.write(`  Missing roles: ${plan.missingRoles.join(', ')}\n`)
  for (const warning of plan.warnings) stdout.write(`  ! ${warning}\n`)
  if (plan.action === 'reuse' && plan.existingPipelineId) stdout.write(`  Existing pipeline: ${plan.existingPipelineId}\n`)
}

function descriptor(preset: PresetDescriptor): PresetDescriptor {
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

function isDescriptor(value: unknown): value is PresetDescriptor {
  return Boolean(value && typeof value === 'object' && typeof (value as PresetDescriptor).id === 'string' && Array.isArray((value as PresetDescriptor).roles))
}
function isInstallPlan(value: unknown): value is PreparedPresetInstall {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'preset-install-plan')
}
function isInstallResult(value: unknown): value is AppliedPresetInstall {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'preset-install-result')
}
function isOption(arg: string, name: string): boolean {
  return arg === `--${name}` || arg.startsWith(`--${name}=`)
}
function optionValue(args: readonly string[], index: number, name: string): string {
  const arg = args[index]!
  const prefix = `--${name}=`
  const value = arg.startsWith(prefix) ? arg.slice(prefix.length) : args[index + 1]
  if (!value?.trim()) throw new Error(`--${name} requires a value`)
  return value.trim()
}
function bindingValue(value: string, option: string): [string, string] {
  const equals = value.indexOf('=')
  if (equals <= 0 || equals === value.length - 1) throw new Error(`--${option} requires <role>=<value>`)
  return [value.slice(0, equals).trim(), value.slice(equals + 1).trim()]
}

export function presetHelp(command: PresetCliCommand = 'list'): string {
  if (command === 'list') return 'flowit-workflow preset list [--json]'
  if (command === 'show') return 'flowit-workflow preset show <preset> [--json]'
  return [
    'flowit-workflow preset install <preset> [options]',
    '',
    'Role binding:',
    '  --adapter=<host>              Default host adapter for every role',
    '  --session=all=<sessionId>     Bind every role to one session (novice/single-agent path)',
    '  --session=<role>=<sessionId>  Bind one role; repeat for multi-session teams',
    '  --role-adapter=<role>=<host>  Override the host for one role',
    '  --skill=all=<a,b>             Bind optional Skills to every role',
    '  --skill=<role>=<a,b>          Bind optional Skills to one role',
    '',
    'Activation:',
    '  --schedule=manual             Install only; run explicitly later (default)',
    '  --schedule=daily --time=08:00 [--timezone=Asia/Shanghai]',
    '  --schedule=weekdays --time=08:00 [--timezone=Asia/Shanghai]',
    '  --schedule=every --every-seconds=3600',
    '  --schedule-name=<name>        Override the durable Schedule name',
    '',
    'Preset input/storage:',
    '  --input=<text>                Editorial brief, research question, or team goal',
    '  --workspace=<path>            Durable artifact workspace',
    '  --name=<pipelineName>         Pipeline name; same-name conflicts fail closed',
    '  --project-dir=<path>          Base directory for the default workspace',
    '  --instance=<id>               Flowit orchestration instance',
    '  --storage=<path>              Explicit workflow store (useful for DSH/project stores)',
    '  --dry-run                     Show the exact Pipeline/Schedule/store plan without mutation',
    '  --yes, -y                     Confirm Pipeline/Schedule creation non-interactively',
    '  --json                        Machine-readable output',
  ].join('\n')
}