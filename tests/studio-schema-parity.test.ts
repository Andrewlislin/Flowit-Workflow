import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertFlowitRuntimeRange,
  FLOWIT_RUNTIME_RANGE_PATTERN,
  FLOWIT_STUDIO_MANIFEST_SCHEMA,
} from '../src/studio/index.js'

test('public Studio schema and runtime parser share one runtime.version grammar', () => {
  const schemaPattern = FLOWIT_STUDIO_MANIFEST_SCHEMA.properties.runtime.properties.version.pattern
  assert.equal(schemaPattern, FLOWIT_RUNTIME_RANGE_PATTERN)
  const schemaRegex = new RegExp(schemaPattern)

  for (const value of [
    '>=0.5.0-beta.2 <2',
    '=1.2.3',
    '>=1 <2',
    '1.2.3',
    '>=1.2 <=1.9.9',
    '>=1.2.3-alpha.1 <2+build.7',
  ]) {
    assert.match(value, schemaRegex)
    assert.equal(assertFlowitRuntimeRange(value), value)
  }

  for (const value of [
    '$(touch /tmp/pwn)',
    '^1.2.3',
    '~1.2.3',
    '1.2',
    '>=1.2-beta',
    '>=1 || <2',
    'latest',
  ]) {
    assert.doesNotMatch(value, schemaRegex)
    assert.throws(() => assertFlowitRuntimeRange(value))
  }
})
