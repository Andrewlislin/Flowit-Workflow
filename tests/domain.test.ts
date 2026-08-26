import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceSchedule, assertNoAutonomousSessionCycle, createScheduleRecord, normalizePipeline, topologicalOrder } from '../src/domain.js'

test('fixed-rate schedule advances past missed intervals without catch-up storms', () => {
  const task = createScheduleRecord('task-1', {
    name: 'daily-ish',
    target: { sessionId: 's1', prompt: 'work', skills: [], contextRefs: [] },
    timing: { kind: 'every', everySeconds: 60 },
  }, new Date('2026-08-26T00:00:00.000Z'), 60)
  const advanced = advanceSchedule(task, new Date('2026-08-26T00:05:30.000Z'))
  assert.equal(advanced.nextRunAt, '2026-08-26T00:06:00.000Z')
})

test('pipeline rejects cycles and keeps deterministic topological order', () => {
  const pipeline = normalizePipeline('p1', {
    name: 'research to writing',
    trigger: { kind: 'manual' },
    nodes: [
      { id: 'research', inheritUpstreamContext: true, target: { sessionId: 'r', prompt: 'research', skills: [], contextRefs: [] } },
      { id: 'write', inheritUpstreamContext: true, target: { sessionId: 'w', prompt: 'write', skills: [], contextRefs: [] } },
    ],
    edges: [{ from: 'research', to: 'write' }],
  }, new Date('2026-08-26T00:00:00.000Z'))
  assert.deepEqual(topologicalOrder(pipeline.nodes, pipeline.edges), ['research', 'write'])

  assert.throws(() => normalizePipeline('p2', {
    name: 'cycle', trigger: { kind: 'manual' }, nodes: pipeline.nodes,
    edges: [{ from: 'research', to: 'write' }, { from: 'write', to: 'research' }],
  }, new Date()), /acyclic/)
})

test('autonomous pipelines reject a cross-pipeline session trigger cycle', () => {
  const first = normalizePipeline('p1', {
    name: 'A to B', trigger: { kind: 'session_turn_completed', sessionId: 'A' },
    nodes: [{ id: 'b', inheritUpstreamContext: true, target: { sessionId: 'B', prompt: 'B work', skills: [], contextRefs: [] } }], edges: [],
  }, new Date())
  const second = normalizePipeline('p2', {
    name: 'B to A', trigger: { kind: 'session_turn_completed', sessionId: 'B' },
    nodes: [{ id: 'a', inheritUpstreamContext: true, target: { sessionId: 'A', prompt: 'A work', skills: [], contextRefs: [] } }], edges: [],
  }, new Date())
  assert.throws(() => assertNoAutonomousSessionCycle([first, second]), /cycle/)
})
