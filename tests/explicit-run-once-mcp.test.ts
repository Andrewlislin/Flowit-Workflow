import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

interface JsonSchema {
  required?: string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  minItems?: number
  maxItems?: number
}

interface McpTool {
  name: string
  description?: string
  inputSchema?: JsonSchema
}

async function mcpResponse(
  adapterId: 'claude-code' | 'codex',
  requestValue: Record<string, unknown>,
  mutations = true,
): Promise<any> {
  const root = await mkdtemp(path.join(os.tmpdir(), `flowit-explicit-mcp-${adapterId}-`))
  const child = spawn(process.execPath, ['dist/mcp-server.js'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      FLOWIT_WORKFLOW_ADAPTER: adapterId,
      FLOWIT_WORKFLOW_MUTATIONS: mutations ? '1' : '0',
      FLOWIT_WORKFLOW_STORAGE_FILE: path.join(root, 'workflow.json'),
      FLOWIT_WORKFLOW_ROUTING_AUTHORITY_DIR: path.join(root, 'routing-authority'),
    },
  })
  try {
    return await request(child, requestValue)
  } finally {
    child.kill('SIGTERM')
    await close(child)
    await rm(root, { recursive: true, force: true })
  }
}

async function toolCatalog(
  adapterId: 'claude-code' | 'codex',
  mutations = true,
): Promise<McpTool[]> {
  const response = await mcpResponse(
    adapterId,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    },
    mutations,
  )
  assert.equal(response.error, undefined)
  assert.ok(Array.isArray(response.result?.tools))
  return response.result.tools as McpTool[]
}

test('Codex advertises a bounded dedicated run-once surface without historical Session input', async () => {
  const tools = await toolCatalog('codex')
  const start = tools.find(tool => tool.name === 'run_once_start')
  const get = tools.find(tool => tool.name === 'run_once_get')
  assert.ok(start)
  assert.ok(get)
  assert.match(start.description ?? '', /new, clean, dedicated Codex Session/i)
  assert.match(start.description ?? '', /requestId/i)
  assert.deepEqual(
    start.inputSchema?.required,
    ['requestId', 'name', 'goal', 'target', 'steps'],
  )
  const target = start.inputSchema?.properties?.target
  assert.deepEqual(target?.required, ['dedicatedCwd'])
  assert.equal(target?.properties?.sessionId, undefined)
  assert.equal(target?.properties?.adapterId, undefined)
  assert.equal(
    target?.properties?.execution?.properties?.requiredCapabilities,
    undefined,
  )
  const steps = start.inputSchema?.properties?.steps
  assert.equal(steps?.minItems, 2)
  assert.equal(steps?.maxItems, 6)
})

test('run_once_start is mutation-gated while run_once_get remains readable', async () => {
  const tools = await toolCatalog('codex', false)
  const names = new Set(tools.map(tool => tool.name))
  assert.equal(names.has('run_once_start'), false)
  assert.equal(names.has('run_once_get'), true)
})

test('Claude does not advertise the Codex-only explicit dedicated run-once surface', async () => {
  const tools = await toolCatalog('claude-code')
  const names = new Set(tools.map(tool => tool.name))
  assert.equal(names.has('run_once_start'), false)
  assert.equal(names.has('run_once_get'), false)

  const response = await mcpResponse('claude-code', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'run_once_start',
      arguments: {},
    },
  })
  assert.match(
    response.error?.message ?? '',
    /does not expose preflighted dedicated Session provisioning/i,
  )
})

test('Codex rejects relative dedicated working directories before Host provisioning', async () => {
  const response = await mcpResponse('codex', {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'run_once_start',
      arguments: {
        requestId: 'relative-cwd',
        name: 'test',
        goal: 'test explicit run-once input validation',
        target: {
          dedicatedCwd: 'relative/workspace',
        },
        steps: [
          { id: 'plan', prompt: 'plan' },
          { id: 'review', prompt: 'review' },
        ],
      },
    },
  })
  assert.match(response.error?.message ?? '', /dedicatedCwd must be an absolute path/i)
})

function request(
  child: ChildProcessWithoutNullStreams,
  value: Record<string, unknown>,
): Promise<any> {
  const id = value.id
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    const timer = setTimeout(() => {
      rl.close()
      reject(new Error(`MCP response timed out: ${stderr.trim()}`))
    }, 5_000)
    timer.unref?.()
    rl.on('line', line => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.id !== id) return
      clearTimeout(timer)
      rl.close()
      resolve(message)
    })
    child.once('error', error => {
      clearTimeout(timer)
      rl.close()
      reject(error)
    })
    child.stdin.write(`${JSON.stringify(value)}\n`)
  })
}

function close(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 2_000)
    timer.unref?.()
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
