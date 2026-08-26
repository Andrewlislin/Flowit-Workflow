#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createClaudeCodeRuntime } from './claude/runtime.js'
import { executeControl } from './control.js'
import type { AutomationTarget, CreatePipelineInput, CreateScheduleInput } from './core/types.js'

interface JsonRpcRequest { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> }
const mutationsEnabled = process.env.FLOWIT_WORKFLOW_CLAUDE_MUTATIONS === '1'
const pluginRoot = pluginRootFromEnv()
const core = createClaudeCodeRuntime({ activeWorkers: false, adapter: pluginRoot ? { pluginDir: pluginRoot } : {} })
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => { void handleLine(line).catch(error => { process.stderr.write(`[flowit-workflow-mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`) }) })
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown()); process.once('beforeExit', () => void core.dispose())

async function handleLine(line: string): Promise<void> { if (!line.trim()) return; const request = JSON.parse(line) as JsonRpcRequest; if (request.id === undefined) return; try { const result = await dispatch(request); send({ jsonrpc: '2.0', id: request.id, result }) } catch (error: unknown) { send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }) } }
async function dispatch(request: JsonRpcRequest): Promise<unknown> { switch (request.method) { case 'initialize': return { protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'flowit-workflow', version: '0.2.0' } }; case 'ping': return {}; case 'tools/list': return { tools: toolDefinitions() }; case 'tools/call': { const name = String(request.params?.name ?? ''); const args = (request.params?.arguments ?? {}) as Record<string, unknown>; const value = await callTool(name, args); return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] } } default: throw new Error(`unsupported MCP method ${request.method}`) } }
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (isMutationTool(name) && !mutationsEnabled) throw new Error('Flowit Workflow mutation tools are disabled. Set FLOWIT_WORKFLOW_CLAUDE_MUTATIONS=1 before starting Claude Code to opt in.')
  switch (name) {
    case 'sessions_list': { const adapterId = asOptionalString(args.adapterId); const query = asOptionalString(args.query); return executeControl(core, { op: 'sessions.list', ...(adapterId ? { adapterId } : {}), ...(query ? { query } : {}) }) }
    case 'dispatch': return executeControl(core, { op: 'dispatch', target: requiredObject(args.target, 'target') as unknown as AutomationTarget })
    case 'schedule_list': return executeControl(core, { op: 'schedule.list' })
    case 'schedule_create': return executeControl(core, { op: 'schedule.create', input: requiredObject(args.input, 'input') as unknown as CreateScheduleInput })
    case 'schedule_cancel': return executeControl(core, { op: 'schedule.cancel', id: requiredString(args.id, 'id') })
    case 'pipeline_list': return executeControl(core, { op: 'pipeline.list' })
    case 'pipeline_create': return executeControl(core, { op: 'pipeline.create', input: requiredObject(args.input, 'input') as unknown as CreatePipelineInput })
    case 'pipeline_run': return executeControl(core, { op: 'pipeline.run', id: requiredString(args.id, 'id') })
    case 'pipeline_status': { const status = requiredString(args.status, 'status'); if (status !== 'active' && status !== 'paused') throw new Error('status must be active or paused'); return executeControl(core, { op: 'pipeline.status', id: requiredString(args.id, 'id'), status }) }
    case 'daemon_start': { const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url)); const child = spawn(process.execPath, [cliPath, 'claude-daemon'], { detached: true, stdio: 'ignore', env: process.env }); child.unref(); return { started: true, pid: child.pid } }
    default: throw new Error(`unknown Flowit Workflow MCP tool ${name}`)
  }
}
function toolDefinitions(): unknown[] { const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required }); return [
  { name: 'sessions_list', description: 'List Claude Code sessions captured by the Flowit Workflow plugin hooks.', inputSchema: object({ adapterId: { type: 'string' }, query: { type: 'string' } }) },
  { name: 'dispatch', description: 'Dispatch work to an agent session using the registered adapter, Skill bindings, and context references.', inputSchema: object({ target: { type: 'object' } }, ['target']) },
  { name: 'schedule_list', description: 'List durable Flowit Workflow schedules.', inputSchema: object({}) },
  { name: 'schedule_create', description: 'Create a durable Flowit Workflow schedule. Start the daemon for unattended firing.', inputSchema: object({ input: { type: 'object' } }, ['input']) },
  { name: 'schedule_cancel', description: 'Cancel a Flowit Workflow schedule.', inputSchema: object({ id: { type: 'string' } }, ['id']) },
  { name: 'pipeline_list', description: 'List Flowit Workflow pipelines.', inputSchema: object({}) },
  { name: 'pipeline_create', description: 'Create a Flowit Workflow pipeline definition.', inputSchema: object({ input: { type: 'object' } }, ['input']) },
  { name: 'pipeline_run', description: 'Run an active Flowit Workflow pipeline now.', inputSchema: object({ id: { type: 'string' } }, ['id']) },
  { name: 'pipeline_status', description: 'Pause or activate a Flowit Workflow pipeline.', inputSchema: object({ id: { type: 'string' }, status: { type: 'string', enum: ['active', 'paused'] } }, ['id','status']) },
  { name: 'daemon_start', description: 'Start the detached Claude Code Flowit Workflow scheduler/event daemon.', inputSchema: object({}) },
].filter(tool => mutationsEnabled || !isMutationTool(tool.name)) }
function isMutationTool(name: string): boolean { return new Set(['dispatch','schedule_create','schedule_cancel','pipeline_create','pipeline_run','pipeline_status','daemon_start']).has(name) }
function requiredString(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value }
function asOptionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined }
function requiredObject(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as Record<string, unknown> }
function send(message: unknown): void { process.stdout.write(`${JSON.stringify(message)}\n`) }
async function shutdown(): Promise<void> { await core.dispose(); process.exit(0) }
function pluginRootFromEnv(): string | undefined { return process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT }
