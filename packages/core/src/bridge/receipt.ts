import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AgentDispatchResult } from '../core/types.js'

export interface BridgeReceipt {
  version: 1
  idempotencyKey: string
  status: 'completed'
  completedAt: string
  result: AgentDispatchResult
}

class InvalidBridgeReceiptError extends Error {}

export async function readCompletedBridgeReceipt(
  file: string,
  idempotencyKey: string,
): Promise<AgentDispatchResult | undefined> {
  try {
    const receipt = parseReceipt(await readFile(file, 'utf8'))
    if (receipt.idempotencyKey !== idempotencyKey)
      throw new InvalidBridgeReceiptError(`bridge receipt idempotency key mismatch for ${file}`)
    return receipt.result
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof SyntaxError || error instanceof InvalidBridgeReceiptError) {
      throw new InvalidBridgeReceiptError(
        `bridge receipt ${file} is malformed; automatic quarantine is disabled to avoid racing a concurrent publisher`,
      )
    }
    throw error
  }
}

export async function publishCompletedBridgeReceipt(
  file: string,
  idempotencyKey: string,
  result: AgentDispatchResult,
): Promise<AgentDispatchResult> {
  assertDispatchResult(result)
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const receipt: BridgeReceipt = {
    version: 1,
    idempotencyKey,
    status: 'completed',
    completedAt: new Date().toISOString(),
    result,
  }
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  )
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }

  try {
    while (true) {
      try {
        await link(temporary, file)
        await syncDirectory(directory)
        return result
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await readCompletedBridgeReceipt(file, idempotencyKey)
        if (existing) return existing
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function parseReceipt(raw: string): BridgeReceipt {
  const value = JSON.parse(raw) as Partial<BridgeReceipt>
  if (
    value.version !== 1 ||
    value.status !== 'completed' ||
    typeof value.idempotencyKey !== 'string' ||
    typeof value.completedAt !== 'string'
  )
    throw new InvalidBridgeReceiptError('invalid bridge receipt envelope')
  assertDispatchResult(value.result)
  return value as BridgeReceipt
}

function assertDispatchResult(value: unknown): asserts value is AgentDispatchResult {
  if (!value || typeof value !== 'object')
    throw new InvalidBridgeReceiptError('bridge receipt result must be an object')
  const row = value as Partial<AgentDispatchResult>
  if (
    typeof row.sessionId !== 'string' ||
    !Array.isArray(row.loadedSkills) ||
    !row.loadedSkills.every(item => typeof item === 'string') ||
    !Array.isArray(row.referencedSessions) ||
    !row.referencedSessions.every(item => typeof item === 'string')
  )
    throw new InvalidBridgeReceiptError('bridge receipt result is malformed')
  if (row.outputSummary !== undefined && typeof row.outputSummary !== 'string')
    throw new InvalidBridgeReceiptError('bridge receipt outputSummary is malformed')
  if (row.runId !== undefined && typeof row.runId !== 'string')
    throw new InvalidBridgeReceiptError('bridge receipt runId is malformed')
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      process.platform === 'win32' &&
      (code === 'EACCES' || code === 'EPERM' || code === 'EINVAL')
    )
      return
    throw error
  }
}
