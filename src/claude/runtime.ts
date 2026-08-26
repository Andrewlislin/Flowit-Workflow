import os from 'node:os'
import path from 'node:path'
import { FlowitOrchestrationCore } from '../core/runtime.js'
import { ClaudeCodeAgentAdapter, CLAUDE_CODE_ADAPTER_ID, type ClaudeCodeAdapterConfig } from '../adapters/claude-code.js'

export interface ClaudeCodeRuntimeConfig { storageFile?: string; minimumIntervalSeconds?: number; maxRunHistory?: number; adapter?: ClaudeCodeAdapterConfig; activeWorkers?: boolean }
export function defaultClaudeWorkflowStorageFile(): string { return path.join(os.homedir(), '.flowit-workflow', 'claude', 'workflow.json') }
export function createClaudeCodeRuntime(config: ClaudeCodeRuntimeConfig = {}): FlowitOrchestrationCore {
  const adapter = new ClaudeCodeAgentAdapter({ ...(config.adapter ?? {}), ...(config.adapter?.allowResumeLiveSession === undefined && process.env.FLOWIT_WORKFLOW_CLAUDE_ALLOW_LIVE_RESUME === '1' ? { allowResumeLiveSession: true } : {}) })
  return new FlowitOrchestrationCore({ storageFile: config.storageFile ?? defaultClaudeWorkflowStorageFile(), defaultAdapterId: CLAUDE_CODE_ADAPTER_ID, minimumIntervalSeconds: config.minimumIntervalSeconds ?? 60, maxRunHistory: config.maxRunHistory ?? 500, activeWorkers: config.activeWorkers ?? true }, [adapter])
}
