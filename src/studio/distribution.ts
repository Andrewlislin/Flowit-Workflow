import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertOutputOutsideSource, validateStudioProject } from './sdk.js'
import { assertSafePackageTree, computeStudioTreeDigest } from './store.js'
import type { StudioLicenseType, StudioPackageManifest } from './types.js'
import { loadStudioPackage } from './validate.js'

export const SKILLHUB_OFFICIAL_INSTALLER_PUBLISHER = 'coaseedge'
export const SKILLHUB_OFFICIAL_INSTALLER_ID = 'flowit-studio-installer'
export const SKILLHUB_METADATA_FILENAME = 'flowit-skillhub.json'

const STUDIO_LICENSE_TYPES = new Set<StudioLicenseType>([
  'open-source',
  'freeware',
  'commercial-perpetual',
  'commercial-team',
  'commercial-enterprise',
])

export interface SkillHubStudioMetadataV2 {
  readonly version: 2
  readonly channel: 'skillhub'
  readonly kind: 'flowit-studio-payload'
  readonly installer: {
    readonly publisherId: typeof SKILLHUB_OFFICIAL_INSTALLER_PUBLISHER
    readonly id: typeof SKILLHUB_OFFICIAL_INSTALLER_ID
    readonly trust: 'channel-authenticated'
  }
  readonly studio: {
    readonly id: string
    readonly displayName: string
    readonly version: string
    readonly publisherId: string
    readonly runtimeRange: string
    readonly licenseType: StudioLicenseType
  }
  readonly trust: {
    readonly publisherKeyComesFromDistributionChannel: true
    readonly packageSignatureFile: 'studio/flowit.signature.json'
  }
}

export interface SkillHubStudioBundleResult {
  readonly outputDir: string
  readonly studioDir: string
  readonly metadataFile: string
}

export interface SkillHubPayloadStoreOptions {
  readonly rootDir?: string
}

export interface SkillHubPayloadSnapshot {
  readonly snapshotDir: string
  readonly studioDir: string
  readonly metadataFile: string
  readonly metadata: SkillHubStudioMetadataV2
  readonly manifest: StudioPackageManifest
  readonly payloadDigest: string
  readonly studioDigest: string
}

/**
 * Flowit-owned staging boundary for a channel payload. No trust or identity
 * conclusion is formed against the publisher-controlled source directory.
 * The security invariant is checked payload bytes == frozen Studio bytes;
 * source mutations after this copy cannot affect the reviewed snapshot.
 */
export class SkillHubPayloadStore {
  readonly rootDir: string

  constructor(options: SkillHubPayloadStoreOptions = {}) {
    this.rootDir = path.resolve(
      options.rootDir ?? path.join(os.homedir(), '.flowit-workflow', 'skillhub-payloads'),
    )
  }

  async stageFromDirectory(sourceRoot: string): Promise<SkillHubPayloadSnapshot> {
    const stagingRoot = this.stagingRoot()
    await mkdir(stagingRoot, { recursive: true })
    const snapshotDir = path.join(stagingRoot, randomUUID())
    try {
      await cp(path.resolve(sourceRoot), snapshotDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
      })
      await assertSafePackageTree(snapshotDir)
      await assertSkillHubPayloadLayout(snapshotDir)

      const metadataFile = path.join(snapshotDir, SKILLHUB_METADATA_FILENAME)
      const metadata = parseSkillHubStudioMetadata(
        JSON.parse(await readFile(metadataFile, 'utf8')) as unknown,
      )
      const studioDir = path.join(snapshotDir, 'studio')
      const descriptor = await loadStudioPackage(studioDir)
      assertSkillHubPayloadIdentity(metadata, descriptor.manifest)

      return {
        snapshotDir,
        studioDir,
        metadataFile,
        metadata,
        manifest: descriptor.manifest,
        payloadDigest: await computeStudioTreeDigest(snapshotDir),
        studioDigest: await computeStudioTreeDigest(studioDir),
      }
    } catch (error: unknown) {
      await rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async assertSnapshotUnchanged(snapshot: SkillHubPayloadSnapshot): Promise<void> {
    this.assertOwnedSnapshot(snapshot)
    await assertSafePackageTree(snapshot.snapshotDir)
    await assertSkillHubPayloadLayout(snapshot.snapshotDir)

    const metadata = parseSkillHubStudioMetadata(
      JSON.parse(await readFile(snapshot.metadataFile, 'utf8')) as unknown,
    )
    const descriptor = await loadStudioPackage(snapshot.studioDir)
    assertSkillHubPayloadIdentity(metadata, descriptor.manifest)

    const [payloadDigest, studioDigest] = await Promise.all([
      computeStudioTreeDigest(snapshot.snapshotDir),
      computeStudioTreeDigest(snapshot.studioDir),
    ])
    if (payloadDigest !== snapshot.payloadDigest) {
      throw new Error('SkillHub payload snapshot changed after identity review')
    }
    if (studioDigest !== snapshot.studioDigest) {
      throw new Error('SkillHub Studio bytes changed after payload identity review')
    }
  }

  async discardSnapshot(snapshot: SkillHubPayloadSnapshot): Promise<void> {
    this.assertOwnedSnapshot(snapshot)
    await rm(snapshot.snapshotDir, { recursive: true, force: true })
  }

  private stagingRoot(): string {
    return path.join(this.rootDir, '.staging')
  }

  private assertOwnedSnapshot(snapshot: SkillHubPayloadSnapshot): void {
    const stagingRoot = path.resolve(this.stagingRoot())
    const snapshotDir = path.resolve(snapshot.snapshotDir)
    if (
      !snapshotDir.startsWith(`${stagingRoot}${path.sep}`) ||
      path.resolve(snapshot.studioDir) !== path.join(snapshotDir, 'studio') ||
      path.resolve(snapshot.metadataFile) !== path.join(snapshotDir, SKILLHUB_METADATA_FILENAME)
    ) {
      throw new Error('SkillHub payload snapshot is not owned by this Flowit payload store')
    }
  }
}

/**
 * Produce a publisher-safe SkillHub payload. This function intentionally emits
 * no SKILL.md, JavaScript installer, bootstrap script, or other executable file.
 * Installation must be delegated by the channel to the separately published,
 * channel-authenticated CoaseEdge Flowit Studio Installer Skill.
 */
export async function createSkillHubStudioBundle(
  sourceRoot: string,
  outputDir: string,
): Promise<SkillHubStudioBundleResult> {
  const source = path.resolve(sourceRoot)
  const root = path.resolve(outputDir)
  await assertOutputOutsideSource(source, root, 'SkillHub payload output')

  const studioDir = path.join(root, 'studio')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })

  // Copy first, then validate the exact declarative bytes that will be distributed.
  await cp(source, studioDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
  })
  const validation = await validateStudioProject(studioDir)
  const manifest = validation.descriptor.manifest
  const metadata = skillHubMetadataForManifest(manifest)
  assertSkillHubPayloadIdentity(metadata, manifest)

  const metadataFile = path.join(root, SKILLHUB_METADATA_FILENAME)
  await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  return { outputDir: root, studioDir, metadataFile }
}

export function skillHubMetadataForManifest(
  manifest: StudioPackageManifest,
): SkillHubStudioMetadataV2 {
  return {
    version: 2,
    channel: 'skillhub',
    kind: 'flowit-studio-payload',
    installer: {
      publisherId: SKILLHUB_OFFICIAL_INSTALLER_PUBLISHER,
      id: SKILLHUB_OFFICIAL_INSTALLER_ID,
      trust: 'channel-authenticated',
    },
    studio: {
      id: manifest.id,
      displayName: manifest.displayName,
      version: manifest.version,
      publisherId: manifest.publisher.id,
      runtimeRange: manifest.runtime.version,
      licenseType: manifest.license.type,
    },
    trust: {
      publisherKeyComesFromDistributionChannel: true,
      packageSignatureFile: 'studio/flowit.signature.json',
    },
  }
}

export function parseSkillHubStudioMetadata(value: unknown): SkillHubStudioMetadataV2 {
  const object = objectValue(value, 'SkillHub metadata')
  assertAllowedKeys(object, ['version', 'channel', 'kind', 'installer', 'studio', 'trust'], 'SkillHub metadata')
  if (object.version !== 2 || object.channel !== 'skillhub' || object.kind !== 'flowit-studio-payload') {
    throw new Error('invalid Flowit SkillHub Studio payload metadata')
  }

  const installer = objectValue(object.installer, 'SkillHub installer identity')
  assertAllowedKeys(installer, ['publisherId', 'id', 'trust'], 'SkillHub installer identity')
  if (
    installer.publisherId !== SKILLHUB_OFFICIAL_INSTALLER_PUBLISHER ||
    installer.id !== SKILLHUB_OFFICIAL_INSTALLER_ID ||
    installer.trust !== 'channel-authenticated'
  ) {
    throw new Error('SkillHub Studio payload does not require the official CoaseEdge installer')
  }

  const studio = objectValue(object.studio, 'SkillHub Studio identity')
  assertAllowedKeys(
    studio,
    ['id', 'displayName', 'version', 'publisherId', 'runtimeRange', 'licenseType'],
    'SkillHub Studio identity',
  )
  const licenseType = requiredString(studio.licenseType, 'SkillHub Studio licenseType') as StudioLicenseType
  if (!STUDIO_LICENSE_TYPES.has(licenseType)) throw new Error('SkillHub Studio licenseType is invalid')

  const trust = objectValue(object.trust, 'SkillHub trust metadata')
  assertAllowedKeys(
    trust,
    ['publisherKeyComesFromDistributionChannel', 'packageSignatureFile'],
    'SkillHub trust metadata',
  )
  if (
    trust.publisherKeyComesFromDistributionChannel !== true ||
    trust.packageSignatureFile !== 'studio/flowit.signature.json'
  ) {
    throw new Error('SkillHub Studio trust metadata is invalid')
  }

  return {
    version: 2,
    channel: 'skillhub',
    kind: 'flowit-studio-payload',
    installer: {
      publisherId: SKILLHUB_OFFICIAL_INSTALLER_PUBLISHER,
      id: SKILLHUB_OFFICIAL_INSTALLER_ID,
      trust: 'channel-authenticated',
    },
    studio: {
      id: requiredString(studio.id, 'SkillHub Studio id'),
      displayName: requiredString(studio.displayName, 'SkillHub Studio displayName'),
      version: requiredString(studio.version, 'SkillHub Studio version'),
      publisherId: requiredString(studio.publisherId, 'SkillHub Studio publisherId'),
      runtimeRange: requiredString(studio.runtimeRange, 'SkillHub Studio runtimeRange'),
      licenseType,
    },
    trust: {
      publisherKeyComesFromDistributionChannel: true,
      packageSignatureFile: 'studio/flowit.signature.json',
    },
  }
}

export function assertSkillHubPayloadIdentity(
  metadata: SkillHubStudioMetadataV2,
  manifest: StudioPackageManifest,
): void {
  if (
    metadata.version !== 2 ||
    metadata.channel !== 'skillhub' ||
    metadata.kind !== 'flowit-studio-payload'
  ) {
    throw new Error('invalid Flowit SkillHub Studio payload metadata')
  }
  if (
    metadata.installer.publisherId !== SKILLHUB_OFFICIAL_INSTALLER_PUBLISHER ||
    metadata.installer.id !== SKILLHUB_OFFICIAL_INSTALLER_ID ||
    metadata.installer.trust !== 'channel-authenticated'
  ) {
    throw new Error('SkillHub Studio payload does not require the official CoaseEdge installer')
  }
  const fields: ReadonlyArray<readonly [string, string, string]> = [
    ['id', metadata.studio.id, manifest.id],
    ['displayName', metadata.studio.displayName, manifest.displayName],
    ['version', metadata.studio.version, manifest.version],
    ['publisherId', metadata.studio.publisherId, manifest.publisher.id],
    ['runtimeRange', metadata.studio.runtimeRange, manifest.runtime.version],
    ['licenseType', metadata.studio.licenseType, manifest.license.type],
  ]
  for (const [field, actual, expected] of fields) {
    if (actual !== expected) {
      throw new Error(`SkillHub metadata mismatch for Studio ${field}`)
    }
  }
}

async function assertSkillHubPayloadLayout(rootDir: string): Promise<void> {
  const entries = await readdir(rootDir, { withFileTypes: true })
  const names = entries.map(entry => entry.name).sort()
  if (names.length !== 2 || names[0] !== SKILLHUB_METADATA_FILENAME || names[1] !== 'studio') {
    throw new Error('SkillHub payload must contain only flowit-skillhub.json and studio/')
  }
  const metadata = entries.find(entry => entry.name === SKILLHUB_METADATA_FILENAME)
  const studio = entries.find(entry => entry.name === 'studio')
  if (!metadata?.isFile() || !studio?.isDirectory()) {
    throw new Error('SkillHub payload metadata must be a file and studio must be a directory')
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertAllowedKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(object).filter(key => !allowed.has(key))
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}
