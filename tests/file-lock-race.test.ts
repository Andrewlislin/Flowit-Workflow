import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withGenerationFileLock } from '@coaseedge/flowit-core/internal/file-lock'

function deadPid(): number {
  return 2_147_483_647
}

test('generation file lock serializes contenders after stale recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-file-lock-race-'))
  const file = path.join(root, 'state.json')
  const lockDir = `${file}.lock`
  let active = 0
  let maxActive = 0
  try {
    await mkdir(lockDir, { recursive: true })
    await writeFile(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ version: 1, token: 'dead', pid: deadPid(), acquiredAt: new Date().toISOString() })}\n`,
      'utf8',
    )
    const operation = () =>
      withGenerationFileLock(file, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 40))
        active -= 1
      })
    await Promise.all([operation(), operation()])
    assert.equal(maxActive, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
