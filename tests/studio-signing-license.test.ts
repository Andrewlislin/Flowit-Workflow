import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  FLOWIT_STUDIO_SIGNATURE_FILENAME,
  StudioPackageStore,
  StudioTrustStore,
  createStudioLicense,
  evaluateStudioPackageTrust,
  loadStudioPackage,
  signStudioPackage,
  verifyStudioLicense,
} from '../src/studio/index.js'

async function createPackage(root: string): Promise<void> {
  await mkdir(path.join(root, 'presets'), { recursive: true })
  await mkdir(path.join(root, 'roles'), { recursive: true })
  await writeFile(
    path.join(root, 'flowit.package.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme.research-pro',
      displayName: 'Research Pro',
      publisher: { id: 'acme' },
      version: '1.4.0',
      runtime: {
        id: 'flowit-workflow',
        version: '>=0.5.0-beta.2 <2',
        bootstrap: 'official',
      },
      supportedHosts: ['claude-code'],
      entryPreset: 'research-pro',
      license: { type: 'commercial-perpetual' },
    }),
  )
  await writeFile(
    path.join(root, 'presets', 'research-pro.json'),
    JSON.stringify({
      version: 1,
      id: 'research-pro',
      displayName: 'Research Pro',
      description: 'Research',
      input: { required: true, label: 'Question' },
      roles: [
        {
          id: 'researcher',
          displayName: 'Researcher',
          description: 'Research',
        },
      ],
      nodes: [
        {
          id: 'research',
          roleId: 'researcher',
          promptFile: 'roles/researcher.md',
        },
      ],
      edges: [],
    }),
  )
  await writeFile(path.join(root, 'roles', 'researcher.md'), 'Research the question.\n')
}

test('Studio package signature verifies the complete declarative package tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-sign-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  try {
    await createPackage(root)
    const descriptor = await loadStudioPackage(root)
    const envelope = await signStudioPackage(descriptor, 'release-2026', privateKey)
    await writeFile(
      path.join(root, FLOWIT_STUDIO_SIGNATURE_FILENAME),
      `${JSON.stringify(envelope, null, 2)}\n`,
    )
    const trust = new StudioTrustStore([
      {
        publisherId: 'acme',
        keyId: 'release-2026',
        publicKey,
        trust: 'verified',
      },
    ])
    assert.equal((await evaluateStudioPackageTrust(descriptor, trust)).status, 'verified')

    await writeFile(path.join(root, 'roles', 'researcher.md'), 'Tampered prompt.\n')
    await assert.rejects(
      () => evaluateStudioPackageTrust(descriptor, trust),
      /digest does not match/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verified signature remains bound to the Flowit-owned snapshot that is installed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-studio-signed-snapshot-'))
  const source = path.join(root, 'source')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  try {
    await createPackage(source)
    const sourceDescriptor = await loadStudioPackage(source)
    const envelope = await signStudioPackage(sourceDescriptor, 'release-2026', privateKey)
    await writeFile(
      path.join(source, FLOWIT_STUDIO_SIGNATURE_FILENAME),
      `${JSON.stringify(envelope, null, 2)}\n`,
    )
    const store = new StudioPackageStore({ rootDir: path.join(root, 'store') })
    const snapshot = await store.stageFromDirectory(source)
    const trustStore = new StudioTrustStore([
      {
        publisherId: 'acme',
        keyId: 'release-2026',
        publicKey,
        trust: 'verified',
      },
    ])
    const trust = await evaluateStudioPackageTrust(snapshot, trustStore)
    assert.equal(trust.status, 'verified')

    await writeFile(path.join(source, 'roles', 'researcher.md'), 'Unsigned replacement.\n')
    const installed = await store.commitSnapshot(snapshot)
    assert.equal(
      await readFile(path.join(installed.installDir, 'roles', 'researcher.md'), 'utf8'),
      'Research the question.\n',
    )
    assert.equal((await evaluateStudioPackageTrust(installed, trustStore)).status, 'verified')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('offline perpetual Studio license verifies locally and separates use from update eligibility', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const trust = new StudioTrustStore([
    { publisherId: 'acme', keyId: 'license-1', publicKey, trust: 'verified' },
  ])
  const document = createStudioLicense(
    {
      version: 1,
      licenseId: 'ACME-0001',
      packageId: 'acme.research-pro',
      publisherId: 'acme',
      edition: 'personal',
      majorVersion: 1,
      issuedAt: '2026-08-31T00:00:00.000Z',
      updatesUntil: '2027-08-31T00:00:00.000Z',
      holder: 'customer@example.test',
      seats: 1,
    },
    'license-1',
    privateKey,
  )
  const active = verifyStudioLicense(document, trust, {
    packageId: 'acme.research-pro',
    publisherId: 'acme',
    packageVersion: '1.9.0',
    licenseType: 'commercial-perpetual',
    now: new Date('2027-01-01T00:00:00.000Z'),
  })
  assert.equal(active.updatesEligible, true)
  const expiredUpdates = verifyStudioLicense(document, trust, {
    packageId: 'acme.research-pro',
    publisherId: 'acme',
    packageVersion: '1.9.0',
    licenseType: 'commercial-perpetual',
    now: new Date('2028-01-01T00:00:00.000Z'),
  })
  assert.equal(expiredUpdates.updatesEligible, false)
  assert.throws(
    () =>
      verifyStudioLicense(document, trust, {
        packageId: 'acme.research-pro',
        publisherId: 'acme',
        packageVersion: '2.0.0',
        licenseType: 'commercial-perpetual',
      }),
    /covers major version 1/,
  )
})

test('commercial license editions are enforced against the Studio product type', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const trust = new StudioTrustStore([
    { publisherId: 'acme', keyId: 'license-1', publicKey, trust: 'verified' },
  ])
  const personal = createStudioLicense(
    {
      version: 1,
      licenseId: 'PERSONAL',
      packageId: 'acme.research-pro',
      publisherId: 'acme',
      edition: 'personal',
      majorVersion: 1,
      issuedAt: '2026-08-31T00:00:00.000Z',
      seats: 1,
    },
    'license-1',
    privateKey,
  )
  assert.throws(
    () =>
      verifyStudioLicense(personal, trust, {
        packageId: 'acme.research-pro',
        publisherId: 'acme',
        packageVersion: '1.0.0',
        licenseType: 'commercial-team',
      }),
    /commercial-team package does not accept a personal license/,
  )
  assert.throws(
    () =>
      verifyStudioLicense(personal, trust, {
        packageId: 'acme.research-pro',
        publisherId: 'acme',
        packageVersion: '1.0.0',
        licenseType: 'commercial-enterprise',
      }),
    /commercial-enterprise package does not accept a personal license/,
  )

  const team = createStudioLicense(
    {
      version: 1,
      licenseId: 'TEAM',
      packageId: 'acme.research-pro',
      publisherId: 'acme',
      edition: 'team',
      majorVersion: 1,
      issuedAt: '2026-08-31T00:00:00.000Z',
      seats: 10,
    },
    'license-1',
    privateKey,
  )
  assert.equal(
    verifyStudioLicense(team, trust, {
      packageId: 'acme.research-pro',
      publisherId: 'acme',
      packageVersion: '1.0.0',
      licenseType: 'commercial-team',
    }).document.edition,
    'team',
  )

  const enterprise = createStudioLicense(
    {
      version: 1,
      licenseId: 'ENTERPRISE',
      packageId: 'acme.research-pro',
      publisherId: 'acme',
      edition: 'enterprise',
      majorVersion: 1,
      issuedAt: '2026-08-31T00:00:00.000Z',
    },
    'license-1',
    privateKey,
  )
  assert.equal(
    verifyStudioLicense(enterprise, trust, {
      packageId: 'acme.research-pro',
      publisherId: 'acme',
      packageVersion: '1.0.0',
      licenseType: 'commercial-enterprise',
    }).document.edition,
    'enterprise',
  )

  assert.throws(
    () =>
      createStudioLicense(
        {
          version: 1,
          licenseId: 'BAD-PERSONAL',
          packageId: 'acme.research-pro',
          publisherId: 'acme',
          edition: 'personal',
          majorVersion: 1,
          issuedAt: '2026-08-31T00:00:00.000Z',
          seats: 2,
        },
        'license-1',
        privateKey,
      ),
    /only one seat/,
  )
  assert.throws(
    () =>
      createStudioLicense(
        {
          version: 1,
          licenseId: 'BAD-TEAM',
          packageId: 'acme.research-pro',
          publisherId: 'acme',
          edition: 'team',
          majorVersion: 1,
          issuedAt: '2026-08-31T00:00:00.000Z',
        },
        'license-1',
        privateKey,
      ),
    /must declare the signed seat entitlement/,
  )
})
