#!/usr/bin/env node
import { open, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { executeControl, type ControlRequest } from './control.js'
import { ingestClaudeHook, type ClaudeHookInput } from './claude/hook.js'
import { createClaudeCodeRuntime } from './claude/runtime.js'

void main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1 })
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'claude-hook': await ingestClaudeHook(JSON.parse(await readStdin()) as ClaudeHookInput); return
    case 'ctl': await runControl(); return
    case 'claude-daemon': case 'daemon': if (args.includes('--detach')) { detachDaemon(); return } await runDaemon(); return
    case 'claude-sessions': { const core = createClaudeCodeRuntime({ activeWorkers: false }); try { console.log(JSON.stringify(await executeControl(core, { op: 'sessions.list' }), null, 2)) } finally { await core.dispose() } return }
    default: console.log(help())
  }
}
async function runControl(): Promise<void> { const request = JSON.parse(await readStdin()) as ControlRequest; const pluginRoot = pluginRootFromEnv(); const core = createClaudeCodeRuntime({ activeWorkers: false, adapter: pluginRoot ? { pluginDir: pluginRoot } : {} }); try { console.log(JSON.stringify(await executeControl(core, request), null, 2)) } finally { await core.dispose() } }
async function runDaemon(): Promise<void> { const lease = await acquireDaemonLease(); const pluginRoot = pluginRootFromEnv(); const core = createClaudeCodeRuntime({ adapter: pluginRoot ? { pluginDir: pluginRoot } : {} }); let stopping = false; const stop = async (): Promise<void> => { if (stopping) return; stopping = true; await core.dispose(); await lease.release() }; process.once('SIGINT', () => void stop().finally(() => process.exit(0))); process.once('SIGTERM', () => void stop().finally(() => process.exit(0))); await core.ready; console.error(`Flowit Workflow Claude daemon ready (pid ${process.pid})`); await new Promise<void>(resolve => { const keepAlive = setInterval(() => undefined, 60_000); process.once('beforeExit', () => { clearInterval(keepAlive); resolve() }) }) }
function detachDaemon(): void { const child = spawn(process.execPath, [process.argv[1]!, 'claude-daemon'], { detached: true, stdio: 'ignore', env: process.env }); child.unref(); console.log(JSON.stringify({ started: true, pid: child.pid })) }
async function acquireDaemonLease(): Promise<{ release(): Promise<void> }> { const root = path.join(os.homedir(), '.flowit-workflow', 'claude'); const pidFile = path.join(root, 'daemon.pid'); await import('node:fs/promises').then(fs => fs.mkdir(root, { recursive: true })); for (let attempt = 0; attempt < 2; attempt += 1) { try { const handle = await open(pidFile, 'wx'); await handle.writeFile(`${process.pid}\n`, 'utf8'); await handle.close(); return { release: () => rm(pidFile, { force: true }) } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const existing = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim()); if (Number.isSafeInteger(existing) && existing > 0) { try { process.kill(existing, 0); throw new Error(`Flowit Workflow Claude daemon already running with pid ${existing}`) } catch (probe: unknown) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe } } await rm(pidFile, { force: true }) } } throw new Error('failed to acquire Flowit Workflow Claude daemon lease') }
async function readStdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8') }
function help(): string { return ['Flowit Workflow','','Commands:','  flowit-workflow claude-hook       ingest one Claude Code hook JSON object from stdin','  flowit-workflow ctl               execute one JSON control request from stdin','  flowit-workflow claude-daemon     run the Claude Code scheduler/event router','  flowit-workflow claude-daemon --detach','  flowit-workflow claude-sessions   list captured Claude Code sessions'].join('\n') }
function pluginRootFromEnv(): string | undefined { return process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT }
