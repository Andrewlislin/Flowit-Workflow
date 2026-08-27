import { stat } from 'node:fs/promises'
import { acquireDaemonLease } from '../../src/daemon-lease.js'

const [storageFile, leaseRoot, gateFile, instanceId, holdMsText] = process.argv.slice(2)
if (!storageFile || !leaseRoot || !gateFile || !instanceId) throw new Error('daemon lease child requires storage, root, gate, and instance')
const holdMs = Number(holdMsText ?? 1000)

for (;;) {
  try { await stat(gateFile); break }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await new Promise(resolve => setTimeout(resolve, 5))
}

try {
  const lease = await acquireDaemonLease(instanceId, storageFile, { root: leaseRoot, acquisitionTimeoutMs: 2_000 })
  process.stdout.write(`${JSON.stringify({ acquired: true, instanceId, ownerToken: lease.ownerToken })}\n`)
  await new Promise(resolve => setTimeout(resolve, holdMs))
  await lease.release()
  process.exitCode = 0
} catch (error: unknown) {
  process.stdout.write(`${JSON.stringify({ acquired: false, instanceId, error: error instanceof Error ? error.message : String(error) })}\n`)
  process.exitCode = 2
}
