import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import { createHostSetupContext } from './context.js'
import {
  applySetupMutation,
  discoverSetupHosts,
  executeDoctorCommand,
  mutationNeedsConfirmation,
  prepareSetupMutation,
  type AppliedSetupMutation,
  type PreparedSetupMutation,
  type SetupCommandOptions,
  type SetupDiscoveryResult,
  type SetupDoctorResult,
} from './commands.js'
import { createDefaultHostSetupRegistry, type HostSetupRegistry } from './registry.js'
import type { HostSetupContext, SetupOperation, SetupScope } from './types.js'

export type SetupCliCommand = 'setup' | 'doctor' | 'repair' | 'uninstall'

export interface ParsedSetupCliArgs extends SetupCommandOptions {
  readonly dryRun: boolean
  readonly assumeYes: boolean
  readonly json: boolean
  readonly help: boolean
}

export interface SetupCliRuntime {
  readonly registry?: HostSetupRegistry
  readonly context?: HostSetupContext
  readonly stdin?: Readable
  readonly stdout?: Writable
}

export async function runSetupCli(
  command: SetupCliCommand,
  args: readonly string[],
  runtime: SetupCliRuntime = {},
): Promise<void> {
  const parsed = parseSetupCliArgs(args)
  const stdout = runtime.stdout ?? process.stdout
  if (parsed.help) {
    stdout.write(`${setupHelp(command)}\n`)
    return
  }

  const registry = runtime.registry ?? createDefaultHostSetupRegistry()
  const context = runtime.context ?? createHostSetupContext({ cwd: parsed.projectDir })

  if (command === 'setup' && !parsed.target) {
    const discovery = await discoverSetupHosts(context, registry)
    writeOutput(stdout, discovery, parsed.json)
    return
  }

  if (command === 'doctor') {
    const result = await executeDoctorCommand(context, registry, parsed)
    writeOutput(stdout, result, parsed.json)
    return
  }

  const operation = command as SetupOperation
  const prepared = await prepareSetupMutation(operation, context, registry, parsed)
  if (parsed.dryRun) {
    writeOutput(stdout, prepared, parsed.json)
    return
  }

  let approved = parsed.assumeYes
  if (!approved && mutationNeedsConfirmation(prepared)) {
    approved = await confirmMutation(prepared, runtime.stdin ?? process.stdin, stdout)
    if (!approved) {
      writeOutput(stdout, { kind: 'cancelled', operation, plans: prepared.plans }, parsed.json)
      return
    }
  }

  const result = await applySetupMutation(prepared, context, registry, approved)
  writeOutput(stdout, result, parsed.json)
}

export function parseSetupCliArgs(args: readonly string[]): ParsedSetupCliArgs {
  let target: string | undefined
  let scope: SetupScope = 'user'
  let projectDir = process.cwd()
  let dryRun = false
  let assumeYes = false
  let json = false
  let help = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--yes' || arg === '-y') {
      assumeYes = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--scope' || arg.startsWith('--scope=')) {
      const value = optionValue(args, index, 'scope')
      if (arg === '--scope') index += 1
      if (value !== 'user' && value !== 'project') throw new Error('--scope must be user or project')
      scope = value
      continue
    }
    if (arg === '--project-dir' || arg.startsWith('--project-dir=')) {
      const value = optionValue(args, index, 'project-dir')
      if (arg === '--project-dir') index += 1
      projectDir = value
      continue
    }
    if (arg.startsWith('-')) throw new Error(`unknown setup option ${arg}`)
    if (target) throw new Error(`unexpected extra setup argument ${arg}`)
    target = arg
  }

  return {
    ...(target ? { target } : {}),
    scope,
    projectDir,
    dryRun,
    assumeYes,
    json,
    help,
  }
}

function optionValue(args: readonly string[], index: number, name: string): string {
  const arg = args[index]!
  const prefix = `--${name}=`
  const value = arg.startsWith(prefix) ? arg.slice(prefix.length) : args[index + 1]
  if (!value?.trim()) throw new Error(`--${name} requires a value`)
  return value.trim()
}

async function confirmMutation(
  prepared: PreparedSetupMutation,
  stdin: Readable,
  stdout: Writable,
): Promise<boolean> {
  if (!(stdin as NodeJS.ReadStream).isTTY || !(stdout as NodeJS.WriteStream).isTTY) {
    throw new Error(
      `${prepared.operation} requires confirmation in a non-interactive shell; rerun with --yes after reviewing --dry-run`,
    )
  }
  renderPlans(stdout, prepared)
  const rl = createInterface({ input: stdin, output: stdout, terminal: true })
  try {
    const answer = await rl.question(`Apply ${prepared.operation} plan? [y/N] `)
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
  if (isDiscovery(value)) {
    renderDiscovery(stdout, value)
    return
  }
  if (isDoctor(value)) {
    renderDoctor(stdout, value)
    return
  }
  if (isPrepared(value)) {
    renderPlans(stdout, value)
    return
  }
  if (isApplied(value)) {
    renderResults(stdout, value)
    return
  }
  const cancelled = value as { kind?: unknown; operation?: unknown }
  if (cancelled?.kind === 'cancelled') {
    stdout.write(`${String(cancelled.operation)} cancelled; no changes applied.\n`)
    return
  }
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function renderDiscovery(stdout: Writable, result: SetupDiscoveryResult): void {
  stdout.write('Flowit Workflow host setup\n\n')
  for (const host of result.hosts) {
    const provider = host.provider === 'registered' ? 'provider ready' : 'provider pending'
    const detection = host.detection ? `, ${host.detection.status}` : ''
    stdout.write(`- ${host.displayName} (${host.hostId}): ${provider}${detection}\n`)
  }
  stdout.write('\nUse `flowit-workflow setup <host> --dry-run` to inspect an implemented provider.\n')
}

function renderDoctor(stdout: Writable, result: SetupDoctorResult): void {
  for (const report of result.reports) {
    stdout.write(`${report.displayName}: ${report.status}\n`)
    for (const check of report.checks) {
      const marker = check.status === 'ok' ? '✓' : check.status === 'warning' ? '!' : check.status === 'error' ? '✗' : '-'
      stdout.write(`  ${marker} ${check.summary}\n`)
      if (check.detail) stdout.write(`    ${check.detail}\n`)
    }
  }
}

function renderPlans(stdout: Writable, prepared: PreparedSetupMutation): void {
  for (const plan of prepared.plans) {
    stdout.write(`${plan.displayName} ${plan.operation} plan (${plan.scope})\n`)
    stdout.write(`  ${plan.summary}\n`)
    if (plan.actions.length === 0) stdout.write('  No automatic actions.\n')
    for (const action of plan.actions) {
      stdout.write(`  - [${action.risk}] ${action.description}\n`)
    }
    for (const warning of plan.warnings) stdout.write(`  ! ${warning}\n`)
    for (const step of plan.manualSteps) stdout.write(`  manual: ${step}\n`)
  }
}

function renderResults(stdout: Writable, applied: AppliedSetupMutation): void {
  for (const result of applied.results) {
    stdout.write(`${result.displayName}: ${result.status}\n`)
    for (const warning of result.warnings) stdout.write(`  ! ${warning}\n`)
    for (const step of result.manualSteps) stdout.write(`  manual: ${step}\n`)
  }
}

function isDiscovery(value: unknown): value is SetupDiscoveryResult {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'discovery')
}
function isDoctor(value: unknown): value is SetupDoctorResult {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'doctor')
}
function isPrepared(value: unknown): value is PreparedSetupMutation {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'mutation-plan')
}
function isApplied(value: unknown): value is AppliedSetupMutation {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'mutation-result')
}

export function setupHelp(command: SetupCliCommand): string {
  const target = command === 'doctor' ? '[host|all]' : command === 'setup' ? '[host|all]' : '<host|all>'
  return [
    `flowit-workflow ${command} ${target} [options]`,
    '',
    'Options:',
    '  --scope=user|project   Select user or project configuration scope',
    '  --project-dir=<path>   Project directory for project-scoped setup',
    '  --dry-run              Print the exact provider plan without applying it',
    '  --yes, -y              Approve confirmation-gated actions non-interactively',
    '  --json                 Emit machine-readable JSON for Agent-driven setup',
    '  --help, -h             Show this help',
    '',
    command === 'setup' ? 'With no host, setup lists known hosts and provider availability.' : '',
  ].filter(Boolean).join('\n')
}
