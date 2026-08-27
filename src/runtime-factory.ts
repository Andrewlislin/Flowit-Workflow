import os from 'node:os'
import path from 'node:path'
import { FlowitOrchestrationCore } from './core/runtime.js'
import type { AgentAdapter } from './core/types.js'
import { ClaudeCodeAgentAdapter, CLAUDE_CODE_ADAPTER_ID } from './adapters/claude-code.js'
import { OpenCodeAgentAdapter, OPENCODE_ADAPTER_ID } from './adapters/opencode.js'
import { CodexAgentAdapter, CODEX_ADAPTER_ID } from './adapters/codex.js'
import { WorkBuddyAgentAdapter, WORKBUDDY_ADAPTER_ID } from './adapters/workbuddy.js'
import { DoubaoOfficeAgentAdapter, DOUBAO_OFFICE_ADAPTER_ID } from './adapters/doubao-office.js'

export const BUILT_IN_ADAPTER_IDS = [CLAUDE_CODE_ADAPTER_ID, OPENCODE_ADAPTER_ID, CODEX_ADAPTER_ID, WORKBUDDY_ADAPTER_ID, DOUBAO_OFFICE_ADAPTER_ID] as const
export type BuiltInAdapterId = typeof BUILT_IN_ADAPTER_IDS[number]
export interface ConfiguredRuntimeOptions {
  defaultAdapterId?: BuiltInAdapterId
  adapterIds?: BuiltInAdapterId[]
  activeWorkers?: boolean
  storageFile?: string
  legacyStorageFiles?: string[]
  instanceId?: string
  minimumIntervalSeconds?: number
  maxRunHistory?: number
  maxTerminalReceipts?: number
  terminalReceiptRetentionMs?: number
  leaseDurationMs?: number
  retryDelayMs?: number
  maxPipelineAttempts?: number
  maxScheduleAttempts?: number
}
export interface ResolvedRuntimeOptions {
  defaultAdapterId: BuiltInAdapterId
  adapterIds: BuiltInAdapterId[]
  activeWorkers: boolean
  storageFile: string
  legacyStorageFiles: string[]
  instanceId: string
  minimumIntervalSeconds: number
  maxRunHistory: number
  maxTerminalReceipts: number
  terminalReceiptRetentionMs: number
  leaseDurationMs: number
  retryDelayMs: number
  maxPipelineAttempts: number
  maxScheduleAttempts: number
}

export function resolveConfiguredRuntime(options: ConfiguredRuntimeOptions = {}): ResolvedRuntimeOptions {
  const defaultAdapterId = options.defaultAdapterId ?? envAdapter() ?? CLAUDE_CODE_ADAPTER_ID
  const adapterIds = [...new Set(options.adapterIds ?? envAdapters() ?? [defaultAdapterId])]
  if (!adapterIds.includes(defaultAdapterId)) adapterIds.unshift(defaultAdapterId)
  const instanceId = normalizeInstanceId(options.instanceId ?? process.env.FLOWIT_WORKFLOW_INSTANCE_ID ?? 'default')
  const explicitStorage = options.storageFile ?? process.env.FLOWIT_WORKFLOW_STORAGE_FILE
  const storageFile = path.resolve(explicitStorage ?? defaultStoragePath(instanceId))
  const explicitLegacy = options.legacyStorageFiles ?? envLegacyStorageFiles()
  const legacyStorageFiles = explicitLegacy ?? (!explicitStorage && instanceId === 'default' ? BUILT_IN_ADAPTER_IDS.map(legacyDefaultStoragePath) : [])
  return {
    defaultAdapterId, adapterIds, instanceId, storageFile, legacyStorageFiles: [...new Set(legacyStorageFiles.map(value => path.resolve(value)))],
    activeWorkers: options.activeWorkers ?? true,
    minimumIntervalSeconds: options.minimumIntervalSeconds ?? 60,
    maxRunHistory: options.maxRunHistory ?? 500,
    maxTerminalReceipts: options.maxTerminalReceipts ?? 100_000,
    terminalReceiptRetentionMs: options.terminalReceiptRetentionMs ?? 90 * 24 * 60 * 60 * 1_000,
    leaseDurationMs: options.leaseDurationMs ?? 30_000,
    retryDelayMs: options.retryDelayMs ?? 5_000,
    maxPipelineAttempts: options.maxPipelineAttempts ?? 3,
    maxScheduleAttempts: options.maxScheduleAttempts ?? 3,
  }
}

export function createConfiguredRuntime(options: ConfiguredRuntimeOptions = {}): FlowitOrchestrationCore {
  const resolved = resolveConfiguredRuntime(options); const adapters = resolved.adapterIds.map(createBuiltInAdapter)
  return new FlowitOrchestrationCore({
    storageFile: resolved.storageFile, legacyStorageFiles: resolved.legacyStorageFiles, defaultAdapterId: resolved.defaultAdapterId,
    minimumIntervalSeconds: resolved.minimumIntervalSeconds, maxRunHistory: resolved.maxRunHistory,
    maxTerminalReceipts: resolved.maxTerminalReceipts, terminalReceiptRetentionMs: resolved.terminalReceiptRetentionMs,
    activeWorkers: resolved.activeWorkers, leaseDurationMs: resolved.leaseDurationMs, retryDelayMs: resolved.retryDelayMs,
    maxPipelineAttempts: resolved.maxPipelineAttempts, maxScheduleAttempts: resolved.maxScheduleAttempts,
  }, adapters)
}

export function createBuiltInAdapter(id: BuiltInAdapterId): AgentAdapter {
  switch (id) {
    case CLAUDE_CODE_ADAPTER_ID: return new ClaudeCodeAgentAdapter({ ...(process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT ? { pluginDir: process.env.FLOWIT_WORKFLOW_PLUGIN_ROOT } : {}), ...(process.env.FLOWIT_WORKFLOW_CLAUDE_ALLOW_LIVE_RESUME === '1' ? { allowResumeLiveSession: true } : {}) })
    case OPENCODE_ADAPTER_ID: { const baseUrl = process.env.FLOWIT_WORKFLOW_OPENCODE_URL; if (!baseUrl) throw new Error('FLOWIT_WORKFLOW_OPENCODE_URL is required for the OpenCode adapter'); return new OpenCodeAgentAdapter({ baseUrl }) }
    case CODEX_ADAPTER_ID: return new CodexAgentAdapter({ executable: process.env.FLOWIT_WORKFLOW_CODEX_BIN ?? 'codex' })
    case WORKBUDDY_ADAPTER_ID: { const dispatchCommand = parseCommand(process.env.FLOWIT_WORKFLOW_WORKBUDDY_DRIVER); return new WorkBuddyAgentAdapter({ ...(dispatchCommand ? { dispatchCommand } : {}), mode: dispatchCommand ? 'managed-agent-driver' : 'desktop-bridge' }) }
    case DOUBAO_OFFICE_ADAPTER_ID: return new DoubaoOfficeAgentAdapter()
    default: throw new Error(`unsupported built-in adapter: ${String(id)}`)
  }
}

export function defaultStoragePath(instanceId: string): string { return path.join(os.homedir(), '.flowit-workflow', 'instances', normalizeInstanceId(instanceId), 'workflow.json') }
export function legacyDefaultStoragePath(adapterId: string): string { return path.join(os.homedir(), '.flowit-workflow', adapterId, 'workflow.json') }
export function isBuiltInAdapterId(value: unknown): value is BuiltInAdapterId { return typeof value === 'string' && (BUILT_IN_ADAPTER_IDS as readonly string[]).includes(value) }
export function requireBuiltInAdapterId(value: unknown, field = 'adapter'): BuiltInAdapterId { if (!isBuiltInAdapterId(value)) throw new Error(`${field} must be one of: ${BUILT_IN_ADAPTER_IDS.join(', ')}`); return value }
function envAdapter(): BuiltInAdapterId | undefined { const value = process.env.FLOWIT_WORKFLOW_ADAPTER; return isBuiltInAdapterId(value) ? value : undefined }
function envAdapters(): BuiltInAdapterId[] | undefined { const value = process.env.FLOWIT_WORKFLOW_ADAPTERS; if (!value) return undefined; const result = value.split(',').map(item => item.trim()).filter(isBuiltInAdapterId); return result.length ? result : undefined }
function envLegacyStorageFiles(): string[] | undefined { const value = process.env.FLOWIT_WORKFLOW_LEGACY_STORAGE_FILES; if (!value?.trim()) return undefined; const rows = value.split(path.delimiter).map(item => item.trim()).filter(Boolean); return rows.length ? rows : undefined }
function parseCommand(value: string | undefined): string[] | undefined { if (!value?.trim()) return undefined; try { const parsed = JSON.parse(value) as unknown; if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string') && parsed.length) return parsed } catch {} return value.split(/\s+/).filter(Boolean) }
function normalizeInstanceId(value: string): string { const normalized = value.trim(); if (!normalized) throw new Error('orchestration instanceId must be non-empty'); if (!/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error('orchestration instanceId may contain only letters, numbers, dot, underscore, and hyphen'); return normalized }
