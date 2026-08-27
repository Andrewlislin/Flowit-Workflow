import { spawn } from 'node:child_process'
import type { AgentDispatchRequest, AgentDispatchResult } from '@coaseedge/flowit-core'
import { FileBridgeAgentAdapter, type FileBridgeAdapterConfig } from '@coaseedge/flowit-adapter-file-bridge'

export const WORKBUDDY_ADAPTER_ID = 'workbuddy'
export interface WorkBuddyAdapterConfig extends Omit<FileBridgeAdapterConfig, 'adapterId'> { dispatchCommand?: string[]; mode?: 'desktop-bridge' | 'managed-agent-driver' }

export class WorkBuddyAgentAdapter extends FileBridgeAgentAdapter {
  private readonly dispatchCommand: string[] | undefined; readonly mode: 'desktop-bridge' | 'managed-agent-driver'
  constructor(config: WorkBuddyAdapterConfig = {}) { super({ adapterId: WORKBUDDY_ADAPTER_ID, ...config, capabilities: { coldResume: Boolean(config.dispatchCommand), liveDispatch: false, skillBinding: true, contextReference: 'summary', eventSubscription: true, ...config.capabilities } }); this.dispatchCommand = config.dispatchCommand; this.mode = config.mode ?? (config.dispatchCommand ? 'managed-agent-driver' : 'desktop-bridge') }
  override async dispatch(request: AgentDispatchRequest, signal?: AbortSignal): Promise<AgentDispatchResult> { if (!this.dispatchCommand?.length) return super.dispatch(request, signal); const result = await runJsonCommand(this.dispatchCommand, { version: 1, adapterId: this.id, request }, signal); const missing = request.skills.filter(skill => !result.loadedSkills.includes(skill)); if (missing.length) throw new Error(`WorkBuddy driver did not attest requested Skill bindings: ${missing.join(', ')}`); await this.recordResult(request, result); return result }
}

async function runJsonCommand(command: string[], input: unknown, signal?: AbortSignal): Promise<AgentDispatchResult> {
  if (!command[0]) throw new Error('WorkBuddy dispatchCommand is empty')
  return await new Promise((resolve, reject) => { const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe','pipe','pipe'], env: process.env, ...(signal ? { signal } : {}) }); let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += String(chunk).slice(0, Math.max(0, 4_000_000 - stdout.length)) }); child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, Math.max(0, 1_000_000 - stderr.length)) }); child.on('error', reject); child.on('close', code => { if (code !== 0) { reject(new Error(`WorkBuddy driver exited with ${code}: ${stderr.trim() || stdout.trim()}`)); return } try { const value = JSON.parse(stdout.trim()) as AgentDispatchResult; if (!value || typeof value.sessionId !== 'string' || !Array.isArray(value.loadedSkills) || !Array.isArray(value.referencedSessions)) throw new Error('invalid WorkBuddy driver result'); resolve(value) } catch (error: unknown) { reject(error) } }); child.stdin.end(`${JSON.stringify(input)}\n`) })
}
