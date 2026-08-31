import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FLOWIT_STUDIO_MANIFEST_FILENAME,
  FLOWIT_STUDIO_MANIFEST_SCHEMA,
  STANDARD_STUDIO_INSTALL_GRANTS,
  createStudioInstallIntent,
  intentAuthorizesStandardInstall,
} from '../src/studio/index.js'

test('studio manifest v1 keeps runtime bootstrap official and declarative', () => {
  assert.equal(FLOWIT_STUDIO_MANIFEST_FILENAME, 'flowit.package.json')
  assert.equal(FLOWIT_STUDIO_MANIFEST_SCHEMA.additionalProperties, false)
  assert.deepEqual(FLOWIT_STUDIO_MANIFEST_SCHEMA.properties.runtime.properties.bootstrap, {
    const: 'official',
  })
  assert.equal('installScript' in FLOWIT_STUDIO_MANIFEST_SCHEMA.properties, false)
})

test('one user install intent grants only the standard dependency scope', () => {
  const intent = createStudioInstallIntent({
    studioId: 'acme.saas-intelligence',
    source: 'skillhub',
    now: () => new Date('2026-08-31T12:00:00.000Z'),
  })
  assert.deepEqual(intent.grants, STANDARD_STUDIO_INSTALL_GRANTS)
  assert.equal(intent.createdAt, '2026-08-31T12:00:00.000Z')
  assert.equal(intentAuthorizesStandardInstall(intent, 'runtime-bootstrap'), true)
  assert.equal(intentAuthorizesStandardInstall(intent, 'standard-host-integration'), true)
  assert.equal(intentAuthorizesStandardInstall(intent, 'managed-package-files'), true)
})
