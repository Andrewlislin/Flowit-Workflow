import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withGenerationFileLock } from '@coaseedgeltd/flowit-core/internal/file-lock'

function deadPid(): number {
  return 2_147_483_647
}

async function ageLock(lockDir: string): Promise<void> {
  const old = new Date(Date.now() - 60_000)
  await utimes(lockDir, old, old)
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

test('generation file lock fails closed on an unknown owner version regardless of age', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-file-lock-version-'))
  const file = path.join(root, 'state.json')
  const lockDir = `${file}.lock`
  let entered = false
  try {
    await mkdir(lockDir, { recursive: true })
    await writeFile(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ version: 2, token: 'future', pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      'utf8',
    )
    await ageLock(lockDir)
    await assert.rejects(
      withGenerationFileLock(
        file,
        async () => {
          entered = true
        },
        200,
      ),
      /unknown owner version 2|manual recovery/i,
    )
    assert.equal(entered, false)
    await access(lockDir)
    const owner = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8')) as {
      version: number
    }
    assert.equal(owner.version, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generation file lock fails closed on malformed published owner metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-file-lock-malformed-'))
  const file = path.join(root, 'state.json')
  const lockDir = `${file}.lock`
  let entered = false
  try {
    await mkdir(lockDir, { recursive: true })
    await writeFile(path.join(lockDir, 'owner.json'), '{not-json\n', 'utf8')
    await ageLock(lockDir)
    await assert.rejects(
      withGenerationFileLock(
        file,
        async () => {
          entered = true
        },
        200,
      ),
      /malformed owner metadata|manual recovery/i,
    )
    assert.equal(entered, false)
    await access(lockDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
