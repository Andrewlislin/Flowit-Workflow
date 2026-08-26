import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JsonWorkflowStore } from '../src/core/store.js'
import type { ScheduledTask } from '../src/core/types.js'
function task(id: string): ScheduledTask { const now = new Date().toISOString(); return { id, name: id, target: { adapterId: 'fake', sessionId: id, prompt: 'x', skills: [], contextRefs: [] }, timing: { kind: 'every', everySeconds: 60 }, status: 'active', nextRunAt: new Date(Date.now() + 60_000).toISOString(), createdAt: now, updatedAt: now } }
test('two store instances do not lose concurrent mutations', async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'flowit-store-')); const file = path.join(dir, 'state.json'); const first = new JsonWorkflowStore(file); const second = new JsonWorkflowStore(file); try { await Promise.all([first.putSchedule(task('a')), second.putSchedule(task('b'))]); const ids = (await first.snapshot()).schedules.map(item => item.id).sort(); assert.deepEqual(ids, ['a','b']) } finally { await rm(dir, { recursive: true, force: true }) } })
