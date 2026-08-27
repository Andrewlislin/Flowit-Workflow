import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BridgeStatePaths } from './state.js'

const INITIALIZATION_GRACE_MS = 2_000
const MUTATION_LOCK_TIMEOUT_MS = 10_000
const MUTATION_LOCK_POLL_MS = 25

export interface BridgeExecutionLeaseMetadata {
  version: 1
  idempotencyKey: string
  ownerToken: string
  ownerLabel: string
  acquiredAt: string
  expiresAt: string
}

export interface BridgeExecutionLease {
  metadata: BridgeExecutionLeaseMetadata
  claimDir: string
  renew(leaseDurationMs: number, now?: Date): Promise<boolean>
  release(): Promise<boolean>
}

export type BridgeExecutionClaimResult =
  | { kind: 'acquired'; lease: BridgeExecutionLease }
  | { kind: 'busy'; metadata?: BridgeExecutionLeaseMetadata }

export async function acquireBridgeExecutionLease(
  paths: BridgeStatePaths,
  idempotencyKey: string,
  ownerLabel: string,
  leaseDurationMs: number,
  now?: Date,
): Promise<BridgeExecutionClaimResult> {
  validateLeaseInput(idempotencyKey, ownerLabel, leaseDurationMs)
  await mkdir(paths.claimsDir, { recursive: true })
  const identity = digest(idempotencyKey)
  const claimDir = path.join(paths.claimsDir, `${identity}.lock`)

  return withMutationLock(paths, identity, async () => {
    const observedNow = now ?? new Date()
    const current = await readMetadata(claimDir)
    if (current) {
      if (Date.parse(current.expiresAt) > observedNow.getTime()) return { kind: 'busy', metadata: current }
      await moveAside(claimDir, 'stale')
    } else {
      const exists = await stat(claimDir).then(() => true).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      })
      if (exists) {
        const age = await stat(claimDir).then(value => Date.now() - value.mtimeMs)
        if (age < INITIALIZATION_GRACE_MS) return { kind: 'busy' }
        await moveAside(claimDir, 'uninitialized')
      }
    }

    await mkdir(claimDir)
    const metadata = makeMetadata(idempotencyKey, randomUUID(), ownerLabel, leaseDurationMs, observedNow)
    try {
      await writeMetadata(claimDir, metadata)
      return { kind: 'acquired', lease: createLease(paths, identity, claimDir, metadata) }
    } catch (error) {
      await rm(claimDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  })
}

function createLease(paths: BridgeStatePaths, identity: string, claimDir: string, initial: BridgeExecutionLeaseMetadata): BridgeExecutionLease {
  let metadata = initial
  return {
    get metadata() { return metadata },
    claimDir,
    async renew(leaseDurationMs: number, now?: Date): Promise<boolean> {
      if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) throw new Error('bridge execution leaseDurationMs must be an integer >= 1000')
      return withMutationLock(paths, identity, async () => {
        const observedNow = now ?? new Date()
        const current = await readMetadata(claimDir)
        if (!current || current.ownerToken !== metadata.ownerToken) return false
        if (Date.parse(current.expiresAt) <= observedNow.getTime()) return false
        metadata = { ...current, expiresAt: new Date(observedNow.getTime() + leaseDurationMs).toISOString() }
        await writeMetadata(claimDir, metadata)
        return true
      })
    },
    async release(): Promise<boolean> {
      return withMutationLock(paths, identity, async () => {
        const current = await readMetadata(claimDir)
        if (!current || current.ownerToken !== metadata.ownerToken) return false
        const releasing = `${claimDir}.release.${metadata.ownerToken}`
        try { await rename(claimDir, releasing) }
        catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
        await rm(releasing, { recursive: true, force: true })
        return true
      })
    },
  }
}

function validateLeaseInput(idempotencyKey: string, ownerLabel: string, leaseDurationMs: number): void {
  if (!idempotencyKey.trim()) throw new Error('bridge idempotencyKey must be non-empty')
  if (!ownerLabel.trim()) throw new Error('bridge ownerLabel must be non-empty')
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) throw new Error('bridge execution leaseDurationMs must be an integer >= 1000')
}

function makeMetadata(idempotencyKey: string, ownerToken: string, ownerLabel: string, leaseDurationMs: number, now: Date): BridgeExecutionLeaseMetadata {
  return { version: 1, idempotencyKey, ownerToken, ownerLabel, acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString() }
}

async function readMetadata(claimDir: string): Promise<BridgeExecutionLeaseMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(claimDir, 'owner.json'), 'utf8')) as BridgeExecutionLeaseMetadata
    if (value.version !== 1 || typeof value.ownerToken !== 'string' || typeof value.idempotencyKey !== 'string' || typeof value.expiresAt !== 'string') return undefined
    return value
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function writeMetadata(claimDir: string, metadata: BridgeExecutionLeaseMetadata): Promise<void> {
  const file = path.join(claimDir, 'owner.json')
  const temporary = path.join(claimDir, `.owner.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

async function moveAside(claimDir: string, reason: string): Promise<boolean> {
  const stale = `${claimDir}.${reason}.${randomUUID()}`
  try { await rename(claimDir, stale) }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  await rm(stale, { recursive: true, force: true })
  return true
}

async function withMutationLock<T>(paths: BridgeStatePaths, identity: string, operation: () => Promise<T>): Promise<T> {
  const root = path.join(paths.claimsDir, '.mutation')
  const lockDir = path.join(root, `${identity}.lock`)
  const deadline = Date.now() + MUTATION_LOCK_TIMEOUT_MS
  await mkdir(root, { recursive: true })
  while (true) {
    try { await mkdir(lockDir); break }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for bridge execution lease mutation lock: ${lockDir}; fail-closed manual recovery is required if the prior owner crashed inside lease metadata mutation`)
      }
      await sleep(MUTATION_LOCK_POLL_MS)
    }
  }
  try { return await operation() }
  finally { await rm(lockDir, { recursive: true, force: true }) }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
async function sleep(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)) }
