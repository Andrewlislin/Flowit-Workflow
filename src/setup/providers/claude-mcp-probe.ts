import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { DoctorCheck } from '../types.js'
import type { ClaudeCodeState } from './claude-code-state.js'

const PROBE_TIMEOUT_MS = 4_000

export async function probeInstalledClaudeMcp(
  state: ClaudeCodeState,
): Promise<DoctorCheck> {
  const installed = state.files.find(file => file.relativePath === '.mcp.json')
  if (!installed?.current.content) {
    return {
      id: 'claude-mcp-local-probe',
      status: 'error',
      summary: 'Installed Claude Flowit MCP configuration is missing',
      repairable: true,
    }
  }

  let value: unknown
  try {
    value = JSON.parse(installed.current.content)
  } catch (error: unknown) {
    return {
      id: 'claude-mcp-local-probe',
      status: 'error',
      summary: 'Installed Claude Flowit MCP configuration is invalid JSON',
      detail: error instanceof Error ? error.message : String(error),
      repairable: true,
    }
  }
  const launch = mcpLaunch(value)
  if (!launch) {
    return {
      id: 'claude-mcp-local-probe',
      status: 'error',
      summary: 'Installed Claude Flowit MCP configuration has no usable orchestration launch command',
      repairable: true,
    }
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'flowit-claude-mcp-doctor-'))
  try {
    const response = await probe(launch, scratch)
    const tools = Array.isArray(response.tools) ? response.tools : []
    const names = tools.flatMap(tool =>
      isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [],
    )
    if (!names.includes('workflow_assess')) {
      return {
        id: 'claude-mcp-local-probe',
        status: 'error',
        summary: 'Installed Claude Flowit MCP server started but did not expose workflow_assess',
        detail: `Visible tools: ${names.join(', ') || 'none'}`,
        repairable: false,
      }
    }
    return {
      id: 'claude-mcp-local-probe',
      status: 'ok',
      summary: `Installed Claude Flowit MCP server initialized locally and exposed ${names.length} tools`,
    }
  } catch (error: unknown) {
    return {
      id: 'claude-mcp-local-probe',
      status: 'error',
      summary: 'Installed Claude Flowit MCP server failed a local initialize/tools probe',
      detail: error instanceof Error ? error.message : String(error),
      repairable: false,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

interface McpLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

function mcpLaunch(value: unknown): McpLaunch | undefined {
  if (!isRecord(value) || !isRecord(value.mcpServers)) return undefined
  const server = value.mcpServers.orchestration
  if (!isRecord(server) || typeof server.command !== 'string') return undefined
  if (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string')) return undefined
  const environment: Record<string, string> = {}
  if (isRecord(server.env)) {
    for (const [key, candidate] of Object.entries(server.env)) {
      if (typeof candidate === 'string') environment[key] = candidate
    }
  }
  return {
    command: server.command,
    args: server.args as string[],
    env: environment,
  }
}

function probe(
  launch: McpLaunch,
  scratch: string,
): Promise<{ tools: unknown[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...launch.env,
        HOME: scratch,
        USERPROFILE: scratch,
        FLOWIT_WORKFLOW_MUTATIONS: '0',
        FLOWIT_WORKFLOW_CLAUDE_MUTATIONS: '0',
        FLOWIT_WORKFLOW_ROUTING_AUTHORITY_DIR: path.join(scratch, 'routing-authority'),
        FLOWIT_WORKFLOW_STORAGE_FILE: path.join(scratch, 'workflow.json'),
        FLOWIT_WORKFLOW_CLAUDE_ACTIVATION_FILE: path.join(scratch, 'activation.json'),
      },
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    const results = new Map<number, any>()
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rl.close()
      child.kill('SIGTERM')
      if (error) reject(error)
      else resolve({ tools: results.get(2)?.result?.tools ?? [] })
    }
    const timer = setTimeout(() => {
      finish(new Error(`MCP probe timed out${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    }, PROBE_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', error => finish(error))
    child.once('close', code => {
      if (!settled && code !== 0) {
        finish(new Error(`MCP probe process exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
      }
    })
    rl.on('line', line => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (typeof message.id !== 'number') return
      results.set(message.id, message)
      if (message.id === 1) {
        if (message.error) {
          finish(new Error(`initialize failed: ${message.error.message ?? JSON.stringify(message.error)}`))
          return
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
        return
      }
      if (message.id === 2) {
        if (message.error) {
          finish(new Error(`tools/list failed: ${message.error.message ?? JSON.stringify(message.error)}`))
          return
        }
        finish()
      }
    })
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'flowit-doctor', version: '1' },
      },
    })}\n`)
  })
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
