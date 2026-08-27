#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { executeControl, type ControlRequest } from './control.js'
import { ingestClaudeHook, type ClaudeHookInput } from './claude/hook.js'
import { ingestBridgeHook, type GenericHookInput } from './bridge/hook.js'
import { acquireDaemonLease, type DaemonLease } from './daemon-lease.js'
import { publishDaemonReadiness, terminateDetachedChild, waitForDaemonReadiness } from './daemon-readiness.js'
import { JsonWorkflowStore } from './core/store.js'
import { createConfiguredRuntime, requireBuiltInAdapterId, resolveConfiguredRuntime, type BuiltInAdapterId } from './runtime-factory.js'

const DETACHED_READY_TIMEOUT_MS = 15_000

void main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1 })

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'claude-hook': await ingestClaudeHook(JSON.parse(await readStdin()) as ClaudeHookInput); return
    case 'bridge-hook': { const adapter = args[0]; if (!adapter) throw new Error('bridge-hook requires adapter id'); if (adapter !== 'workbuddy' && adapter !== 'doubao-office') throw new Error('bridge-hook currently supports workbuddy or doubao-office'); await ingestBridgeHook(adapter, JSON.parse(await readStdin()) as GenericHookInput); return }
    case 'ctl': await runControl(args); return
    case 'daemon': case 'claude-daemon': await runDaemon(command === 'claude-daemon' ? ['--adapter=claude-code', ...args] : args); return
    case 'sessions': case 'claude-sessions': await runSessions(command === 'claude-sessions' ? ['--adapter=claude-code', ...args] : args); return
    case 'migrate': await runMigration(args); return
    default: console.log(help())
  }
}

async function runControl(args: string[]): Promise<void> { const value = option(args, 'adapter'); const adapter = value === undefined ? undefined : requireBuiltInAdapterId(value); const request = JSON.parse(await readStdin()) as ControlRequest; const core = createConfiguredRuntime({ activeWorkers: false, ...(adapter ? { defaultAdapterId: adapter, adapterIds: [adapter] } : {}), ...(option(args, 'instance') ? { instanceId: option(args, 'instance') } : {}) }); try { await core.ready; console.log(JSON.stringify(await executeControl(core, request), null, 2)) } finally { await core.dispose() } }
async function runSessions(args: string[]): Promise<void> { const adapter = requireBuiltInAdapterId(option(args, 'adapter') ?? process.env.FLOWIT_WORKFLOW_ADAPTER ?? 'claude-code'); const core = createConfiguredRuntime({ activeWorkers: false, defaultAdapterId: adapter, adapterIds: [adapter], ...(option(args, 'instance') ? { instanceId: option(args, 'instance') } : {}) }); try { await core.ready; console.log(JSON.stringify(await executeControl(core, { op: 'sessions.list', adapterId: adapter }), null, 2)) } finally { await core.dispose() } }

async function runMigration(args: string[]): Promise<void> {
  const adapter = requireBuiltInAdapterId(option(args, 'adapter') ?? process.env.FLOWIT_WORKFLOW_ADAPTER ?? 'claude-code')
  const instanceId = option(args, 'instance') ?? process.env.FLOWIT_WORKFLOW_INSTANCE_ID
  const explicitLegacy = options(args, 'legacy-storage')
  const resolved = resolveConfiguredRuntime({ defaultAdapterId: adapter, activeWorkers: false, ...(instanceId ? { instanceId } : {}), ...(explicitLegacy.length ? { legacyStorageFiles: explicitLegacy } : {}) })
  const lease = await acquireDaemonLease(resolved.instanceId, resolved.storageFile)
  try {
    const store = new JsonWorkflowStore(resolved.storageFile, resolved.maxRunHistory, resolved.legacyStorageFiles, resolved.maxTerminalReceipts, resolved.terminalReceiptRetentionMs)
    const state = await store.snapshot()
    console.log(JSON.stringify({ migrated: true, instanceId: resolved.instanceId, storageFile: resolved.storageFile, legacyStorageFiles: resolved.legacyStorageFiles, schedules: state.schedules.length, pipelines: state.pipelines.length }, null, 2))
  } finally { await lease.release() }
}

async function runDaemon(args: string[]): Promise<void> {
  const adapter = requireBuiltInAdapterId(option(args, 'adapter') ?? process.env.FLOWIT_WORKFLOW_ADAPTER ?? 'claude-code')
  const rawAdapters = (option(args, 'adapters') ?? process.env.FLOWIT_WORKFLOW_ADAPTERS)?.split(',').map(value => value.trim()).filter(Boolean)
  const adapters: BuiltInAdapterId[] = rawAdapters?.map(value => requireBuiltInAdapterId(value, 'adapters')) ?? [adapter]
  const instanceId = option(args, 'instance') ?? process.env.FLOWIT_WORKFLOW_INSTANCE_ID
  const resolved = resolveConfiguredRuntime({ defaultAdapterId: adapter, adapterIds: adapters, ...(instanceId ? { instanceId } : {}) })
  if (args.includes('--detach')) {
    const readyFile = path.join(os.tmpdir(), `flowit-workflow-ready-${randomUUID()}.json`)
    const clean = args.filter(arg => arg !== '--detach')
    const child = spawn(process.execPath, [process.argv[1]!, 'daemon', ...clean], { detached: true, stdio: 'ignore', env: { ...process.env, FLOWIT_WORKFLOW_READY_FILE: readyFile } })
    let ready: {ready:boolean;pid:number;error?:string}
    try { ready = await waitForDaemonReadiness(child, readyFile, DETACHED_READY_TIMEOUT_MS) }
    catch (error) { await terminateDetachedChild(child); throw error }
    if (!ready.ready) { await terminateDetachedChild(child); throw new Error(`Flowit Workflow daemon failed to start: ${ready.error ?? 'unknown startup failure'}`) }
    child.unref(); console.log(JSON.stringify({ started: true, pid: ready.pid, instanceId: resolved.instanceId, storageFile: resolved.storageFile, adapter, adapters })); return
  }

  let lease: DaemonLease | undefined
  let core: ReturnType<typeof createConfiguredRuntime> | undefined
  try {
    lease = await acquireDaemonLease(resolved.instanceId, resolved.storageFile)
    core = createConfiguredRuntime({ defaultAdapterId: resolved.defaultAdapterId, adapterIds: resolved.adapterIds, instanceId: resolved.instanceId, storageFile: resolved.storageFile, legacyStorageFiles: resolved.legacyStorageFiles })
    let stopping = false
    const stop = async (): Promise<void> => { if (stopping) return; stopping = true; await core?.dispose(); await lease?.release() }
    process.once('SIGINT', () => void stop().finally(() => process.exit(0)))
    process.once('SIGTERM', () => void stop().finally(() => process.exit(0)))
    await core.ready
    await announceReady({ ready: true, pid: process.pid })
    console.error(`Flowit Workflow daemon ready for ${adapters.join(',')} (instance ${resolved.instanceId}, pid ${process.pid})`)
    await new Promise<void>(() => undefined)
  } catch (error: unknown) {
    await announceReady({ ready: false, pid: process.pid, error: error instanceof Error ? error.message : String(error) })
    await core?.dispose().catch(() => undefined)
    await lease?.release().catch(() => undefined)
    throw error
  }
}

async function announceReady(payload: {ready:boolean;pid:number;error?:string}): Promise<void> { const file = process.env.FLOWIT_WORKFLOW_READY_FILE; if (file) await publishDaemonReadiness(file, payload).catch(() => undefined) }
async function readStdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8') }
function option(args: string[], name: string): string | undefined { const prefix = `--${name}=`; const inline = args.find(arg => arg.startsWith(prefix)); if (inline) return inline.slice(prefix.length); const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined }
function options(args: string[], name: string): string[] { const prefix = `--${name}=`; const result: string[] = []; for (let index = 0; index < args.length; index += 1) { const arg = args[index]!; if (arg.startsWith(prefix)) result.push(arg.slice(prefix.length)); else if (arg === `--${name}` && args[index + 1]) result.push(args[++index]!) } return result.filter(value => value.trim()) }
function help(): string { return ['Flowit Workflow', '', 'Commands:', '  flowit-workflow daemon --adapter=codex --instance=default --detach', '  flowit-workflow daemon --adapter=opencode --adapters=opencode,codex', '  flowit-workflow migrate --instance=default [--legacy-storage=/path/workflow.json ...]', '  flowit-workflow sessions --adapter=workbuddy', '  flowit-workflow bridge-hook workbuddy', '  flowit-workflow bridge-hook doubao-office', '  flowit-workflow ctl --adapter=opencode', '  flowit-workflow claude-hook'].join('\n') }
