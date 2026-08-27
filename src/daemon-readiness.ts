import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'

export interface DaemonReadiness { ready: boolean; pid: number; error?: string }

export async function publishDaemonReadiness(file: string, payload: DaemonReadiness): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx')
    try { await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8'); await handle.sync() }
    finally { await handle.close().catch(() => undefined) }
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

export async function waitForDaemonReadiness(child: ChildProcess, file: string, timeoutMs: number): Promise<DaemonReadiness> {
  const deadline = Date.now() + timeoutMs
  let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => { closed = { code, signal } }
  child.once('close', onClose)
  try {
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await readFile(file, 'utf8')) as DaemonReadiness
        if (child.pid && value.pid !== child.pid) throw new Error('daemon readiness pid mismatch')
        return value
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
      if (closed) return { ready: false, pid: child.pid ?? -1, error: `daemon child exited before readiness (${closed.code ?? 'null'}, ${closed.signal ?? 'no-signal'})` }
      await delay(50)
    }
    return { ready: false, pid: child.pid ?? -1, error: `readiness timeout after ${timeoutMs}ms` }
  } finally {
    child.removeListener('close', onClose)
    await rm(file, { force: true }).catch(() => undefined)
  }
}

export async function terminateDetachedChild(child: ChildProcess, termGraceMs = 2_500, killGraceMs = 1_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  signalChildTree(child, 'SIGTERM')
  if (await waitForChildClose(child, termGraceMs)) return true
  signalChildTree(child, 'SIGKILL')
  return waitForChildClose(child, killGraceMs)
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && (error as NodeJS.ErrnoException).code !== 'EINVAL') throw error }
  }
  try { child.kill(signal) }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise(resolve => {
    let settled = false
    const finish = (value: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); child.removeListener('close', onClose); resolve(value) }
    const onClose = (): void => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs); timer.unref?.()
    child.once('close', onClose)
  })
}

async function delay(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)) }
