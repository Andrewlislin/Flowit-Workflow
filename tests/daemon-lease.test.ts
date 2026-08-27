import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireDaemonLease, canonicalStorageIdentity } from '../src/daemon-lease.js'

interface ChildResult { code: number | null; stdout: string; stderr: string }

function runContender(fixture: string, storage: string, leaseRoot: string, gate: string, instanceId: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, storage, leaseRoot, gate, instanceId, '1200'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

test('different instance ids cannot own the same canonical storage file concurrently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-daemon-race-'))
  const storageDir = path.join(root, 'state')
  const storage = path.join(storageDir, 'workflow.json')
  const aliasDir = path.join(root, 'alias')
  const leaseRoot = path.join(root, 'leases')
  const gate = path.join(root, 'go')
  const fixture = fileURLToPath(new URL('./fixtures/daemon-lease-child.ts', import.meta.url))
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(storageDir, { recursive: true }))
    await import('node:fs/promises').then(fs => fs.symlink(storageDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir'))
    const viaAlias = path.join(aliasDir, 'workflow.json')
    const first = runContender(fixture, storage, leaseRoot, gate, 'instance-a')
    const second = runContender(fixture, viaAlias, leaseRoot, gate, 'instance-b')
    await writeFile(gate, 'go\n', 'utf8')
    const results = await Promise.all([first, second])
    const parsed = results.map(result => JSON.parse(result.stdout.trim()) as { acquired: boolean; error?: string })
    assert.equal(parsed.filter(row => row.acquired).length, 1, results.map(row => row.stderr).join('\n'))
    assert.equal(parsed.filter(row => !row.acquired).length, 1)
    assert.match(parsed.find(row => !row.acquired)?.error ?? '', /already owns storage/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('forced child death leaves a stale lease that a new owner can recover immediately', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-daemon-dead-owner-'))
  const storage = path.join(root, 'state', 'workflow.json')
  const leaseRoot = path.join(root, 'leases')
  const gate = path.join(root, 'go')
  const fixture = fileURLToPath(new URL('./fixtures/daemon-lease-child.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, storage, leaseRoot, gate, 'old-owner', '10000'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  child.stdout.setEncoding('utf8')
  try {
    await writeFile(gate, 'go\n', 'utf8')
    const acquired = await new Promise<string>((resolve, reject) => {
      let buffer = ''
      child.stdout.on('data', chunk => { buffer += String(chunk); const index = buffer.indexOf('\n'); if (index >= 0) resolve(buffer.slice(0, index)) })
      child.on('error', reject)
      child.on('close', code => { if (!buffer.includes('\n')) reject(new Error(`lease child closed before acquisition: ${code}`)) })
    })
    assert.equal((JSON.parse(acquired) as {acquired:boolean}).acquired, true)
    child.kill('SIGKILL')
    await new Promise<void>(resolve => child.once('close', () => resolve()))

    const replacement = await acquireDaemonLease('replacement', storage, { root: leaseRoot, acquisitionTimeoutMs: 1_000 })
    try { assert.equal(replacement.storageFile, await canonicalStorageIdentity(storage)) }
    finally { await replacement.release() }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('an uninitialized directory lease is not deleted during its initialization grace window', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-daemon-init-'))
  const storage = path.join(root, 'state', 'workflow.json')
  const leaseRoot = path.join(root, 'leases')
  try {
    const canonical = await canonicalStorageIdentity(storage)
    const key = createHash('sha256').update(canonical).digest('hex')
    const lockDir = path.join(leaseRoot, `${key}.lock`)
    await mkdir(lockDir, { recursive: true })
    await assert.rejects(acquireDaemonLease('contender', storage, { root: leaseRoot, initializationGraceMs: 2_000, acquisitionTimeoutMs: 120 }), /timed out acquiring/)
    await access(lockDir)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('lease release cannot delete a lock after owner token changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-daemon-owner-'))
  const storage = path.join(root, 'state', 'workflow.json')
  const leaseRoot = path.join(root, 'leases')
  try {
    const lease = await acquireDaemonLease('instance-a', storage, { root: leaseRoot })
    const ownerFile = path.join(lease.lockDir, 'owner.json')
    const current = JSON.parse(await readFile(ownerFile, 'utf8')) as Record<string, unknown>
    await writeFile(ownerFile, `${JSON.stringify({ ...current, ownerToken: 'replacement-owner' }, null, 2)}\n`, 'utf8')
    assert.equal(await lease.release(), false)
    await access(lease.lockDir)
  } finally { await rm(root, { recursive: true, force: true }) }
})
