import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import {
  canonicalJson,
  confirmationCodeForProposalHash,
} from './canonical.js'
import {
  readOrCreateAuthoritySecret,
  routingAuthorityPaths,
  RoutingAuthorityStateStore,
} from './authority-state.js'
export { routingAuthorityPaths } from './authority-state.js'

import { assessTask, ADAPTIVE_ROUTING_POLICY_VERSION } from './policy.js'
import type {
  RoutingAuthorityContext,
  RoutingCallerContext,
  RoutingConfirmationChoice,
  RoutingExplicitIntent,
  RoutingMode,
  RoutingWorkflowToolName,
  SignedTaskAssessment,
  TaskAssessmentRequest,
  TaskAssessmentResult,
} from './types.js'

const DEFAULT_ASSESSMENT_TTL_MS = 10 * 60 * 1_000
const DEFAULT_HOST_AUTHORITY_TTL_MS = 5 * 60 * 1_000
const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1_000
const DEFAULT_CALLER_ATTESTATION_TTL_MS = 30_000

interface HostAuthorityPayload {
  readonly kind: 'routing-authority'
  readonly version: 1
  readonly taskDigest: string
  readonly explicitIntent: RoutingExplicitIntent
  readonly authorityContext: RoutingAuthorityContext
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

interface ProposalConfirmationPayload {
  readonly kind: 'routing-confirmation'
  readonly version: 1
  readonly proposalHash: string
  readonly choice: RoutingConfirmationChoice
  readonly authorityContext: RoutingAuthorityContext
  readonly challengeNonce: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly nonce: string
}

interface CallerAttestationPayload {
  readonly kind: 'routing-caller-attestation'
  readonly version: 1
  readonly toolName: RoutingWorkflowToolName
  readonly inputDigest: string
  readonly callerContext: RoutingCallerContext
  readonly issuedAt: string
  readonly expiresAt: string
  readonly nonce: string
}

export interface RoutingAuthorityOptions {
  readonly mode: RoutingMode
  readonly secret?: string | Buffer
  readonly stateFile?: string
  readonly assessmentTtlMs?: number
  readonly requireCallerAttestation?: boolean
  readonly now?: () => Date
}

export interface IssueRoutingAuthorityInput {
  readonly task: string
  readonly explicitIntent: RoutingExplicitIntent
  readonly hostId: string
  readonly hostSessionId: string
  readonly turnNonce?: string
  readonly ttlMs?: number
}

export interface IssueCallerAttestationInput {
  readonly hostId: string
  readonly hostSessionId: string
  readonly toolUseId: string
  readonly toolName: RoutingWorkflowToolName
  readonly toolInput: Readonly<Record<string, unknown>>
  readonly ttlMs?: number
}

export interface ConsumeCallerAttestationInput {
  readonly toolName: RoutingWorkflowToolName
  readonly toolInput: Readonly<Record<string, unknown>>
}

export interface RegisterProposalConfirmationInput {
  readonly proposalHash: string
  readonly confirmationCode: string
  readonly expiresAt: string
  readonly authorityContext: RoutingAuthorityContext
}

export interface VerifyProposalConfirmationInput {
  readonly proposalHash: string
  readonly authorityContext: RoutingAuthorityContext
}

export interface ConsumeAuthorityContextInput {
  readonly hostId: string
  readonly hostSessionId: string
  readonly turnNonce?: string
}

export type ProposalConfirmationResult =
  | {
      readonly kind: 'confirmed'
      readonly proposalHash: string
      readonly confirmationToken: string
    }
  | { readonly kind: 'cancelled'; readonly proposalHash: string }

export type RoutingChoiceResult = {
  readonly task: string
  readonly explicitIntent: Exclude<RoutingExplicitIntent, 'unspecified'>
  readonly authorityToken: string
}

export class RoutingAuthorityService {
  readonly mode: RoutingMode
  private readonly key: Buffer
  private readonly state: RoutingAuthorityStateStore
  private readonly assessmentTtlMs: number
  private readonly requireCallerAttestation: boolean
  private readonly now: () => Date

  constructor(options: RoutingAuthorityOptions) {
    this.mode = routingMode(options.mode)
    this.key = options.secret === undefined
      ? randomBytes(32)
      : normalizeSecret(options.secret)
    this.now = options.now ?? (() => new Date())
    this.state = new RoutingAuthorityStateStore(options.stateFile, this.now)
    this.assessmentTtlMs = integerAtLeast(
      options.assessmentTtlMs ?? DEFAULT_ASSESSMENT_TTL_MS,
      1_000,
      'assessmentTtlMs',
    )
    this.requireCallerAttestation = options.requireCallerAttestation ?? false
  }

  assess(
    input: TaskAssessmentRequest,
    callerContext?: RoutingCallerContext,
  ): SignedTaskAssessment {
    const task = requiredString(input.task, 'task')
    const authority = input.authorityToken
      ? this.verifyHostAuthority(input.authorityToken, task, callerContext)
      : undefined
    const base = assessTask({
      task,
      mode: this.mode,
      explicitIntent: authority?.explicitIntent ?? 'unspecified',
      trustedAuthority: Boolean(authority),
      ...(input.signals ? { signals: input.signals } : {}),
    })
    const assessment: TaskAssessmentResult = authority
      ? { ...base, authorityContext: structuredClone(authority.authorityContext) }
      : base
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
    const signed: SignedTaskAssessment = {
      ...assessment,
      expiresAt,
      assessmentToken: signPayload(this.key, payload),
    }
    if (signed.authorityContext && signed.decision === 'ask') {
      this.state.putRoutingChoice({
        task: signed.task,
        expiresAt: signed.expiresAt,
        authorityContext: signed.authorityContext,
      })
    } else if (signed.authorityContext) {
      this.state.clearRoutingChoice(signed.authorityContext)
    }
    return signed
  }

  verifyAssessmentToken(
    token: string,
    callerContext?: RoutingCallerContext,
  ): SignedTaskAssessment {
    const payload = verifySignedPayload(this.key, token)
    if (
      !isRecord(payload) ||
      payload.kind !== 'routing-assessment' ||
      payload.version !== 1 ||
      !isRecord(payload.assessment) ||
      payload.assessment.kind !== 'task-assessment' ||
      payload.assessment.policyVersion !== ADAPTIVE_ROUTING_POLICY_VERSION ||
      typeof payload.expiresAt !== 'string'
    ) {
      throw new Error('invalid adaptive routing assessment token')
    }
    assertNotExpired(payload.expiresAt, this.now(), 'adaptive routing assessment token')
    const assessment = payload.assessment as unknown as TaskAssessmentResult
    if (assessment.authorityContext) {
      const expected = validateAuthorityContext(assessment.authorityContext)
      this.assertCallerMatches(expected, callerContext, 'adaptive routing assessment')
    }
    return {
      ...structuredClone(assessment),
      expiresAt: requiredTimestamp(payload.expiresAt, 'expiresAt'),
      assessmentToken: token,
    }
  }

  issueHostAuthority(input: IssueRoutingAuthorityInput): string {
    return issueRoutingAuthorityToken(this.key, input, this.now())
  }

  issueCallerAttestation(input: IssueCallerAttestationInput): string {
    const toolName = routingWorkflowToolName(input.toolName)
    const toolUseId = requiredString(input.toolUseId, 'toolUseId')
    const callerContext: RoutingCallerContext = {
      hostId: requiredString(input.hostId, 'hostId'),
      hostSessionId: requiredString(input.hostSessionId, 'hostSessionId'),
      toolUseId,
    }
    const ttlMs = integerAtLeast(
      input.ttlMs ?? DEFAULT_CALLER_ATTESTATION_TTL_MS,
      1_000,
      'ttlMs',
    )
    const now = this.now()
    const nonce = randomBytes(16).toString('hex')
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
    const inputDigest = toolInputDigest(input.toolInput)
    const payload: CallerAttestationPayload = {
      kind: 'routing-caller-attestation',
      version: 1,
      toolName,
      inputDigest,
      callerContext,
      issuedAt: now.toISOString(),
      expiresAt,
      nonce,
    }
    this.state.putCallerAttestation({
      nonce,
      toolName,
      inputDigest,
      expiresAt,
      callerContext,
    })
    return signPayload(this.key, payload)
  }

  consumeCallerAttestation(
    token: string,
    input: ConsumeCallerAttestationInput,
  ): RoutingCallerContext {
    const payload = verifySignedPayload(this.key, token)
    if (
      !isRecord(payload) ||
      payload.kind !== 'routing-caller-attestation' ||
      payload.version !== 1 ||
      typeof payload.toolName !== 'string' ||
      typeof payload.inputDigest !== 'string' ||
      typeof payload.issuedAt !== 'string' ||
      typeof payload.expiresAt !== 'string' ||
      typeof payload.nonce !== 'string' ||
      !isRecord(payload.callerContext)
    ) {
      throw new Error('invalid adaptive routing caller attestation')
    }
    const toolName = routingWorkflowToolName(payload.toolName)
    const expectedToolName = routingWorkflowToolName(input.toolName)
    if (toolName !== expectedToolName) {
      throw new Error('adaptive routing caller attestation belongs to a different tool')
    }
    const inputDigest = requiredHash(payload.inputDigest, 'inputDigest')
    if (inputDigest !== toolInputDigest(input.toolInput)) {
      throw new Error('adaptive routing caller attestation does not match the exact tool input')
    }
    requiredTimestamp(payload.issuedAt, 'issuedAt')
    assertNotExpired(
      payload.expiresAt,
      this.now(),
      'adaptive routing caller attestation',
    )
    const nonce = requiredString(payload.nonce, 'nonce')
    const callerContext = validateCallerContext(payload.callerContext)
    const stored = this.state.takeCallerAttestation(nonce)
    if (!stored) {
      throw new Error('adaptive routing caller attestation is unknown, expired, or already used')
    }
    const expectedStored = {
      nonce,
      toolName,
      inputDigest,
      expiresAt: requiredTimestamp(payload.expiresAt, 'expiresAt'),
      callerContext,
    }
    if (canonicalJson(stored) !== canonicalJson(expectedStored)) {
      throw new Error('adaptive routing caller attestation state does not match its signature')
    }
    return callerContext
  }

  consumeRoutingChoice(
    input: ConsumeAuthorityContextInput,
    explicitIntent: Exclude<RoutingExplicitIntent, 'unspecified'>,
  ): RoutingChoiceResult | undefined {
    const context = authorityContext(input)
    const pending = this.state.takeRoutingChoice(context)
    if (!pending) return undefined
    assertNotExpired(pending.expiresAt, this.now(), 'adaptive routing choice')
    return {
      task: pending.task,
      explicitIntent,
      authorityToken: issueRoutingAuthorityToken(
        this.key,
        {
          task: pending.task,
          explicitIntent,
          hostId: context.hostId,
          hostSessionId: context.hostSessionId,
          turnNonce: context.turnNonce,
          ttlMs: Math.max(1_000, Date.parse(pending.expiresAt) - this.now().getTime()),
        },
        this.now(),
      ),
    }
  }

  registerProposalConfirmation(input: RegisterProposalConfirmationInput): string {
    const proposalHash = requiredHash(input.proposalHash, 'proposalHash')
    const confirmationCode = requiredConfirmationCode(input.confirmationCode)
    const expectedCode = confirmationCodeForProposalHash(proposalHash)
    if (confirmationCode !== expectedCode) {
      throw new Error('adaptive Workflow confirmation code does not match proposalHash')
    }
    const expiresAt = requiredTimestamp(input.expiresAt, 'expiresAt')
    const context = validateAuthorityContext(input.authorityContext)
    assertNotExpired(expiresAt, this.now(), 'adaptive Workflow proposal')
    this.state.putProposalConfirmation({
      proposalHash,
      confirmationCode,
      expiresAt,
      authorityContext: context,
      challengeNonce: randomBytes(16).toString('hex'),
    })
    return confirmationCode
  }

  consumeProposalConfirmation(
    input: ConsumeAuthorityContextInput,
    choice: 'confirm' | 'cancel',
    confirmationCode: string,
  ): ProposalConfirmationResult | undefined {
    const context = authorityContext(input)
    const code = requiredConfirmationCode(confirmationCode)
    const pending = this.state.takeProposalConfirmation(context, code)
    if (!pending) return undefined
    assertNotExpired(pending.expiresAt, this.now(), 'adaptive Workflow proposal')
    if (pending.confirmationCode !== code) {
      throw new Error('adaptive Workflow confirmation code changed after preparation')
    }
    if (choice === 'cancel') {
      return { kind: 'cancelled', proposalHash: pending.proposalHash }
    }
    return {
      kind: 'confirmed',
      proposalHash: pending.proposalHash,
      confirmationToken: issueProposalConfirmationToken(
        this.key,
        {
          proposalHash: pending.proposalHash,
          authorityContext: pending.authorityContext,
          challengeNonce: pending.challengeNonce,
          expiresAt: pending.expiresAt,
        },
        this.now(),
      ),
    }
  }

  abandonPending(input: ConsumeAuthorityContextInput): void {
    this.state.clearAll(authorityContext(input))
  }

  verifyProposalConfirmation(
    token: string,
    input: VerifyProposalConfirmationInput,
    callerContext?: RoutingCallerContext,
  ): void {
    const payload = verifySignedPayload(this.key, token)
    if (
      !isRecord(payload) ||
      payload.kind !== 'routing-confirmation' ||
      payload.version !== 1 ||
      payload.choice !== 'pipeline' ||
      typeof payload.proposalHash !== 'string' ||
      typeof payload.challengeNonce !== 'string' ||
      typeof payload.issuedAt !== 'string' ||
      typeof payload.expiresAt !== 'string' ||
      typeof payload.nonce !== 'string' ||
      !isRecord(payload.authorityContext)
    ) {
      throw new Error('invalid adaptive routing confirmation token')
    }
    requiredTimestamp(payload.issuedAt, 'issuedAt')
    assertNotExpired(payload.expiresAt, this.now(), 'adaptive routing confirmation token')
    if (payload.proposalHash !== requiredHash(input.proposalHash, 'proposalHash')) {
      throw new Error('adaptive routing confirmation token does not match the reviewed proposal')
    }
    const actualContext = validateAuthorityContext(payload.authorityContext)
    const expectedContext = validateAuthorityContext(input.authorityContext)
    if (canonicalJson(actualContext) !== canonicalJson(expectedContext)) {
      throw new Error('adaptive routing confirmation token belongs to a different Host turn')
    }
    this.assertCallerMatches(
      expectedContext,
      callerContext,
      'adaptive routing confirmation token',
    )
  }

  private verifyHostAuthority(
    token: string,
    task: string,
    callerContext?: RoutingCallerContext,
  ): HostAuthorityPayload {
    const payload = verifySignedPayload(this.key, token)
    if (
      !isRecord(payload) ||
      payload.kind !== 'routing-authority' ||
      payload.version !== 1 ||
      typeof payload.taskDigest !== 'string' ||
      !isRoutingExplicitIntent(payload.explicitIntent) ||
      typeof payload.issuedAt !== 'string' ||
      typeof payload.expiresAt !== 'string' ||
      typeof payload.nonce !== 'string' ||
      !isRecord(payload.authorityContext)
    ) {
      throw new Error('invalid trusted routing authority token')
    }
    assertNotExpired(payload.expiresAt, this.now(), 'trusted routing authority token')
    if (payload.taskDigest !== taskDigest(task)) {
      throw new Error('trusted routing authority token does not match the current top-level task')
    }
    const authorityContextValue = validateAuthorityContext(payload.authorityContext)
    this.assertCallerMatches(
      authorityContextValue,
      callerContext,
      'trusted routing authority token',
    )
    return {
      kind: 'routing-authority',
      version: 1,
      taskDigest: payload.taskDigest,
      explicitIntent: payload.explicitIntent,
      authorityContext: authorityContextValue,
      issuedAt: requiredTimestamp(payload.issuedAt, 'issuedAt'),
      expiresAt: requiredTimestamp(payload.expiresAt, 'expiresAt'),
      nonce: requiredString(payload.nonce, 'nonce'),
    }
  }

  private assertCallerMatches(
    expected: RoutingAuthorityContext,
    callerContext: RoutingCallerContext | undefined,
    name: string,
  ): void {
    if (!callerContext) {
      if (this.requireCallerAttestation) {
        throw new Error(`${name} requires a Host-issued current caller attestation`)
      }
      return
    }
    const caller = validateCallerContext(callerContext)
    if (
      caller.hostId !== expected.hostId ||
      caller.hostSessionId !== expected.hostSessionId
    ) {
      throw new Error(`${name} belongs to a different Host Session`)
    }
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
    authorityContext: authorityContext(input),
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
  const paths = routingAuthorityPaths(env)
  const explicitSecret = env.FLOWIT_WORKFLOW_ROUTING_AUTHORITY_SECRET?.trim()
  const secret = explicitSecret || readOrCreateAuthoritySecret(paths.secretFile)
  return new RoutingAuthorityService({
    mode,
    secret,
    stateFile: paths.stateFile,
    requireCallerAttestation:
      env.FLOWIT_WORKFLOW_ROUTING_REQUIRE_CALLER_ATTESTATION?.trim() !== '0',
  })
}

function issueProposalConfirmationToken(
  secret: string | Buffer,
  input: {
    proposalHash: string
    authorityContext: RoutingAuthorityContext
    challengeNonce: string
    expiresAt: string
  },
  now: Date,
): string {
  const requestedExpiry = Date.parse(requiredTimestamp(input.expiresAt, 'expiresAt'))
  const payload: ProposalConfirmationPayload = {
    kind: 'routing-confirmation',
    version: 1,
    proposalHash: requiredHash(input.proposalHash, 'proposalHash'),
    choice: 'pipeline',
    authorityContext: validateAuthorityContext(input.authorityContext),
    challengeNonce: requiredString(input.challengeNonce, 'challengeNonce'),
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      Math.min(requestedExpiry, now.getTime() + DEFAULT_CONFIRMATION_TTL_MS),
    ).toISOString(),
    nonce: randomBytes(16).toString('hex'),
  }
  return signPayload(normalizeSecret(secret), payload)
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
  const expected = createHmac('sha256', key).update(encoded).digest()
  const supplied = Buffer.from(suppliedSignature, 'base64url')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('routing token signature verification failed')
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('routing token payload is malformed')
  }
}

function toolInputDigest(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function taskDigest(task: string): string {
  return createHash('sha256').update(task, 'utf8').digest('hex')
}

function authorityContext(input: ConsumeAuthorityContextInput): RoutingAuthorityContext {
  return {
    hostId: requiredString(input.hostId, 'hostId'),
    hostSessionId: requiredString(input.hostSessionId, 'hostSessionId'),
    turnNonce: optionalString(input.turnNonce) ?? randomBytes(16).toString('hex'),
  }
}

function validateAuthorityContext(value: unknown): RoutingAuthorityContext {
  if (!isRecord(value)) throw new Error('routing authority context must be an object')
  return {
    hostId: requiredString(value.hostId, 'authorityContext.hostId'),
    hostSessionId: requiredString(value.hostSessionId, 'authorityContext.hostSessionId'),
    turnNonce: requiredString(value.turnNonce, 'authorityContext.turnNonce'),
  }
}

function validateCallerContext(value: unknown): RoutingCallerContext {
  if (!isRecord(value)) throw new Error('routing caller context must be an object')
  return {
    hostId: requiredString(value.hostId, 'callerContext.hostId'),
    hostSessionId: requiredString(value.hostSessionId, 'callerContext.hostSessionId'),
    toolUseId: requiredString(value.toolUseId, 'callerContext.toolUseId'),
  }
}

function assertNotExpired(expiresAt: string, now: Date, name: string): void {
  const expiry = Date.parse(requiredTimestamp(expiresAt, 'expiresAt'))
  if (expiry <= now.getTime()) {
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
  if (!isRoutingExplicitIntent(value)) throw new Error('explicit routing intent is invalid')
  return value
}

function isRoutingExplicitIntent(value: unknown): value is RoutingExplicitIntent {
  return value === 'unspecified' ||
    value === 'force-flowit' ||
    value === 'force-direct' ||
    value === 'preview'
}

function routingWorkflowToolName(value: unknown): RoutingWorkflowToolName {
  if (
    value !== 'workflow_assess' &&
    value !== 'workflow_prepare' &&
    value !== 'workflow_commit'
  ) {
    throw new Error('adaptive routing caller attestation tool is invalid')
  }
  return value
}

function requiredConfirmationCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-F0-9]{12}$/.test(value)) {
    throw new Error('confirmationCode must contain exactly 12 uppercase hexadecimal characters')
  }
  return value
}

function requiredHash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hex digest`)
  }
  return value
}

function requiredTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid ISO timestamp`)
  }
  return value
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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
