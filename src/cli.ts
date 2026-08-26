#!/usr/bin/env node
import { open, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { executeControl, type ControlRequest } from './control.js'
import { ingestClaudeHook, type ClaudeHookInput } from './claude/hook.js'
import { ingestBridgeHook, type GenericHookInput } from './bridge/hook.js'
import { createConfiguredRuntime, requireBuiltInAdapterId, type BuiltInAdapterId } from './runtime-factory.js'

void main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1 })

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'claude-hook': await ingestClaudeHook(JSON.parse(await readStdin()) as ClaudeHookInput); return
    case 'bridge-hook': {
      const adapter = args[0]
      if (!adapter) throw new Error('bridge-hook requires adapter id')
      if (adapter !== 'workbuddy' && adapter !== 'doubao-office') throw new Error('bridge-hook currently supports workbuddy or doubao-office')
      await ingestBridgeHook(adapter, JSON.parse(await readStdin()) as GenericHookInput)
      return
    }
    case 'ctl': await runControl(args); return
    case 'daemon': case 'claude-daemon': await runDaemon(command === 'claude-daemon' ? ['--adapter=claude-code', ...args] : args); return
    case 'sessions': case 'claude-sessions': await runSessions(command === 'claude-sessions' ? ['--adapter=claude-code', ...args] : args); return
    default: console.log(help())
  }
}

async function runControl(args: string[]): Promise<void> {
  const value = option(args, 'adapter')
  const adapter = value === undefined ? undefined : requireBuiltInAdapterId(value)
  const request = JSON.parse(await readStdin()) as ControlRequest
  const core = createConfiguredRuntime({ activeWorkers: false, ...(adapter ? { defaultAdapterId: adapter, adapterIds: [adapter] } : {}) })
  try { console.log(JSON.stringify(await executeControl(core, request), null, 2)) } finally { await core.dispose() }
}

async function runSessions(args: string[]): Promise<void> {
  const adapter = requireBuiltInAdapterId(option(args, 'adapter') ?? process.env.FLOWIT_WORKFLOW_ADAPTER ?? 'claude-code')
  const core = createConfiguredRuntime({ activeWorkers: false, defaultAdapterId: adapter, adapterIds: [adapter] })
  try { console.log(JSON.stringify(await executeControl(core, { op: 'sessions.list', adapterId: adapter }), null, 2)) } finally { await core.dispose() }
}

async function runDaemon(args: string[]): Promise<void> {
  const adapter = requireBuiltInAdapterId(option(args, 'adapter') ?? process.env.FLOWIT_WORKFLOW_ADAPTER ?? 'claude-code')
  const rawAdapters = (option(args, 'adapters') ?? process.env.FLOWIT_WORKFLOW_ADAPTERS)?.split(',').map(value => value.trim()).filter(Boolean)
  const adapters: BuiltInAdapterId[] = rawAdapters?.map(value => requireBuiltInAdapterId(value, 'adapters')) ?? [adapter]
  if (args.includes('--detach')) {
    const clean = args.filter(arg => arg !== '--detach')
    const child = spawn(process.execPath, [process.argv[1]!, 'daemon', ...clean], { detached: true, stdio: 'ignore', env: process.env })
    child.unref()
    console.log(JSON.stringify({ started: true, pid: child.pid, adapter, adapters }))
    return
  }
  const lease = await acquireDaemonLease(adapter)
  const core = createConfiguredRuntime({ defaultAdapterId: adapter, adapterIds: adapters })
  let stopping = false
  const stop = async (): Promise<void> => { if (stopping) return; stopping = true; await core.dispose(); await lease.release() }
  process.once('SIGINT', () => void stop().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)))
  await core.ready
  console.error(`Flowit Workflow daemon ready for ${adapters.join(',')} (pid ${process.pid})`)
  await new Promise<void>(() => undefined)
}

async function acquireDaemonLease(adapter: string): Promise<{ release(): Promise<void> }> {
  const root = path.join(os.homedir(), '.flowit-workflow', adapter)
  const pidFile = path.join(root, 'daemon.pid')
  await import('node:fs/promises').then(fs => fs.mkdir(root, { recursive: true }))
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(pidFile, 'wx')
      await handle.writeFile(`${process.pid}\n`, 'utf8')
      await handle.close()
      return { release: () => rm(pidFile, { force: true }) }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim())
      if (Number.isSafeInteger(existing) && existing > 0) {
        try { process.kill(existing, 0); throw new Error(`Flowit Workflow daemon already running with pid ${existing}`) }
        catch (probe: unknown) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe }
      }
      await rm(pidFile, { force: true })
    }
  }
  throw new Error('failed to acquire daemon lease')
}

async function readStdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8') }
function option(args: string[], name: string): string | undefined { const prefix = `--${name}=`; const inline = args.find(arg => arg.startsWith(prefix)); if (inline) return inline.slice(prefix.length); const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined }
function help(): string { return ['Flowit Workflow', '', 'Commands:', '  flowit-workflow daemon --adapter=codex --detach', '  flowit-workflow daemon --adapter=opencode --adapters=opencode,codex', '  flowit-workflow sessions --adapter=workbuddy', '  flowit-workflow bridge-hook workbuddy', '  flowit-workflow bridge-hook doubao-office', '  flowit-workflow ctl --adapter=opencode', '  flowit-workflow claude-hook', '  flowit-workflow claude-daemon --detach   (compatibility alias)'].join('\n') }
