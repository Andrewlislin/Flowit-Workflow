import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  bridgeStatePaths,
  readBridgeCursor,
  writeBridgeCursor,
} from '../src/bridge/state.js'
import { ClaudeEventCursor, defaultClaudeStatePaths } from '../src/claude/state.js'

test('workflow consumers use independent Claude and bridge cursors', () => {
  const claudeA = defaultClaudeStatePaths('/tmp/workflow-a.json')
  const claudeB = defaultClaudeStatePaths('/tmp/workflow-b.json')
  assert.equal(claudeA.eventJournalFile, claudeB.eventJournalFile)
  assert.notEqual(claudeA.eventCursorFile, claudeB.eventCursorFile)

  const bridgeA = bridgeStatePaths('workbuddy', '/tmp/bridge', '/tmp/workflow-a.json')
  const bridgeB = bridgeStatePaths('workbuddy', '/tmp/bridge', '/tmp/workflow-b.json')
  assert.equal(bridgeA.eventsFile, bridgeB.eventsFile)
  assert.notEqual(bridgeA.cursorFile, bridgeB.cursorFile)
})

test('new consumer cursors seed once from the legacy shared cursor and advance its high-water', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-cursor-seed-'))
  try {
    const bridge = bridgeStatePaths('workbuddy', root, 'consumer-a')
    await mkdir(path.dirname(bridge.legacyCursorFile), { recursive: true })
    await writeFile(bridge.legacyCursorFile, '17\n', 'utf8')
    assert.equal(await readBridgeCursor(bridge), 17)
    await writeBridgeCursor(bridge, 31)
    assert.equal((await readFile(bridge.legacyCursorFile, 'utf8')).trim(), '31')
    await writeBridgeCursor(bridge, 22)
    assert.equal((await readFile(bridge.legacyCursorFile, 'utf8')).trim(), '31')

    const claudePrimary = path.join(root, 'claude', 'cursors', 'a.cursor')
    const claudeLegacy = path.join(root, 'claude', 'events.cursor')
    await mkdir(path.dirname(claudeLegacy), { recursive: true })
    await writeFile(claudeLegacy, '23\n', 'utf8')
    const claudeCursor = new ClaudeEventCursor(claudePrimary, claudeLegacy)
    assert.equal(await claudeCursor.read(), 23)
    await claudeCursor.write(41)
    assert.equal((await readFile(claudeLegacy, 'utf8')).trim(), '41')
    await claudeCursor.write(29)
    assert.equal((await readFile(claudeLegacy, 'utf8')).trim(), '41')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
