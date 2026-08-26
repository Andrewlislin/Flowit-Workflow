import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ingestClaudeHook } from '../src/claude/hook.js'
import { ClaudeEventCursor, ClaudeEventJournal, ClaudeSessionCatalog, type ClaudeStatePaths } from '../src/claude/state.js'
function paths(root: string): ClaudeStatePaths { return { catalogFile: path.join(root, 'sessions.json'), eventJournalFile: path.join(root, 'events.jsonl'), eventCursorFile: path.join(root, 'events.cursor') } }
test('Claude hooks build a session catalog and durable event journal', async () => { const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-claude-hook-')); const state = paths(root); try { await ingestClaudeHook({ session_id: 's1', hook_event_name: 'SessionStart', cwd: '/repo', session_title: 'Research' }, state); await ingestClaudeHook({ session_id: 's1', hook_event_name: 'Stop', last_assistant_message: 'research result' }, state); await ingestClaudeHook({ session_id: 's1', hook_event_name: 'SessionEnd' }, state); const session = await new ClaudeSessionCatalog(state.catalogFile).get('s1'); assert.equal(session?.status, 'ended'); assert.equal(session?.lastAssistantMessage, 'research result'); const journal = await new ClaudeEventJournal(state.eventJournalFile).readAfter(0); assert.deepEqual(journal.events.map(event => event.kind), ['session_started','turn_completed','session_ended']); const cursor = new ClaudeEventCursor(state.eventCursorFile); await cursor.write(2); assert.equal(await cursor.read(), 2) } finally { await rm(root, { recursive: true, force: true }) } })
