import os from 'node:os'
import path from 'node:path'
import { FlowitOrchestrationCore } from './core/runtime.js'
import type { AgentAdapter } from './core/types.js'
import { ClaudeCodeAgentAdapter, CLAUDE_CODE_ADAPTER_ID } from './adapters/claude-code.js'
import { OpenCodeAgentAdapter, OPENCODE_ADAPTER_ID } from './adapters/opencode.js'
import { CodexAgentAdapter, CODEX_ADAPTER_ID } from './adapters/codex.js'
import { WorkBuddyAgentAdapter, WORKBUDDY_ADAPTER_ID } from './adapters/workbuddy.js'
import { DoubaoOfficeAgentAdapter, DOUBAO_OFFICE_ADAPTER_ID } from './adapters/doubao-office.js'

export const BUILT_IN_ADAPTER_IDS = [
  CLAUDE_CODE_ADAPTER_ID,
  OPENCODE_ADAPTER_ID,
  CODEX_ADAPTER_ID,
  WORKBUDDY_ADAPTER_ID,
  DOUBAO_OFFICE_ADAPTER_ID,
] as const
export type BuiltInAdapterId = typeof BUILT_IN_ADAPTER_IDS[number]
export interface ConfiguredRuntimeOptions { defaultAdapterId?: BuiltInAdapterId; adapterIds?: BuiltInAdapterId[]; activeWorkers?: boolean; storageFile?: string; minimumIntervalSeconds?: number; maxRunHistory?: number }

export function createConfiguredRuntime(options: ConfiguredRuntimeOptions = {}): FlowitOrchestrationCore {
  const defaultAdapterId = options.defaultAdapterId ?? envAdapter() ?? CLAUDE_CODE_ADAPTER_ID
  const ids = options.adapterIds ?? envAdapters() ?? [defaultAdapterId]
  const adapters = [...new Set(ids)].map(createBuiltInAdapter)
  if (!adapters.some(adapter => adapter.id === defaultAdapterId)) adapters.unshift(createBuiltInAdapter(defaultAdapterId))
  return new FlowitOrchestrationCore({
    storageFile: options.storageFile ?? process.env.FLOWIT_WORKFLOW_STORAGE_FILE ?? defaultStorage(defaultAdapterId),
    defaultAdapterId,
    minimumIntervalSeconds: options.minimumIntervalSeconds ?? 60,
    maxRunHistory: options.maxRunHistory ?? 500,
    activeWorkers: options.activeWorkers ?? true,
  }, adapters)
}

export function createBuiltInAdapter(id: BuiltInAdapterId): AgentAdapter {
  switch (id) {
    case CLAUDE_CODE_ADAPTER_ID:
      return new ClaudeCodeAgentAdapter({
        ...(process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT ? { pluginDir: process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT } : {}),
        ...(process.env.FLOWIT_WORKFLOW_CLAUDE_ALLOW_LIVE_RESUME === '1' ? { allowResumeLiveSession: true } : {}),
      })
    case OPENCODE_ADAPTER_ID:
      return new OpenCodeAgentAdapter({ ...(process.env.FLOWIT_WORKFLOW_OPENCODE_URL ? { baseUrl: process.env.FLOWIT_WORKFLOW_OPENCODE_URL } : {}) })
    case CODEX_ADAPTER_ID:
      return new CodexAgentAdapter({ executable: process.env.FLOWIT_WORKFLOW_CODEX_BIN ?? 'codex' })
    case WORKBUDDY_ADAPTER_ID: {
      const dispatchCommand = parseCommand(process.env.FLOWIT_WORKFLOW_WORKBUDDY_DRIVER)
      return new WorkBuddyAgentAdapter({
        ...(dispatchCommand ? { dispatchCommand } : {}),
        mode: dispatchCommand ? 'managed-agent-driver' : 'desktop-bridge',
      })
    }
    case DOUBAO_OFFICE_ADAPTER_ID:
      return new DoubaoOfficeAgentAdapter()
    default:
      throw new Error(`unsupported built-in adapter: ${String(id)}`)
  }
}

export function isBuiltInAdapterId(value: unknown): value is BuiltInAdapterId {
  return typeof value === 'string' && (BUILT_IN_ADAPTER_IDS as readonly string[]).includes(value)
}

export function requireBuiltInAdapterId(value: unknown, field = 'adapter'): BuiltInAdapterId {
  if (!isBuiltInAdapterId(value)) throw new Error(`${field} must be one of: ${BUILT_IN_ADAPTER_IDS.join(', ')}`)
  return value
}

function envAdapter(): BuiltInAdapterId | undefined {
  const value = process.env.FLOWIT_WORKFLOW_ADAPTER
  return isBuiltInAdapterId(value) ? value : undefined
}
function envAdapters(): BuiltInAdapterId[] | undefined {
  const value = process.env.FLOWIT_WORKFLOW_ADAPTERS
  if (!value) return undefined
  const result = value.split(',').map(item => item.trim()).filter(isBuiltInAdapterId)
  return result.length ? result : undefined
}
function parseCommand(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string') && parsed.length) return parsed
  } catch {}
  return value.split(/\s+/).filter(Boolean)
}
function defaultStorage(adapterId: string): string { return path.join(os.homedir(), '.flowit-workflow', adapterId, 'workflow.json') }
