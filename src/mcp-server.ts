#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { executeControl } from './control.js'
import { createConfiguredRuntime, requireBuiltInAdapterId } from './runtime-factory.js'
import type { AutomationTarget, CreatePipelineInput, CreateScheduleInput } from './core/types.js'

interface JsonRpcRequest { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> }
const mutationsEnabled = process.env.FLOWIT_WORKFLOW_MUTATIONS === '1' || process.env.FLOWIT_WORKFLOW_CLAUDE_MUTATIONS === '1'
const adapterId = requireBuiltInAdapterId(process.env.FLOWIT_WORKFLOW_ADAPTER ?? 'claude-code', 'FLOWIT_WORKFLOW_ADAPTER')
const core = createConfiguredRuntime({ activeWorkers: false, defaultAdapterId: adapterId })
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => { void handle(line).catch(error => process.stderr.write(`[flowit-workflow-mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)) })
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown()); process.once('beforeExit', () => void core.dispose())

async function handle(line: string): Promise<void> {
  if (!line.trim()) return
  const request = JSON.parse(line) as JsonRpcRequest
  if (request.id === undefined) return
  try { send({ jsonrpc: '2.0', id: request.id, result: await dispatch(request) }) }
  catch (error: unknown) { send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }) }
}
async function dispatch(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'initialize': return { protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'flowit-workflow', version: '0.5.0-beta.1' } }
    case 'ping': return {}
    case 'tools/list': return { tools: tools() }
    case 'tools/call': {
      await core.ready
      const name = String(request.params?.name ?? '')
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>
      return { content: [{ type: 'text', text: JSON.stringify(await call(name, args), null, 2) }] }
    }
    default: throw new Error(`unsupported MCP method ${request.method}`)
  }
}
async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (isMutation(name) && !mutationsEnabled) throw new Error('Flowit Workflow mutation tools are disabled. Set FLOWIT_WORKFLOW_MUTATIONS=1 to opt in.')
  switch (name) {
    case 'sessions_list': { const adapterId = optional(args.adapterId); const query = optional(args.query); return executeControl(core, { op: 'sessions.list', ...(adapterId ? { adapterId } : {}), ...(query ? { query } : {}) }) }
    case 'dispatch': return executeControl(core, { op: 'dispatch', target: object(args.target, 'target') as unknown as AutomationTarget })
    case 'schedule_list': return executeControl(core, { op: 'schedule.list' })
    case 'schedule_create': return executeControl(core, { op: 'schedule.create', input: object(args.input, 'input') as unknown as CreateScheduleInput })
    case 'schedule_cancel': return executeControl(core, { op: 'schedule.cancel', id: string(args.id, 'id') })
    case 'pipeline_list': return executeControl(core, { op: 'pipeline.list' })
    case 'pipeline_create': return executeControl(core, { op: 'pipeline.create', input: object(args.input, 'input') as unknown as CreatePipelineInput })
    case 'pipeline_run': return executeControl(core, { op: 'pipeline.run', id: string(args.id, 'id') })
    case 'pipeline_status': {
      const status = string(args.status, 'status')
      if (status !== 'active' && status !== 'paused') throw new Error('status must be active or paused')
      return executeControl(core, { op: 'pipeline.status', id: string(args.id, 'id'), status })
    }
    case 'daemon_start': return startDetachedDaemon()
    default: throw new Error(`unknown Flowit Workflow MCP tool ${name}`)
  }
}

async function startDetachedDaemon(): Promise<unknown> {
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'daemon', `--adapter=${adapterId}`, '--detach'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`Flowit Workflow daemon launcher exited ${code}: ${stderr.trim() || stdout.trim()}`)); return }
      try {
        const lines = stdout.trim().split('\n').filter(Boolean)
        const result = JSON.parse(lines.at(-1) ?? '') as unknown
        resolve(result)
      } catch (error: unknown) { reject(new Error(`Flowit Workflow daemon launcher returned invalid readiness output: ${error instanceof Error ? error.message : String(error)}`)) }
    })
  })
}

function tools(): unknown[] {
  const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })
  return [
    { name: 'sessions_list', description: 'List sessions visible through Flowit Workflow Agent adapters.', inputSchema: obj({ adapterId: { type: 'string' }, query: { type: 'string' } }) },
    { name: 'dispatch', description: 'Dispatch work to a session with Skill bindings and read-only context references.', inputSchema: obj({ target: { type: 'object' } }, ['target']) },
    { name: 'schedule_list', description: 'List durable schedules.', inputSchema: obj({}) },
    { name: 'schedule_create', description: 'Create a durable schedule.', inputSchema: obj({ input: { type: 'object' } }, ['input']) },
    { name: 'schedule_cancel', description: 'Cancel a schedule.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
    { name: 'pipeline_list', description: 'List pipelines.', inputSchema: obj({}) },
    { name: 'pipeline_create', description: 'Create a cross-session/cross-adapter pipeline.', inputSchema: obj({ input: { type: 'object' } }, ['input']) },
    { name: 'pipeline_run', description: 'Run a pipeline now.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
    { name: 'pipeline_status', description: 'Pause or activate a pipeline.', inputSchema: obj({ id: { type: 'string' }, status: { type: 'string', enum: ['active', 'paused'] } }, ['id', 'status']) },
    { name: 'daemon_start', description: `Start the detached Flowit Workflow daemon for ${adapterId} and wait for readiness.`, inputSchema: obj({}) },
  ].filter((tool: any) => mutationsEnabled || !isMutation(tool.name))
}
function isMutation(name: string): boolean { return new Set(['dispatch', 'schedule_create', 'schedule_cancel', 'pipeline_create', 'pipeline_run', 'pipeline_status', 'daemon_start']).has(name) }
function string(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value }
function optional(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined }
function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as Record<string, unknown> }
function send(message: unknown): void { process.stdout.write(`${JSON.stringify(message)}\n`) }
async function shutdown(): Promise<void> { await core.dispose(); process.exit(0) }
