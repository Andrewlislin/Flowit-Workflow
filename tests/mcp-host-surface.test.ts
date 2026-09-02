import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

interface McpTool {
  name: string
  description?: string
  inputSchema?: {
    properties?: Record<string, unknown>
  }
}

async function mcpResponse(
  adapterId: 'claude-code' | 'codex',
  requestValue: Record<string, unknown>,
): Promise<any> {
  const root = await mkdtemp(path.join(os.tmpdir(), `flowit-mcp-${adapterId}-`))
  const child = spawn(process.execPath, ['dist/mcp-server.js'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      FLOWIT_WORKFLOW_ADAPTER: adapterId,
      FLOWIT_WORKFLOW_MUTATIONS: '1',
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

async function toolCatalog(adapterId: 'claude-code' | 'codex'): Promise<McpTool[]> {
  const response = await mcpResponse(adapterId, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  })
  assert.equal(response.error, undefined)
  assert.ok(Array.isArray(response.result?.tools))
  return response.result.tools as McpTool[]
}

test('Claude keeps the trusted adaptive routing tool surface', async () => {
  const tools = await toolCatalog('claude-code')
  const names = new Set(tools.map(tool => tool.name))
  assert.equal(names.has('workflow_assess'), true)
  assert.equal(names.has('workflow_prepare'), true)
  assert.equal(names.has('workflow_commit'), true)
  const assess = tools.find(tool => tool.name === 'workflow_assess')
  assert.ok(assess?.inputSchema?.properties?.callerToken)
  assert.ok(assess?.inputSchema?.properties?.authorityToken)
})

test('Codex exposes advisory assessment without impossible Claude caller tokens', async () => {
  const tools = await toolCatalog('codex')
  const names = new Set(tools.map(tool => tool.name))
  assert.equal(names.has('workflow_assess'), true)
  assert.equal(names.has('workflow_prepare'), false)
  assert.equal(names.has('workflow_commit'), false)
  const assess = tools.find(tool => tool.name === 'workflow_assess')
  assert.match(assess?.description ?? '', /advisory/i)
  assert.equal(assess?.inputSchema?.properties?.callerToken, undefined)
  assert.equal(assess?.inputSchema?.properties?.authorityToken, undefined)
  assert.equal(names.has('dispatch'), true)
  assert.equal(names.has('pipeline_create'), true)
})

test('Codex rejects hidden adaptive prepare calls before Host startup', async () => {
  const response = await mcpResponse('codex', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'workflow_prepare',
      arguments: {},
    },
  })
  assert.match(response.error?.message ?? '', /trusted current-turn authority channel/i)
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
