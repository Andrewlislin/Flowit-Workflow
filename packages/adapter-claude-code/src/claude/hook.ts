import { randomUUID } from 'node:crypto'
import type { AgentEventKind } from '@coaseedgeltd/flowit-core'
import { ClaudeEventJournal, ClaudeSessionCatalog, defaultClaudeStatePaths, type ClaudeStatePaths } from './state.js'

export interface ClaudeHookInput { session_id: string; transcript_path?: string; cwd?: string; hook_event_name: string; session_title?: string; source?: string; last_assistant_message?: string; error?: string; error_details?: string; task_id?: string; task_subject?: string; task_description?: string; agent_id?: string; agent_type?: string; teammate_name?: string }

export async function ingestClaudeHook(input: ClaudeHookInput, paths: ClaudeStatePaths = defaultClaudeStatePaths()): Promise<void> {
  if (!input.session_id?.trim()) throw new Error('Claude hook input requires session_id')
  const now = new Date().toISOString(); const catalog = new ClaudeSessionCatalog(paths.catalogFile); const existing = await catalog.get(input.session_id)
  const status = input.hook_event_name === 'SessionEnd' ? 'ended' as const : input.hook_event_name === 'SessionStart' ? 'live' as const : existing?.status ?? 'live' as const
  await catalog.upsert({ adapterId: 'claude-code', sessionId: input.session_id, ...(input.session_title?.trim() ? { name: input.session_title.trim() } : existing?.name ? { name: existing.name } : {}), ...(input.cwd?.trim() ? { cwd: input.cwd } : existing?.cwd ? { cwd: existing.cwd } : {}), status, updatedAt: now, ...(input.transcript_path ? { transcriptPath: input.transcript_path } : existing?.transcriptPath ? { transcriptPath: existing.transcriptPath } : {}), ...(input.last_assistant_message ? { lastAssistantMessage: input.last_assistant_message } : existing?.lastAssistantMessage ? { lastAssistantMessage: existing.lastAssistantMessage } : {}), lastHookEvent: input.hook_event_name })
  const kind = hookEventKind(input.hook_event_name); if (!kind) return
  const metadata: Record<string, unknown> = {}; for (const key of ['source','error','error_details','task_id','task_subject','task_description','agent_id','agent_type','teammate_name'] as const) { const value = input[key]; if (value !== undefined) metadata[key] = value }
  if (input.last_assistant_message) metadata.lastAssistantMessage = input.last_assistant_message
  await new ClaudeEventJournal(paths.eventJournalFile).append({ adapterId: 'claude-code', sessionId: input.session_id, kind, eventId: randomUUID(), at: now, ...(Object.keys(metadata).length > 0 ? { metadata } : {}) })
}
function hookEventKind(event: string): AgentEventKind | undefined { switch (event) { case 'SessionStart': return 'session_started'; case 'SessionEnd': return 'session_ended'; case 'Stop': return 'turn_completed'; case 'StopFailure': return 'turn_failed'; case 'TaskCompleted': return 'task_completed'; case 'SubagentStop': return 'subagent_completed'; default: return undefined } }
