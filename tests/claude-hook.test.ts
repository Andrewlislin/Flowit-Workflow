import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ingestClaudeHook } from '../src/claude/hook.js'
import {
  ClaudeEventCursor,
  ClaudeEventJournal,
  ClaudeSessionCatalog,
  type ClaudeStatePaths,
} from '../src/claude/state.js'
import type { AgentEvent } from '../src/core/types.js'

function paths(root: string): ClaudeStatePaths {
  return {
    catalogFile: path.join(root, 'sessions.json'),
    eventJournalFile: path.join(root, 'events.jsonl'),
    eventCursorFile: path.join(root, 'events.cursor'),
  }
}

function event(id: string): AgentEvent {
  return {
    adapterId: 'claude-code',
    sessionId: 's1',
    kind: 'turn_completed',
    eventId: id,
    at: new Date().toISOString(),
  }
}

test('Claude hooks build a session catalog and durable event journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-claude-hook-'))
  const state = paths(root)
  try {
    await ingestClaudeHook(
      {
        session_id: 's1',
        hook_event_name: 'SessionStart',
        cwd: '/repo',
        session_title: 'Research',
      },
      state,
    )
    await ingestClaudeHook(
      {
        session_id: 's1',
        hook_event_name: 'Stop',
        last_assistant_message: 'research result',
      },
      state,
    )
    await ingestClaudeHook({ session_id: 's1', hook_event_name: 'SessionEnd' }, state)
    const session = await new ClaudeSessionCatalog(state.catalogFile).get('s1')
    assert.equal(session?.status, 'ended')
    assert.equal(session?.lastAssistantMessage, 'research result')
    const journal = await new ClaudeEventJournal(state.eventJournalFile).readAfter(0)
    assert.deepEqual(
      journal.events.map(row => row.kind),
      ['session_started', 'turn_completed', 'session_ended'],
    )
    const cursor = new ClaudeEventCursor(state.eventCursorFile)
    await cursor.write(2)
    assert.equal(await cursor.read(), 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude event journal does not advance across a truncated tail and can resume after repair', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-claude-tail-'))
  const state = paths(root)
  const first = event('event-1')
  const second = event('event-2')
  const journal = new ClaudeEventJournal(state.eventJournalFile)
  try {
    const secondLine = JSON.stringify(second)
    await writeFile(
      state.eventJournalFile,
      `${JSON.stringify(first)}\n${secondLine.slice(0, Math.max(1, secondLine.length - 8))}`,
      'utf8',
    )

    const initial = await journal.readAfter(0)
    assert.deepEqual(initial.events.map(row => row.eventId), ['event-1'])
    assert.equal(initial.nextOffset, 1)
    await assert.rejects(journal.append(event('event-3')), /incomplete tail|recovered/i)

    await writeFile(
      state.eventJournalFile,
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      'utf8',
    )
    const recovered = await journal.readAfter(1)
    assert.deepEqual(recovered.events.map(row => row.eventId), ['event-2'])
    assert.equal(recovered.nextOffset, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude event journal stops before a malformed complete record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-claude-malformed-'))
  const state = paths(root)
  const journal = new ClaudeEventJournal(state.eventJournalFile)
  try {
    await writeFile(
      state.eventJournalFile,
      `${JSON.stringify(event('event-1'))}\n{not-json}\n${JSON.stringify(event('event-3'))}\n`,
      'utf8',
    )
    const prefix = await journal.readAfter(0)
    assert.deepEqual(prefix.events.map(row => row.eventId), ['event-1'])
    assert.equal(prefix.nextOffset, 1)
    await assert.rejects(journal.readAfter(1), /malformed record at line 2|cursor advancement is blocked/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
