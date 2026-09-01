import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentExecutionCapability,
  AgentExecutionPreflightRequest,
  AgentExecutionRequirement,
  AgentSessionPlan,
} from './core/types.js'
import type { ExplicitRunOncePlan } from './explicit-run-once.js'
import { readOrCreateAuthoritySecret } from './routing/authority-state.js'
import { canonicalJson } from './routing/canonical.js'

const GRANT_VERSION = 1 as const
const DEFAULT_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const ALLOWED_CAPABILITIES = new Set<AgentExecutionCapability>([
  'workspace-read',
  'workspace-write',
  'network',
])

export type ExecutionGrantSource =
  | 'mcp-elicitation'
  | 'bounded-readonly-default'

export type CodexSandboxMode = 'read-only' | 'workspace-write'

export type CodexSandboxPolicy =
  | {
      readonly type: 'readOnly'
      readonly networkAccess: boolean
    }
  | {
      readonly type: 'workspaceWrite'
      readonly writableRoots: readonly string[]
      readonly networkAccess: boolean
      readonly excludeTmpdirEnvVar: true
      readonly excludeSlashTmp: true
    }

export interface CodexPermissionEnvelope {
  readonly adapterId: 'codex'
  readonly sandboxMode: CodexSandboxMode
  readonly sandboxPolicy: CodexSandboxPolicy
  readonly approvalPolicy: 'never'
  readonly capabilities: readonly AgentExecutionCapability[]
  readonly dedicatedCwd: string
}

export interface CodexPermissionEvidence {
  readonly requestedCapabilities: readonly AgentExecutionCapability[]
  readonly grantedCapabilities: readonly AgentExecutionCapability[]
  readonly source: ExecutionGrantSource
  readonly scope: 'run'
  readonly sandboxMode: CodexSandboxMode
  readonly sandboxPolicy: CodexSandboxPolicy
  readonly approvalPolicy: 'never'
  readonly networkAccess: boolean
  readonly writableRoots: readonly string[]
  readonly grantDigest: string
  readonly verified: true
}

export interface CodexPermissionVerificationInput {
  readonly correlationId: string
  readonly session: AgentSessionPlan
  readonly requirement: AgentExecutionRequirement
}

interface ExecutionGrantPayload {
  readonly kind: 'flowit-execution-permission-grant'
  readonly version: 1
  readonly requestId: string
  readonly requestKey: string
  readonly inputDigest: string
  readonly definitionId: string
  readonly triggerKey: string
  readonly envelope: CodexPermissionEnvelope
  readonly source: ExecutionGrantSource
  readonly issuedAt: string
  readonly expiresAt: string
  readonly nonce: string
}

interface StoredExecutionGrant {
  readonly version: 1
  readonly token: string
}

export interface ExecutionGrantServiceOptions {
  readonly directory: string
  readonly secret?: string | Buffer
  readonly ttlMs?: number
  readonly now?: () => Date
}

export interface ExecutionGrantPaths {
  readonly directory: string
  readonly grantsDirectory: string
  readonly secretFile: string
}

export class ExecutionGrantService {
  private readonly directory: string
  private readonly key: Buffer
  private readonly ttlMs: number
  private readonly now: () => Date

  constructor(options: ExecutionGrantServiceOptions) {
    this.directory = path.resolve(options.directory)
    this.key = normalizeSecret(
      options.secret ?? readOrCreateAuthoritySecret(
        path.join(this.directory, 'secret.key'),
      ),
    )
    this.ttlMs = positiveInteger(
      options.ttlMs ?? DEFAULT_GRANT_TTL_MS,
      'ttlMs',
    )
    this.now = options.now ?? (() => new Date())
  }

  findValidPlanGrant(plan: ExplicitRunOncePlan): CodexPermissionEvidence | undefined {
    const stored = this.readStored(plan.requestKey)
    if (!stored) return undefined
    const payload = verifyToken(this.key, stored.token)
    assertPlanIdentity(payload, plan)
    if (Date.parse(payload.expiresAt) <= this.now().getTime()) return undefined
    return evidence(payload, stored.token)
  }

  issuePlanGrant(
    plan: ExplicitRunOncePlan,
    source: ExecutionGrantSource,
  ): CodexPermissionEvidence {
    const existing = this.readStored(plan.requestKey)
    if (existing) {
      const payload = verifyToken(this.key, existing.token)
      assertPlanIdentity(payload, plan)
      if (Date.parse(payload.expiresAt) > this.now().getTime()) {
        return evidence(payload, existing.token)
      }
    }

    const issuedAt = this.now()
    const payload: ExecutionGrantPayload = {
      kind: 'flowit-execution-permission-grant',
      version: GRANT_VERSION,
      requestId: plan.input.requestId,
      requestKey: plan.requestKey,
      inputDigest: plan.inputDigest,
      definitionId: plan.definitionId,
      triggerKey: plan.triggerKey,
      envelope: permissionEnvelopeForPlan(plan),
      source,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.ttlMs).toISOString(),
      nonce: randomBytes(16).toString('hex'),
    }
    const token = signToken(this.key, payload)
    this.writeStored(plan.requestKey, { version: GRANT_VERSION, token })
    return evidence(payload, token)
  }

  verifyCodexRequest(
    input: CodexPermissionVerificationInput,
  ): CodexPermissionEvidence {
    const scope = permissionScopeFromCorrelation(input.correlationId)
    const stored = this.readStored(scope.requestKey)
    if (!stored) {
      throw permissionError(
        `Flowit execution permission grant ${scope.requestKey} is missing`,
      )
    }
    const payload = verifyToken(this.key, stored.token)
    assertNotExpired(payload.expiresAt, this.now())
    if (
      payload.requestKey !== scope.requestKey ||
      payload.inputDigest !== scope.inputDigest ||
      payload.definitionId !== `explicit-run-once:${scope.requestKey}` ||
      payload.triggerKey !== `explicit:${scope.inputDigest}`
    ) {
      throw permissionError(
        'Flowit execution permission grant does not match the current run-once correlation',
      )
    }
    const capabilities = normalizeCapabilities(
      input.requirement.requiredCapabilities ?? [],
    )
    if (canonicalJson(capabilities) !== canonicalJson(payload.envelope.capabilities)) {
      throw permissionError(
        'Flowit execution permission grant does not match the requested capabilities',
      )
    }
    if (
      input.session.kind === 'dedicated' &&
      path.resolve(input.session.cwd) !== payload.envelope.dedicatedCwd
    ) {
      throw permissionError(
        'Flowit execution permission grant belongs to a different dedicated working directory',
      )
    }
    return evidence(payload, stored.token)
  }

  private readStored(requestKey: string): StoredExecutionGrant | undefined {
    const file = this.grantFile(requestKey)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error: unknown) {
      throw new Error(
        `invalid Flowit execution grant ${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (
      !isRecord(value) ||
      value.version !== GRANT_VERSION ||
      typeof value.token !== 'string' ||
      !value.token.trim()
    ) {
      throw new Error(`invalid Flowit execution grant record ${file}`)
    }
    return { version: GRANT_VERSION, token: value.token }
  }

  private writeStored(requestKey: string, value: StoredExecutionGrant): void {
    const file = this.grantFile(requestKey)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, file)
    try { chmodSync(file, 0o600) } catch {}
  }

  private grantFile(requestKey: string): string {
    if (!/^[a-f0-9]{64}$/.test(requestKey)) {
      throw new Error('execution grant requestKey must be a lowercase SHA-256 digest')
    }
    return path.join(this.directory, 'grants', `${requestKey}.json`)
  }
}

export function executionGrantPaths(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): ExecutionGrantPaths {
  const directory = path.resolve(
    env.FLOWIT_WORKFLOW_EXECUTION_AUTHORITY_DIR?.trim() ||
      path.join(os.homedir(), '.flowit-workflow', 'execution-authority'),
  )
  return {
    directory,
    grantsDirectory: path.join(directory, 'grants'),
    secretFile: path.join(directory, 'secret.key'),
  }
}

export function createExecutionGrantServiceFromEnvironment(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): ExecutionGrantService {
  const paths = executionGrantPaths(env)
  const explicitSecret = env.FLOWIT_WORKFLOW_EXECUTION_AUTHORITY_SECRET?.trim()
  return new ExecutionGrantService({
    directory: paths.directory,
    ...(explicitSecret ? { secret: explicitSecret } : {}),
  })
}

export function createCodexPermissionGrantVerifierFromEnvironment(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): (input: CodexPermissionVerificationInput) => CodexPermissionEvidence {
  let service: ExecutionGrantService | undefined
  return input => {
    service ??= createExecutionGrantServiceFromEnvironment(env)
    return service.verifyCodexRequest(input)
  }
}

export function permissionEnvelopeForPlan(
  plan: ExplicitRunOncePlan,
): CodexPermissionEnvelope {
  const capabilities = normalizeCapabilities(
    plan.input.target.execution?.requiredCapabilities ?? [],
  )
  const writable = capabilities.includes('workspace-write')
  const networkAccess = capabilities.includes('network')
  const dedicatedCwd = path.resolve(plan.input.target.dedicatedCwd)
  const sandboxPolicy: CodexSandboxPolicy = writable
    ? {
        type: 'workspaceWrite',
        writableRoots: [dedicatedCwd],
        networkAccess,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      }
    : {
        type: 'readOnly',
        networkAccess,
      }
  return {
    adapterId: 'codex',
    sandboxMode: writable ? 'workspace-write' : 'read-only',
    sandboxPolicy,
    approvalPolicy: 'never',
    capabilities,
    dedicatedCwd,
  }
}

export function requiresInteractivePermissionApproval(
  envelope: CodexPermissionEnvelope,
): boolean {
  return envelope.networkAccess || envelope.capabilities.includes('workspace-write')
}

export function permissionApprovalMessage(
  plan: ExplicitRunOncePlan,
  envelope: CodexPermissionEnvelope = permissionEnvelopeForPlan(plan),
): string {
  const fileAccess = envelope.capabilities.includes('workspace-write')
    ? `只允许写入 ${envelope.dedicatedCwd}`
    : '只读，不允许写入工作区'
  const network = envelope.networkAccess ? '允许网络访问' : '不允许网络访问'
  return [
    '浮域（Flowit Workflow）准备创建一个新的专用 Codex Session。',
    `任务：${plan.input.name}`,
    `目标：${plan.input.goal}`,
    `工作目录：${envelope.dedicatedCwd}`,
    `文件权限：${fileAccess}`,
    `网络权限：${network}`,
    `节点数量：${plan.input.steps.length}`,
    `Skills：${plan.input.target.skills.length ? plan.input.target.skills.join(', ') : '无'}`,
    '审批策略：运行开始后不再自动升级权限；超出上述范围的操作将失败。',
  ].join('\n')
}

function assertPlanIdentity(
  payload: ExecutionGrantPayload,
  plan: ExplicitRunOncePlan,
): void {
  if (payload.requestKey !== plan.requestKey) {
    throw permissionError('Flowit execution grant request key changed')
  }
  if (payload.inputDigest !== plan.inputDigest) {
    throw permissionError(
      `explicit run-once requestId ${JSON.stringify(plan.input.requestId)} is already bound to different permission input`,
    )
  }
  if (
    payload.definitionId !== plan.definitionId ||
    payload.triggerKey !== plan.triggerKey ||
    canonicalJson(payload.envelope) !== canonicalJson(permissionEnvelopeForPlan(plan))
  ) {
    throw permissionError(
      'Flowit execution grant differs from the normalized run-once request',
    )
  }
}

function evidence(
  payload: ExecutionGrantPayload,
  token: string,
): CodexPermissionEvidence {
  const envelope = payload.envelope
  return {
    requestedCapabilities: [...envelope.capabilities],
    grantedCapabilities: [...envelope.capabilities],
    source: payload.source,
    scope: 'run',
    sandboxMode: envelope.sandboxMode,
    sandboxPolicy: structuredClone(envelope.sandboxPolicy),
    approvalPolicy: 'never',
    networkAccess: envelope.sandboxPolicy.networkAccess,
    writableRoots: envelope.sandboxPolicy.type === 'workspaceWrite'
      ? [...envelope.sandboxPolicy.writableRoots]
      : [],
    grantDigest: createHash('sha256').update(token, 'utf8').digest('hex'),
    verified: true,
  }
}

function normalizeCapabilities(
  input: readonly AgentExecutionCapability[],
): AgentExecutionCapability[] {
  const result = new Set<AgentExecutionCapability>()
  for (const capability of input) {
    if (!ALLOWED_CAPABILITIES.has(capability)) {
      throw permissionError(
        `explicit Codex permission grants do not support capability ${String(capability)}`,
      )
    }
    result.add(capability)
  }
  if (result.has('workspace-write') || result.has('network')) {
    result.add('workspace-read')
  }
  return [...result].sort()
}

function permissionScopeFromCorrelation(correlationId: string): {
  requestKey: string
  inputDigest: string
} {
  const normalized = correlationId.trim()
  const preflight = /^explicit-preflight:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(normalized)
  if (preflight) {
    return { requestKey: preflight[1]!, inputDigest: preflight[2]! }
  }
  const run = /^(?:dispatch-preflight:)?run-once:explicit-run-once:([a-f0-9]{64}):explicit:([a-f0-9]{64}):[A-Za-z0-9._-]+$/.exec(normalized)
  if (run) return { requestKey: run[1]!, inputDigest: run[2]! }
  throw permissionError(
    'Flowit execution permission grants are valid only for their explicit run-once correlation',
  )
}

function signToken(key: Buffer, payload: ExecutionGrantPayload): string {
  const encoded = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifyToken(key: Buffer, token: string): ExecutionGrantPayload {
  const [encoded, suppliedSignature, extra] = token.split('.')
  if (!encoded || !suppliedSignature || extra !== undefined) {
    throw permissionError('Flowit execution permission grant has an invalid envelope')
  }
  const expected = createHmac('sha256', key).update(encoded).digest()
  const supplied = Buffer.from(suppliedSignature, 'base64url')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw permissionError('Flowit execution permission grant signature verification failed')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw permissionError('Flowit execution permission grant payload is malformed')
  }
  if (
    !isRecord(value) ||
    value.kind !== 'flowit-execution-permission-grant' ||
    value.version !== GRANT_VERSION ||
    typeof value.requestId !== 'string' ||
    typeof value.requestKey !== 'string' ||
    typeof value.inputDigest !== 'string' ||
    typeof value.definitionId !== 'string' ||
    typeof value.triggerKey !== 'string' ||
    !isRecord(value.envelope) ||
    (value.source !== 'mcp-elicitation' && value.source !== 'bounded-readonly-default') ||
    typeof value.issuedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof value.nonce !== 'string'
  ) {
    throw permissionError('Flowit execution permission grant payload is invalid')
  }
  const envelope = parseEnvelope(value.envelope)
  return {
    kind: 'flowit-execution-permission-grant',
    version: GRANT_VERSION,
    requestId: value.requestId,
    requestKey: requiredHash(value.requestKey, 'requestKey'),
    inputDigest: requiredHash(value.inputDigest, 'inputDigest'),
    definitionId: value.definitionId,
    triggerKey: value.triggerKey,
    envelope,
    source: value.source,
    issuedAt: requiredTimestamp(value.issuedAt, 'issuedAt'),
    expiresAt: requiredTimestamp(value.expiresAt, 'expiresAt'),
    nonce: value.nonce,
  }
}

function parseEnvelope(value: Record<string, unknown>): CodexPermissionEnvelope {
  if (
    value.adapterId !== 'codex' ||
    (value.sandboxMode !== 'read-only' && value.sandboxMode !== 'workspace-write') ||
    value.approvalPolicy !== 'never' ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.some(item => typeof item !== 'string') ||
    typeof value.dedicatedCwd !== 'string' ||
    !isRecord(value.sandboxPolicy)
  ) {
    throw permissionError('Flowit Codex permission envelope is invalid')
  }
  const capabilities = normalizeCapabilities(
    value.capabilities as AgentExecutionCapability[],
  )
  const dedicatedCwd = path.resolve(value.dedicatedCwd)
  const policy = value.sandboxPolicy
  let sandboxPolicy: CodexSandboxPolicy
  if (policy.type === 'readOnly' && typeof policy.networkAccess === 'boolean') {
    sandboxPolicy = { type: 'readOnly', networkAccess: policy.networkAccess }
  } else if (
    policy.type === 'workspaceWrite' &&
    Array.isArray(policy.writableRoots) &&
    policy.writableRoots.every(item => typeof item === 'string') &&
    typeof policy.networkAccess === 'boolean' &&
    policy.excludeTmpdirEnvVar === true &&
    policy.excludeSlashTmp === true
  ) {
    sandboxPolicy = {
      type: 'workspaceWrite',
      writableRoots: policy.writableRoots.map(item => path.resolve(String(item))),
      networkAccess: policy.networkAccess,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    }
  } else {
    throw permissionError('Flowit Codex sandbox policy is invalid')
  }
  const expectedMode = sandboxPolicy.type === 'workspaceWrite'
    ? 'workspace-write'
    : 'read-only'
  if (value.sandboxMode !== expectedMode) {
    throw permissionError('Flowit Codex sandbox mode differs from its policy')
  }
  if (
    sandboxPolicy.type === 'workspaceWrite' &&
    canonicalJson(sandboxPolicy.writableRoots) !== canonicalJson([dedicatedCwd])
  ) {
    throw permissionError('Flowit Codex writable roots exceed the dedicated workspace')
  }
  return {
    adapterId: 'codex',
    sandboxMode: value.sandboxMode,
    sandboxPolicy,
    approvalPolicy: 'never',
    capabilities,
    dedicatedCwd,
  }
}

function assertNotExpired(expiresAt: string, now: Date): void {
  if (Date.parse(expiresAt) <= now.getTime()) {
    throw permissionError('Flowit execution permission grant expired; approve the run again')
  }
}

function normalizeSecret(value: string | Buffer): Buffer {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8')
  if (key.length < 32) {
    throw new Error('execution permission secret must contain at least 32 bytes')
  }
  return key
}

function requiredHash(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw permissionError(`${name} must be a lowercase SHA-256 digest`)
  }
  return value
}

function requiredTimestamp(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw permissionError(`${name} must be a valid timestamp`)
  }
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function permissionError(message: string): Error & { code: 'PERMISSION_UNAVAILABLE' } {
  return Object.assign(new Error(message), { code: 'PERMISSION_UNAVAILABLE' as const })
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
