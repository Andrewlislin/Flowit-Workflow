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

test('staggered consumers seed from an immutable migration baseline while legacy high-water advances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-cursor-seed-'))
  try {
    const bridgeA = bridgeStatePaths('workbuddy', root, 'consumer-a')
    const bridgeB = bridgeStatePaths('workbuddy', root, 'consumer-b')
    const bridgeBaseline = `${bridgeA.legacyCursorFile}.migration-baseline`
    await mkdir(path.dirname(bridgeA.legacyCursorFile), { recursive: true })
    await writeFile(bridgeA.legacyCursorFile, '17\n', 'utf8')
    assert.equal(await readBridgeCursor(bridgeA), 17)
    await writeBridgeCursor(bridgeA, 31)
    assert.equal((await readFile(bridgeA.legacyCursorFile, 'utf8')).trim(), '31')
    assert.equal(await readBridgeCursor(bridgeB), 17)
    assert.equal((await readFile(bridgeBaseline, 'utf8')).trim(), '17')

    const claudeRoot = path.join(root, 'claude')
    const claudeLegacy = path.join(claudeRoot, 'events.cursor')
    const claudeBaseline = `${claudeLegacy}.migration-baseline`
    const claudeA = new ClaudeEventCursor(
      path.join(claudeRoot, 'cursors', 'a.cursor'),
      claudeLegacy,
    )
    const claudeB = new ClaudeEventCursor(
      path.join(claudeRoot, 'cursors', 'b.cursor'),
      claudeLegacy,
    )
    await mkdir(path.dirname(claudeLegacy), { recursive: true })
    await writeFile(claudeLegacy, '23\n', 'utf8')
    assert.equal(await claudeA.read(), 23)
    await claudeA.write(41)
    assert.equal((await readFile(claudeLegacy, 'utf8')).trim(), '41')
    assert.equal(await claudeB.read(), 23)
    assert.equal((await readFile(claudeBaseline, 'utf8')).trim(), '23')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an absent legacy cursor still freezes a zero migration baseline before high-water advances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-cursor-zero-'))
  try {
    const bridgeA = bridgeStatePaths('workbuddy', root, 'consumer-a')
    const bridgeB = bridgeStatePaths('workbuddy', root, 'consumer-b')
    assert.equal(await readBridgeCursor(bridgeA), 0)
    await writeBridgeCursor(bridgeA, 9)
    assert.equal(await readBridgeCursor(bridgeB), 0)
    assert.equal(
      (await readFile(`${bridgeA.legacyCursorFile}.migration-baseline`, 'utf8')).trim(),
      '0',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
