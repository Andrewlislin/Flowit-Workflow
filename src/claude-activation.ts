import { randomBytes } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ACTIVATION_VERSION = 1 as const
const LOCK_WAIT_MS = 25
const LOCK_TIMEOUT_MS = 2_000
const STALE_LOCK_MS = 30_000

export type ClaudeActivationEvent =
  | 'mcp-initialized'
  | 'user-prompt-hook'
  | 'pre-tool-hook'
  | 'lifecycle-hook'

export interface ClaudeActivationMetadata {
  readonly pluginRoot?: string
  readonly generation?: string
  readonly runtimePackageRoot?: string
  readonly packageVersion?: string
  readonly mcpServerDigest?: string
  readonly cliDigest?: string
}

export interface ClaudeActivationRecord {
  readonly version: 1
  readonly pluginRoot: string
  readonly generation: string
  readonly runtimePackageRoot?: string
  readonly packageVersion?: string
  readonly mcpServerDigest?: string
  readonly cliDigest?: string
  readonly mcpInitializedAt?: string
  readonly userPromptHookSeenAt?: string
  readonly preToolHookSeenAt?: string
  readonly lifecycleHookSeenAt?: string
  readonly updatedAt: string
}

interface ClaudeActivationLedger {
  readonly version: 1
  readonly records: Readonly<Record<string, ClaudeActivationRecord>>
}

export function claudeActivationFile(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  return path.resolve(
    env.FLOWIT_WORKFLOW_CLAUDE_ACTIVATION_FILE?.trim() ||
      path.join(os.homedir(), '.flowit-workflow', 'claude', 'activation.json'),
  )
}

export function claudeActivationMetadataFromEnvironment(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): ClaudeActivationMetadata {
  return compactMetadata({
    pluginRoot:
      env.FLOWIT_WORKFLOW_PLUGIN_ROOT?.trim() ||
      env.CLAUDE_PLUGIN_ROOT?.trim(),
    generation: env.FLOWIT_WORKFLOW_INSTALLATION_GENERATION?.trim(),
    runtimePackageRoot: env.FLOWIT_WORKFLOW_RUNTIME_PACKAGE_ROOT?.trim(),
    packageVersion: env.FLOWIT_WORKFLOW_RUNTIME_VERSION?.trim(),
    mcpServerDigest: env.FLOWIT_WORKFLOW_MCP_SERVER_DIGEST?.trim(),
    cliDigest: env.FLOWIT_WORKFLOW_CLI_DIGEST?.trim(),
  })
}

export async function recordClaudeActivation(
  event: ClaudeActivationEvent,
  metadata: ClaudeActivationMetadata = claudeActivationMetadataFromEnvironment(),
  options: {
    readonly env?: Readonly<NodeJS.ProcessEnv>
    readonly now?: Date
  } = {},
): Promise<boolean> {
  const normalized = normalizeMetadata(metadata)
  if (!normalized) return false
  const file = claudeActivationFile(options.env)
  const release = await acquireLock(`${file}.lock`)
  try {
    const ledger = await readLedger(file)
    const now = (options.now ?? new Date()).toISOString()
    const existing = ledger.records[normalized.pluginRoot]
    const sameGeneration = existing?.generation === normalized.generation
    const record: ClaudeActivationRecord = {
      version: ACTIVATION_VERSION,
      pluginRoot: normalized.pluginRoot,
      generation: normalized.generation,
      ...inheritMetadata(sameGeneration ? existing : undefined, normalized),
      ...(sameGeneration && existing?.mcpInitializedAt
        ? { mcpInitializedAt: existing.mcpInitializedAt }
        : {}),
      ...(sameGeneration && existing?.userPromptHookSeenAt
        ? { userPromptHookSeenAt: existing.userPromptHookSeenAt }
        : {}),
      ...(sameGeneration && existing?.preToolHookSeenAt
        ? { preToolHookSeenAt: existing.preToolHookSeenAt }
        : {}),
      ...(sameGeneration && existing?.lifecycleHookSeenAt
        ? { lifecycleHookSeenAt: existing.lifecycleHookSeenAt }
        : {}),
      ...(event === 'mcp-initialized' ? { mcpInitializedAt: now } : {}),
      ...(event === 'user-prompt-hook' ? { userPromptHookSeenAt: now } : {}),
      ...(event === 'pre-tool-hook' ? { preToolHookSeenAt: now } : {}),
      ...(event === 'lifecycle-hook' ? { lifecycleHookSeenAt: now } : {}),
      updatedAt: now,
    }
    await writeLedger(file, {
      version: ACTIVATION_VERSION,
      records: {
        ...ledger.records,
        [normalized.pluginRoot]: record,
      },
    })
    return true
  } finally {
    await release()
  }
}

export async function readClaudeActivation(
  file: string,
  pluginRoot: string,
): Promise<ClaudeActivationRecord | undefined> {
  const ledger = await readLedger(path.resolve(file))
  const record = ledger.records[path.resolve(pluginRoot)]
  return record ? structuredClone(record) : undefined
}

function normalizeMetadata(
  metadata: ClaudeActivationMetadata,
): Required<Pick<ClaudeActivationMetadata, 'pluginRoot' | 'generation'>> &
  ClaudeActivationMetadata | undefined {
  const pluginRoot = metadata.pluginRoot?.trim()
  const generation = metadata.generation?.trim()
  if (!pluginRoot || !generation) return undefined
  return {
    ...compactMetadata(metadata),
    pluginRoot: path.resolve(pluginRoot),
    generation,
  }
}

function compactMetadata(
  metadata: ClaudeActivationMetadata,
): ClaudeActivationMetadata {
  const string = (value: string | undefined): string | undefined =>
    value?.trim() || undefined
  return {
    ...(string(metadata.pluginRoot) ? { pluginRoot: string(metadata.pluginRoot) } : {}),
    ...(string(metadata.generation) ? { generation: string(metadata.generation) } : {}),
    ...(string(metadata.runtimePackageRoot)
      ? { runtimePackageRoot: path.resolve(string(metadata.runtimePackageRoot)!) }
      : {}),
    ...(string(metadata.packageVersion)
      ? { packageVersion: string(metadata.packageVersion) }
      : {}),
    ...(string(metadata.mcpServerDigest)
      ? { mcpServerDigest: string(metadata.mcpServerDigest) }
      : {}),
    ...(string(metadata.cliDigest) ? { cliDigest: string(metadata.cliDigest) } : {}),
  }
}

function inheritMetadata(
  existing: ClaudeActivationRecord | undefined,
  current: ClaudeActivationMetadata,
): ClaudeActivationMetadata {
  return compactMetadata({
    runtimePackageRoot: current.runtimePackageRoot ?? existing?.runtimePackageRoot,
    packageVersion: current.packageVersion ?? existing?.packageVersion,
    mcpServerDigest: current.mcpServerDigest ?? existing?.mcpServerDigest,
    cliDigest: current.cliDigest ?? existing?.cliDigest,
  })
}

async function readLedger(file: string): Promise<ClaudeActivationLedger> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger()
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return emptyLedger()
  }
  if (!isRecord(value) || value.version !== ACTIVATION_VERSION || !isRecord(value.records)) {
    return emptyLedger()
  }
  const records: Record<string, ClaudeActivationRecord> = {}
  for (const [key, candidate] of Object.entries(value.records)) {
    const record = parseRecord(candidate)
    if (record && path.resolve(key) === record.pluginRoot) records[record.pluginRoot] = record
  }
  return { version: ACTIVATION_VERSION, records }
}

function parseRecord(value: unknown): ClaudeActivationRecord | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.version !== ACTIVATION_VERSION ||
    typeof value.pluginRoot !== 'string' ||
    typeof value.generation !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) return undefined
  const optional = (key: string): string | undefined =>
    typeof value[key] === 'string' && value[key] ? String(value[key]) : undefined
  return {
    version: ACTIVATION_VERSION,
    pluginRoot: path.resolve(value.pluginRoot),
    generation: value.generation,
    ...(optional('runtimePackageRoot')
      ? { runtimePackageRoot: path.resolve(optional('runtimePackageRoot')!) }
      : {}),
    ...(optional('packageVersion') ? { packageVersion: optional('packageVersion') } : {}),
    ...(optional('mcpServerDigest') ? { mcpServerDigest: optional('mcpServerDigest') } : {}),
    ...(optional('cliDigest') ? { cliDigest: optional('cliDigest') } : {}),
    ...(optional('mcpInitializedAt') ? { mcpInitializedAt: optional('mcpInitializedAt') } : {}),
    ...(optional('userPromptHookSeenAt')
      ? { userPromptHookSeenAt: optional('userPromptHookSeenAt') }
      : {}),
    ...(optional('preToolHookSeenAt') ? { preToolHookSeenAt: optional('preToolHookSeenAt') } : {}),
    ...(optional('lifecycleHookSeenAt')
      ? { lifecycleHookSeenAt: optional('lifecycleHookSeenAt') }
      : {}),
    updatedAt: value.updatedAt,
  }
}

async function writeLedger(file: string, ledger: ClaudeActivationLedger): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

async function acquireLock(file: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      const descriptor = await open(file, 'wx', 0o600)
      await descriptor.close()
      return async () => {
        await rm(file, { force: true })
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = await stat(file)
        .then(row => Date.now() - row.mtimeMs)
        .catch(() => 0)
      if (age > STALE_LOCK_MS) {
        await rm(file, { force: true }).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline) throw new Error(`Claude activation lock timed out: ${file}`)
      await new Promise(resolve => setTimeout(resolve, LOCK_WAIT_MS))
    }
  }
}

function emptyLedger(): ClaudeActivationLedger {
  return { version: ACTIVATION_VERSION, records: {} }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
