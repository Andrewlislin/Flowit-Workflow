import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { terminateDetachedChild, waitForDaemonReadiness } from '../src/daemon-readiness.js'

async function delay(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)) }

test('readiness polling treats partial JSON as not-yet-published state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-ready-partial-'))
  const file = path.join(root, 'ready.json')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  try {
    await writeFile(file, '{"ready":', 'utf8')
    const waiting = waitForDaemonReadiness(child, file, 1_000)
    await delay(80)
    await writeFile(file, `${JSON.stringify({ ready: true, pid: child.pid })}\n`, 'utf8')
    const result = await waiting
    assert.equal(result.ready, true)
    assert.equal(result.pid, child.pid)
  } finally { await terminateDetachedChild(child, 100, 500); await rm(root, { recursive: true, force: true }) }
})

test('detached child that ignores SIGTERM is force-killed within the second deadline', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' })
  const pid = child.pid
  assert.ok(pid)
  await delay(50)
  assert.equal(await terminateDetachedChild(child, 75, 1_000), true)
  await delay(20)
  assert.throws(() => process.kill(pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH')
})
