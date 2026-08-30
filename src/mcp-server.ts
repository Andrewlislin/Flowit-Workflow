#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { executeControl } from './control.js'
import type { AutomationTarget, CreatePipelineInput, CreateScheduleInput } from './core/types.js'
import { createConfiguredRuntime, requireBuiltInAdapterId } from './runtime-factory.js'
import {
  commitPreparedWorkflow,
  createRoutingAuthorityFromEnvironment,
  prepareWorkflow,
  type PrepareWorkflowInput,
  type RoutingCallerContext,
  type RoutingWorkflowToolName,
  type TaskAssessmentRequest,
  type WorkflowTargetBinding,
} from './routing/index.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

const mutationsEnabled =
  process.env.FLOWIT_WORKFLOW_MUTATIONS === '1' ||
  process.env.FLOWIT_WORKFLOW_CLAUDE_MUTATIONS === '1'
const adapterId = requireBuiltInAdapterId(
  process.env.FLOWIT_WORKFLOW_ADAPTER ?? 'claude-code',
  'FLOWIT_WORKFLOW_ADAPTER',
)
const core = createConfiguredRuntime({ activeWorkers: false, defaultAdapterId: adapterId })
const routingAuthority = createRoutingAuthorityFromEnvironment()
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', line => {
  void handle(line).catch(error =>
    process.stderr.write(
      `[flowit-workflow-mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    ),
  )
})
process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
process.once('beforeExit', () => void core.dispose())

async function handle(line: string): Promise<void> {
  if (!line.trim()) return
  const request = JSON.parse(line) as JsonRpcRequest
  if (request.id === undefined) return
  try {
    send({ jsonrpc: '2.0', id: request.id, result: await dispatch(request) })
  } catch (error: unknown) {
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    })
  }
}

async function dispatch(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion:
          typeof request.params?.protocolVersion === 'string'
            ? request.params.protocolVersion
            : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'flowit-workflow', version: '0.5.0-beta.1' },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: tools() }
    case 'tools/call': {
      await core.ready
      const name = String(request.params?.name ?? '')
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>
      return {
        content: [{ type: 'text', text: JSON.stringify(await call(name, args), null, 2) }],
      }
    }
    default:
      throw new Error(`unsupported MCP method ${request.method}`)
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (isMutation(name) && !mutationsEnabled) {
    throw new Error(
      'Flowit Workflow mutation tools are disabled. Set FLOWIT_WORKFLOW_MUTATIONS=1 to opt in.',
    )
  }
  switch (name) {
    case 'sessions_list': {
      const requestedAdapterId = optional(args.adapterId)
      const query = optional(args.query)
      return executeControl(
        core,
        {
          op: 'sessions.list',
          ...(requestedAdapterId ? { adapterId: requestedAdapterId } : {}),
          ...(query ? { query } : {}),
        },
        routingAuthority,
      )
    }
    case 'dispatch':
      return executeControl(
        core,
        { op: 'dispatch', target: object(args.target, 'target') as unknown as AutomationTarget },
        routingAuthority,
      )
    case 'schedule_list':
      return executeControl(core, { op: 'schedule.list' }, routingAuthority)
    case 'schedule_create':
      return executeControl(
        core,
        {
          op: 'schedule.create',
          input: object(args.input, 'input') as unknown as CreateScheduleInput,
        },
        routingAuthority,
      )
    case 'schedule_cancel':
      return executeControl(
        core,
        { op: 'schedule.cancel', id: string(args.id, 'id') },
        routingAuthority,
      )
    case 'pipeline_list':
      return executeControl(core, { op: 'pipeline.list' }, routingAuthority)
    case 'pipeline_create':
      return executeControl(
        core,
        {
          op: 'pipeline.create',
          input: object(args.input, 'input') as unknown as CreatePipelineInput,
        },
        routingAuthority,
      )
    case 'pipeline_run':
      return executeControl(
        core,
        { op: 'pipeline.run', id: string(args.id, 'id') },
        routingAuthority,
      )
    case 'pipeline_status': {
      const status = string(args.status, 'status')
      if (status !== 'active' && status !== 'paused') {
        throw new Error('status must be active or paused')
      }
      return executeControl(
        core,
        { op: 'pipeline.status', id: string(args.id, 'id'), status },
        routingAuthority,
      )
    }
    case 'workflow_assess': {
      const callerContext = callerContextFor('workflow_assess', args)
      return routingAuthority.assess(assessmentInput(args), callerContext)
    }
    case 'workflow_prepare': {
      const callerContext = callerContextFor('workflow_prepare', args)
      return prepareWorkflow(
        core,
        routingAuthority,
        prepareInput(args),
        { callerContext },
      )
    }
    case 'workflow_commit': {
      const callerContext = callerContextFor('workflow_commit', args)
      const confirmationToken = optional(args.confirmationToken)
      return commitPreparedWorkflow(
        core,
        routingAuthority,
        object(args.proposal, 'proposal'),
        string(args.expectedHash, 'expectedHash'),
        {
          callerContext,
          ...(confirmationToken ? { confirmationToken } : {}),
        },
      )
    }
    case 'workflow_run_get':
      return executeControl(
        core,
        { op: 'workflow.run.get', runId: string(args.runId, 'runId') },
        routingAuthority,
      )
    case 'daemon_start':
      return startDetachedDaemon()
    default:
      throw new Error(`unknown Flowit Workflow MCP tool ${name}`)
  }
}

function callerContextFor(
  toolName: RoutingWorkflowToolName,
  args: Record<string, unknown>,
): RoutingCallerContext {
  const callerToken = string(args.callerToken, 'callerToken')
  const toolInput = structuredClone(args)
  delete toolInput.callerToken
  return routingAuthority.consumeCallerAttestation(
    callerToken,
    { toolName, toolInput },
  )
}

function assessmentInput(args: Record<string, unknown>): TaskAssessmentRequest {
  const signals = args.signals === undefined
    ? undefined
    : object(args.signals, 'signals') as TaskAssessmentRequest['signals']
  const authorityToken = optional(args.authorityToken)
  return {
    task: string(args.task, 'task'),
    ...(signals ? { signals } : {}),
    ...(authorityToken ? { authorityToken } : {}),
  }
}

function prepareInput(args: Record<string, unknown>): PrepareWorkflowInput {
  const rawTarget = object(args.target, 'target')
  const target: WorkflowTargetBinding = {
    adapterId: string(rawTarget.adapterId, 'target.adapterId'),
    sessionId: string(rawTarget.sessionId, 'target.sessionId'),
    ...(rawTarget.skills === undefined
      ? {}
      : { skills: stringArray(rawTarget.skills, 'target.skills') }),
  }
  const maxNodes = optionalInteger(args.maxNodes, 'maxNodes')
  const pipelineName = optional(args.pipelineName)
  return {
    assessmentToken: string(args.assessmentToken, 'assessmentToken'),
    target,
    ...(maxNodes === undefined ? {} : { maxNodes }),
    ...(pipelineName ? { pipelineName } : {}),
  }
}

async function startDetachedDaemon(): Promise<unknown> {
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, 'daemon', `--adapter=${adapterId}`, '--detach'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(
          new Error(
            `Flowit Workflow daemon launcher exited ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        )
        return
      }
      try {
        const lines = stdout.trim().split('\n').filter(Boolean)
        resolve(JSON.parse(lines.at(-1) ?? '') as unknown)
      } catch (error: unknown) {
        reject(
          new Error(
            `Flowit Workflow daemon launcher returned invalid readiness output: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    })
  })
}

function tools(): unknown[] {
  const obj = (
    properties: Record<string, unknown>,
    required: string[] = [],
  ) => ({ type: 'object', additionalProperties: false, properties, required })
  const signals = {
    type: 'object',
    additionalProperties: false,
    properties: {
      taskKind: { type: 'string', enum: ['general', 'research', 'coding', 'content'] },
      distinctStages: { type: 'integer', minimum: 1, maximum: 12 },
      decomposability: { type: 'integer', minimum: 0, maximum: 3 },
      coupling: { type: 'integer', minimum: 0, maximum: 3 },
      durabilityNeed: { type: 'integer', minimum: 0, maximum: 3 },
      reviewNeed: { type: 'integer', minimum: 0, maximum: 3 },
      requiresResearch: { type: 'boolean' },
      repeatable: { type: 'boolean' },
      crossSessionNeed: { type: 'boolean' },
      crossAdapterNeed: { type: 'boolean' },
      sideEffectRisk: { type: 'string', enum: ['none', 'reversible', 'irreversible'] },
      ambiguity: { type: 'integer', minimum: 0, maximum: 3 },
    },
  }
  const target = {
    type: 'object',
    additionalProperties: false,
    required: ['adapterId', 'sessionId'],
    properties: {
      adapterId: { type: 'string' },
      sessionId: { type: 'string' },
      skills: { type: 'array', items: { type: 'string' } },
    },
  }
  const callerToken = {
    type: 'string',
    description:
      'Opaque current-caller proof injected by the Claude PreToolUse Hook. Models must not create or copy this field.',
  }
  return [
    {
      name: 'sessions_list',
      description: 'List sessions visible through Flowit Workflow Agent adapters.',
      inputSchema: obj({ adapterId: { type: 'string' }, query: { type: 'string' } }),
    },
    {
      name: 'dispatch',
      description: 'Dispatch work to a session with Skill bindings and read-only context references.',
      inputSchema: obj({ target: { type: 'object' } }, ['target']),
    },
    {
      name: 'schedule_list',
      description: 'List durable schedules.',
      inputSchema: obj({}),
    },
    {
      name: 'schedule_create',
      description: 'Create a durable schedule.',
      inputSchema: obj({ input: { type: 'object' } }, ['input']),
    },
    {
      name: 'schedule_cancel',
      description: 'Cancel a schedule.',
      inputSchema: obj({ id: { type: 'string' } }, ['id']),
    },
    {
      name: 'pipeline_list',
      description: 'List persistent pipelines.',
      inputSchema: obj({}),
    },
    {
      name: 'pipeline_create',
      description: 'Create a persistent cross-session/cross-adapter pipeline.',
      inputSchema: obj({ input: { type: 'object' } }, ['input']),
    },
    {
      name: 'pipeline_run',
      description: 'Run a persistent pipeline now and wait for completion.',
      inputSchema: obj({ id: { type: 'string' } }, ['id']),
    },
    {
      name: 'pipeline_status',
      description: 'Pause or activate a persistent pipeline.',
      inputSchema: obj(
        { id: { type: 'string' }, status: { type: 'string', enum: ['active', 'paused'] } },
        ['id', 'status'],
      ),
    },
    {
      name: 'workflow_assess',
      description:
        'Read-only adaptive routing assessment. Routing mode comes only from trusted process configuration. A Claude PreToolUse Hook proves the actual calling Session and UserPromptSubmit may supply an exact-task authority token.',
      inputSchema: obj(
        {
          task: { type: 'string' },
          signals,
          authorityToken: { type: 'string' },
          callerToken,
        },
        ['task'],
      ),
    },
    {
      name: 'workflow_prepare',
      description:
        'Read-only Workflow-state preparation of an expiring 2-6 node, single-Session run-once proposal. The Claude PreToolUse Hook proves the actual caller Session.',
      inputSchema: obj(
        {
          assessmentToken: { type: 'string' },
          target,
          maxNodes: { type: 'integer', minimum: 2, maximum: 6 },
          pipelineName: { type: 'string' },
          callerToken,
        },
        ['assessmentToken', 'target'],
      ),
    },
    {
      name: 'workflow_commit',
      description:
        'Revalidate an expiring signed proposal and exact binding. The Host must prove the actual calling Session; when confirmation is required, the user must confirm the displayed proposal code.',
      inputSchema: obj(
        {
          proposal: { type: 'object' },
          expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          confirmationToken: { type: 'string' },
          callerToken,
        },
        ['proposal', 'expectedHash'],
      ),
    },
    {
      name: 'workflow_run_get',
      description: 'Read the current status and node checkpoints of an adaptive run-once Pipeline.',
      inputSchema: obj({ runId: { type: 'string' } }, ['runId']),
    },
    {
      name: 'daemon_start',
      description: `Start the detached Flowit Workflow daemon for ${adapterId} and wait for readiness.`,
      inputSchema: obj({}),
    },
  ].filter((tool: any) => mutationsEnabled || !isMutation(tool.name))
}

function isMutation(name: string): boolean {
  return new Set([
    'dispatch',
    'schedule_create',
    'schedule_cancel',
    'pipeline_create',
    'pipeline_run',
    'pipeline_status',
    'workflow_commit',
    'daemon_start',
  ]).has(name)
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`)
  return Number(value)
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${name} must be an array of strings`)
  }
  return value.map(item => item.trim()).filter(Boolean)
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function shutdown(): Promise<void> {
  await core.dispose()
  process.exit(0)
}
