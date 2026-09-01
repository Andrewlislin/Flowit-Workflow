import { appendFile, mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type StudioExperienceEventName =
  | 'runtime_bootstrap_success'
  | 'host_setup_success'
  | 'studio_install_success'
  | 'studio_install_pending_manual'
  | 'studio_install_failed'

export type StudioExperienceFailureStage =
  | 'runtime-bootstrap'
  | 'package-validate'
  | 'trust'
  | 'preflight'
  | 'package-install'
  | 'host-setup'
  | 'doctor'
  | 'unknown'

export interface StudioExperienceEvent {
  readonly version: 1
  readonly event: StudioExperienceEventName
  readonly at: string
  readonly studioId?: string
  readonly studioVersion?: string
  readonly hostId?: string
  readonly durationMs?: number
  readonly failureStage?: StudioExperienceFailureStage
}

export interface StudioExperienceRecorderOptions {
  readonly homeDir?: string
  readonly file?: string
}

export interface StudioExperienceReport {
  readonly file: string
  readonly events: number
  readonly counts: Readonly<Record<StudioExperienceEventName, number>>
}

const ALLOWED_KEYS = new Set([
  'version',
  'event',
  'at',
  'studioId',
  'studioVersion',
  'hostId',
  'durationMs',
  'failureStage',
])
const EVENT_NAMES = new Set<StudioExperienceEventName>([
  'runtime_bootstrap_success',
  'host_setup_success',
  'studio_install_success',
  'studio_install_pending_manual',
  'studio_install_failed',
])
const FAILURE_STAGES = new Set<StudioExperienceFailureStage>([
  'runtime-bootstrap',
  'package-validate',
  'trust',
  'preflight',
  'package-install',
  'host-setup',
  'doctor',
  'unknown',
])

export async function recordStudioExperience(
  value: StudioExperienceEvent | unknown,
  options: StudioExperienceRecorderOptions = {},
): Promise<void> {
  const event = canonicalStudioExperienceEvent(value)
  const file = experienceFile(options)
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function bestEffortRecordStudioExperience(
  value: StudioExperienceEvent | unknown,
  options: StudioExperienceRecorderOptions = {},
): Promise<void> {
  await recordStudioExperience(value, options).catch(() => undefined)
}

export async function readStudioExperienceReport(
  options: StudioExperienceRecorderOptions = {},
): Promise<StudioExperienceReport> {
  const file = experienceFile(options)
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (!(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error
    }
  }
  const events = text
    .split('\n')
    .filter(line => line.trim())
    .map((line, index) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error(`invalid Studio experience diagnostic JSON on line ${index + 1}`)
      }
      return canonicalStudioExperienceEvent(parsed)
    })
  const counts = emptyCounts()
  for (const event of events) counts[event.event] += 1
  return { file, events: events.length, counts }
}

export function canonicalStudioExperienceEvent(value: unknown): StudioExperienceEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Studio experience event must be an object')
  }
  const object = value as Record<string, unknown>
  const unknown = Object.keys(object).filter(key => !ALLOWED_KEYS.has(key))
  if (unknown.length) {
    throw new Error(`Studio experience event contains unsupported fields: ${unknown.join(', ')}`)
  }
  if (object.version !== 1) throw new Error('Studio experience event version must be 1')
  if (typeof object.event !== 'string' || !EVENT_NAMES.has(object.event as StudioExperienceEventName)) {
    throw new Error('Studio experience event name is invalid')
  }
  if (typeof object.at !== 'string' || !Number.isFinite(Date.parse(object.at))) {
    throw new Error('Studio experience event at must be an ISO date')
  }
  const studioId = optionalString(object.studioId, 'studioId')
  const studioVersion = optionalString(object.studioVersion, 'studioVersion')
  const hostId = optionalString(object.hostId, 'hostId')
  let durationMs: number | undefined
  if (object.durationMs !== undefined) {
    if (!Number.isSafeInteger(object.durationMs) || (object.durationMs as number) < 0) {
      throw new Error('Studio experience durationMs must be a non-negative integer')
    }
    durationMs = object.durationMs as number
  }
  let failureStage: StudioExperienceFailureStage | undefined
  if (object.failureStage !== undefined) {
    if (
      typeof object.failureStage !== 'string' ||
      !FAILURE_STAGES.has(object.failureStage as StudioExperienceFailureStage)
    ) {
      throw new Error('Studio experience failureStage is invalid')
    }
    failureStage = object.failureStage as StudioExperienceFailureStage
  }
  return {
    version: 1,
    event: object.event as StudioExperienceEventName,
    at: object.at,
    ...(studioId ? { studioId } : {}),
    ...(studioVersion ? { studioVersion } : {}),
    ...(hostId ? { hostId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(failureStage ? { failureStage } : {}),
  }
}

function experienceFile(options: StudioExperienceRecorderOptions): string {
  return path.resolve(
    options.file ??
      path.join(
        options.homeDir ?? os.homedir(),
        '.flowit-workflow',
        'diagnostics',
        'experience.jsonl',
      ),
  )
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Studio experience ${field} must be a non-empty string`)
  }
  return value.trim()
}

function emptyCounts(): Record<StudioExperienceEventName, number> {
  return {
    runtime_bootstrap_success: 0,
    host_setup_success: 0,
    studio_install_success: 0,
    studio_install_pending_manual: 0,
    studio_install_failed: 0,
  }
}
