import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  RoutingAuthorityContext,
  RoutingCallerContext,
  RoutingWorkflowToolName,
} from './types.js'

const STATE_VERSION = 1 as const
const LOCK_TIMEOUT_MS = 1_000
const STALE_LOCK_MS = 30_000

export interface PendingRoutingChoice {
  readonly task: string
  readonly expiresAt: string
  readonly authorityContext: RoutingAuthorityContext
}

export interface PendingProposalConfirmation {
  readonly proposalHash: string
  readonly confirmationCode: string
  readonly expiresAt: string
  readonly authorityContext: RoutingAuthorityContext
  readonly challengeNonce: string
}

export interface PendingCallerAttestation {
  readonly nonce: string
  readonly toolName: RoutingWorkflowToolName
  readonly inputDigest: string
  readonly expiresAt: string
  readonly callerContext: RoutingCallerContext
}

interface RoutingAuthorityState {
  version: 1
  routingChoices: Record<string, PendingRoutingChoice>
  proposalConfirmations: Record<string, PendingProposalConfirmation>
  callerAttestations: Record<string, PendingCallerAttestation>
}

export interface RoutingAuthorityPaths {
  readonly directory: string
  readonly secretFile: string
  readonly stateFile: string
}

export class RoutingAuthorityStateStore {
  private readonly memory = emptyState()

  constructor(
    private readonly file: string | undefined,
    private readonly now: () => Date,
  ) {}

  putRoutingChoice(value: PendingRoutingChoice): void {
    this.mutate(state => {
      state.routingChoices[sessionStateKey(value.authorityContext)] = structuredClone(value)
    })
  }

  takeRoutingChoice(
    context: Pick<RoutingAuthorityContext, 'hostId' | 'hostSessionId'>,
  ): PendingRoutingChoice | undefined {
    return this.mutate(state => {
      const key = sessionStateKey(context)
      const value = state.routingChoices[key]
      delete state.routingChoices[key]
      return value ? structuredClone(value) : undefined
    })
  }

  clearRoutingChoice(
    context: Pick<RoutingAuthorityContext, 'hostId' | 'hostSessionId'>,
  ): void {
    this.mutate(state => {
      delete state.routingChoices[sessionStateKey(context)]
    })
  }

  putProposalConfirmation(value: PendingProposalConfirmation): void {
    this.mutate(state => {
      state.proposalConfirmations[
        proposalStateKey(value.authorityContext, value.proposalHash)
      ] = structuredClone(value)
    })
  }

  takeProposalConfirmation(
    context: Pick<RoutingAuthorityContext, 'hostId' | 'hostSessionId'>,
    confirmationCode: string,
  ): PendingProposalConfirmation | undefined {
    return this.mutate(state => {
      const prefix = `${sessionStateKey(context)}:`
      const matches = Object.entries(state.proposalConfirmations).filter(
        ([key, value]) =>
          key.startsWith(prefix) &&
          value.confirmationCode === confirmationCode,
      )
      if (matches.length > 1) {
        throw new Error(
          'adaptive Workflow confirmation code is ambiguous; prepare a fresh proposal',
        )
      }
      const match = matches[0]
      if (!match) return undefined
      delete state.proposalConfirmations[match[0]]
      return structuredClone(match[1])
    })
  }

  clearProposalConfirmation(
    context: Pick<RoutingAuthorityContext, 'hostId' | 'hostSessionId'>,
    proposalHash?: string,
  ): void {
    this.mutate(state => {
      if (proposalHash) {
        delete state.proposalConfirmations[proposalStateKey(context, proposalHash)]
        return
      }
      const prefix = `${sessionStateKey(context)}:`
      for (const key of Object.keys(state.proposalConfirmations)) {
        if (key.startsWith(prefix)) delete state.proposalConfirmations[key]
      }
    })
  }

  putCallerAttestation(value: PendingCallerAttestation): void {
    this.mutate(state => {
      state.callerAttestations[value.nonce] = structuredClone(value)
    })
  }

  takeCallerAttestation(nonce: string): PendingCallerAttestation | undefined {
    return this.mutate(state => {
      const value = state.callerAttestations[nonce]
      delete state.callerAttestations[nonce]
      return value ? structuredClone(value) : undefined
    })
  }

  clearAll(context: Pick<RoutingAuthorityContext, 'hostId' | 'hostSessionId'>): void {
    this.mutate(state => {
      const sessionKey = sessionStateKey(context)
      delete state.routingChoices[sessionKey]
      const prefix = `${sessionKey}:`
      for (const key of Object.keys(state.proposalConfirmations)) {
        if (key.startsWith(prefix)) delete state.proposalConfirmations[key]
      }
    })
  }

  private mutate<T>(operation: (state: RoutingAuthorityState) => T): T {
    if (!this.file) {
      prune(this.memory, this.now())
      const result = operation(this.memory)
      prune(this.memory, this.now())
      return result
    }
    return withFileState(this.file, this.now(), operation)
  }
}

export function routingAuthorityPaths(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): RoutingAuthorityPaths {
  const directory = path.resolve(
    env.FLOWIT_WORKFLOW_ROUTING_AUTHORITY_DIR?.trim() ||
      path.join(os.homedir(), '.flowit-workflow', 'claude', 'routing-authority'),
  )
  return {
    directory,
    secretFile: path.resolve(
      env.FLOWIT_WORKFLOW_ROUTING_AUTHORITY_SECRET_FILE?.trim() ||
        path.join(directory, 'secret.key'),
    ),
    stateFile: path.resolve(
      env.FLOWIT_WORKFLOW_ROUTING_AUTHORITY_STATE_FILE?.trim() ||
        path.join(directory, 'pending.json'),
    ),
  }
}

export function readOrCreateAuthoritySecret(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const existing = readSecret(file)
  if (existing !== undefined) return validateSecret(file, existing)

  const release = acquireLock(`${file}.init.lock`)
  try {
    const afterLock = readSecret(file)
    if (afterLock !== undefined) return validateSecret(file, afterLock)

    const secret = randomBytes(48).toString('base64url')
    const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
    const descriptor = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(descriptor, `${secret}\n`, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, file)
    try { chmodSync(file, 0o600) } catch {}
    fsyncDirectory(path.dirname(file))
    return secret
  } finally {
    release()
  }
}

function readSecret(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function validateSecret(file: string, secret: string): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(`routing authority secret ${file} must contain at least 32 bytes`)
  }
  try { chmodSync(file, 0o600) } catch {}
  return secret
}

function withFileState<T>(
  file: string,
  now: Date,
  operation: (state: RoutingAuthorityState) => T,
): T {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const release = acquireLock(`${file}.lock`)
  try {
    const state = readState(file)
    prune(state, now)
    const result = operation(state)
    prune(state, now)
    durableWrite(file, state)
    return result
  } finally {
    release()
  }
}

function acquireLock(file: string): () => void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const descriptor = openSync(file, 'wx', 0o600)
      writeFileSync(descriptor, `${process.pid}\n${Date.now()}\n`, 'utf8')
      return () => {
        try { closeSync(descriptor) } catch {}
        try { unlinkSync(file) } catch {}
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(file)
          continue
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring routing authority state lock ${file}`)
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
}

function readState(file: string): RoutingAuthorityState {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (
      !isRecord(value) ||
      value.version !== STATE_VERSION ||
      !isRecord(value.routingChoices) ||
      !isRecord(value.proposalConfirmations)
    ) {
      throw new Error('routing authority state has an unsupported shape')
    }
    return {
      version: STATE_VERSION,
      routingChoices: value.routingChoices as Record<string, PendingRoutingChoice>,
      proposalConfirmations:
        value.proposalConfirmations as Record<string, PendingProposalConfirmation>,
      callerAttestations: isRecord(value.callerAttestations)
        ? value.callerAttestations as Record<string, PendingCallerAttestation>
        : {},
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
}

function durableWrite(file: string, state: RoutingAuthorityState): void {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, file)
  try { chmodSync(file, 0o600) } catch {}
  fsyncDirectory(path.dirname(file))
}

function fsyncDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {}
}

function prune(state: RoutingAuthorityState, now: Date): void {
  const nowMs = now.getTime()
  for (const [key, pending] of Object.entries(state.routingChoices)) {
    if (!validFutureTimestamp(pending.expiresAt, nowMs)) {
      delete state.routingChoices[key]
    }
  }
  for (const [key, pending] of Object.entries(state.proposalConfirmations)) {
    if (!validFutureTimestamp(pending.expiresAt, nowMs)) {
      delete state.proposalConfirmations[key]
    }
  }
  for (const [key, pending] of Object.entries(state.callerAttestations)) {
    if (!validFutureTimestamp(pending.expiresAt, nowMs)) {
      delete state.callerAttestations[key]
    }
  }
}

function validFutureTimestamp(value: string, nowMs: number): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > nowMs
}

function emptyState(): RoutingAuthorityState {
  return {
    version: STATE_VERSION,
    routingChoices: {},
    proposalConfirmations: {},
    callerAttestations: {},
  }
}

function proposalStateKey(
  context: Pick<RoutingAuthorityContext, 'hostId' | 'hostSessionId'>,
  proposalHash: string,
): string {
  return `${sessionStateKey(context)}:${proposalHash}`
}

function sessionStateKey(
  context: Pick<RoutingAuthorityContext, 'hostId' | 'hostSessionId'>,
): string {
  return `${encodeURIComponent(context.hostId)}:${encodeURIComponent(context.hostSessionId)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
