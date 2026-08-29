import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { canonicalJson } from './canonical.js'
import { assessTask, ADAPTIVE_ROUTING_POLICY_VERSION } from './policy.js'
import type {
  RoutingExplicitIntent,
  RoutingMode,
  SignedTaskAssessment,
  TaskAssessmentRequest,
  TaskAssessmentResult,
} from './types.js'

const DEFAULT_ASSESSMENT_TTL_MS = 10 * 60 * 1_000
const DEFAULT_HOST_AUTHORITY_TTL_MS = 5 * 60 * 1_000

interface HostAuthorityPayload {
  readonly kind: 'routing-authority'
  readonly version: 1
  readonly taskDigest: string
  readonly explicitIntent: RoutingExplicitIntent
  readonly issuedAt: string
  readonly expiresAt: string
  readonly nonce: string
}

interface AssessmentTokenPayload {
  readonly kind: 'routing-assessment'
  readonly version: 1
  readonly assessment: TaskAssessmentResult
  readonly expiresAt: string
}

export interface RoutingAuthorityOptions {
  readonly mode: RoutingMode
  readonly secret?: string | Buffer
  readonly assessmentTtlMs?: number
  readonly now?: () => Date
}

export interface IssueRoutingAuthorityInput {
  readonly task: string
  readonly explicitIntent: RoutingExplicitIntent
  readonly ttlMs?: number
}

export class RoutingAuthorityService {
  readonly mode: RoutingMode
  private readonly key: Buffer
  private readonly assessmentTtlMs: number
  private readonly now: () => Date

  constructor(options: RoutingAuthorityOptions) {
    this.mode = routingMode(options.mode)
    this.key = options.secret === undefined
      ? randomBytes(32)
      : normalizeSecret(options.secret)
    this.assessmentTtlMs = integerAtLeast(
      options.assessmentTtlMs ?? DEFAULT_ASSESSMENT_TTL_MS,
      1_000,
      'assessmentTtlMs',
    )
    this.now = options.now ?? (() => new Date())
  }

  assess(input: TaskAssessmentRequest): SignedTaskAssessment {
    const task = requiredString(input.task, 'task')
    const authority = input.authorityToken
      ? this.verifyHostAuthority(input.authorityToken, task)
      : undefined
    const assessment = assessTask({
      task,
      mode: this.mode,
      explicitIntent: authority?.explicitIntent ?? 'unspecified',
      trustedAuthority: Boolean(authority),
      ...(input.signals ? { signals: input.signals } : {}),
    })
    const now = this.now()
    const localExpiry = new Date(now.getTime() + this.assessmentTtlMs)
    const authorityExpiry = authority ? new Date(authority.expiresAt) : undefined
    const expiresAt = authorityExpiry && authorityExpiry.getTime() < localExpiry.getTime()
      ? authorityExpiry.toISOString()
      : localExpiry.toISOString()
    const payload: AssessmentTokenPayload = {
      kind: 'routing-assessment',
      version: 1,
      assessment,
      expiresAt,
    }
    return {
      ...assessment,
      expiresAt,
      assessmentToken: signPayload(this.key, payload),
    }
  }

  verifyAssessmentToken(token: string): SignedTaskAssessment {
    const payload = verifySignedPayload(this.key, token)
    if (
      !isRecord(payload) ||
      payload.kind !== 'routing-assessment' ||
      payload.version !== 1 ||
      !isRecord(payload.assessment) ||
      payload.assessment.kind !== 'task-assessment' ||
      payload.assessment.policyVersion !== ADAPTIVE_ROUTING_POLICY_VERSION ||
      typeof payload.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(payload.expiresAt))
    ) {
      throw new Error('invalid adaptive routing assessment token')
    }
    assertNotExpired(payload.expiresAt, this.now(), 'adaptive routing assessment token')
    return {
      ...(payload.assessment as unknown as TaskAssessmentResult),
      expiresAt: payload.expiresAt,
      assessmentToken: token,
    }
  }

  issueHostAuthority(input: IssueRoutingAuthorityInput): string {
    return issueRoutingAuthorityToken(this.key, input, this.now())
  }

  private verifyHostAuthority(token: string, task: string): HostAuthorityPayload {
    const payload = verifySignedPayload(this.key, token)
    if (
      !isRecord(payload) ||
      payload.kind !== 'routing-authority' ||
      payload.version !== 1 ||
      typeof payload.taskDigest !== 'string' ||
      typeof payload.explicitIntent !== 'string' ||
      !isRoutingExplicitIntent(payload.explicitIntent) ||
      typeof payload.issuedAt !== 'string' ||
      typeof payload.expiresAt !== 'string' ||
      typeof payload.nonce !== 'string'
    ) {
      throw new Error('invalid trusted routing authority token')
    }
    assertNotExpired(payload.expiresAt, this.now(), 'trusted routing authority token')
    if (payload.taskDigest !== taskDigest(task)) {
      throw new Error('trusted routing authority token does not match the current top-level task')
    }
    return payload as unknown as HostAuthorityPayload
  }
}

export function issueRoutingAuthorityToken(
  secret: string | Buffer,
  input: IssueRoutingAuthorityInput,
  now = new Date(),
): string {
  const key = normalizeSecret(secret)
  const task = requiredString(input.task, 'task')
  const explicitIntent = routingExplicitIntent(input.explicitIntent)
  const ttlMs = integerAtLeast(
    input.ttlMs ?? DEFAULT_HOST_AUTHORITY_TTL_MS,
    1_000,
    'ttlMs',
  )
  const payload: HostAuthorityPayload = {
    kind: 'routing-authority',
    version: 1,
    taskDigest: taskDigest(task),
    explicitIntent,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    nonce: randomBytes(16).toString('hex'),
  }
  return signPayload(key, payload)
}

export function createRoutingAuthorityFromEnvironment(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): RoutingAuthorityService {
  const mode = routingMode(env.FLOWIT_WORKFLOW_ROUTING_MODE?.trim() || 'suggest')
  const secret = env.FLOWIT_WORKFLOW_ROUTING_AUTHORITY_SECRET?.trim()
  return new RoutingAuthorityService({
    mode,
    ...(secret ? { secret } : {}),
  })
}

function signPayload(key: Buffer, payload: unknown): string {
  const encoded = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifySignedPayload(key: Buffer, token: string): unknown {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('routing token must be a non-empty string')
  }
  const [encoded, suppliedSignature, extra] = token.split('.')
  if (!encoded || !suppliedSignature || extra !== undefined) {
    throw new Error('routing token has an invalid envelope')
  }
  const expectedSignature = createHmac('sha256', key).update(encoded).digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(suppliedSignature, 'base64url')
  } catch {
    throw new Error('routing token signature is malformed')
  }
  if (
    supplied.length !== expectedSignature.length ||
    !timingSafeEqual(supplied, expectedSignature)
  ) {
    throw new Error('routing token signature verification failed')
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('routing token payload is malformed')
  }
}

function taskDigest(task: string): string {
  return createHash('sha256').update(task, 'utf8').digest('hex')
}

function assertNotExpired(expiresAt: string, now: Date, name: string): void {
  const expiry = Date.parse(expiresAt)
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    throw new Error(`${name} expired; reassess the current task before continuing`)
  }
}

function normalizeSecret(value: string | Buffer): Buffer {
  const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8')
  if (buffer.length < 32) {
    throw new Error('routing authority secret must contain at least 32 bytes')
  }
  return buffer
}

function routingMode(value: unknown): RoutingMode {
  if (value !== 'manual' && value !== 'suggest' && value !== 'auto-safe') {
    throw new Error('routing mode must be manual, suggest, or auto-safe')
  }
  return value
}

function routingExplicitIntent(value: unknown): RoutingExplicitIntent {
  if (!isRoutingExplicitIntent(value)) {
    throw new Error('explicit routing intent is invalid')
  }
  return value
}

function isRoutingExplicitIntent(value: unknown): value is RoutingExplicitIntent {
  return value === 'unspecified' ||
    value === 'force-flowit' ||
    value === 'force-direct' ||
    value === 'preview'
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function integerAtLeast(value: number, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
