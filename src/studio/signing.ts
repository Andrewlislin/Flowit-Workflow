import { createHash, sign, verify, type KeyObject } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { StudioPackageDescriptor } from './types.js'

export const FLOWIT_STUDIO_SIGNATURE_FILENAME = 'flowit.signature.json'

export interface StudioPackageSignatureV1 {
  readonly version: 1
  readonly algorithm: 'ed25519-sha256-tree'
  readonly publisherId: string
  readonly keyId: string
  readonly digest: string
  readonly signature: string
}

export type StudioPublisherTrustLevel = 'publisher' | 'verified' | 'official'

export interface StudioTrustedPublisherKey {
  readonly publisherId: string
  readonly keyId: string
  readonly publicKey: string | KeyObject
  readonly trust: StudioPublisherTrustLevel
}

export interface StudioPackageTrust {
  readonly status: 'unsigned' | StudioPublisherTrustLevel
  readonly publisherId: string
  readonly keyId?: string
  readonly digest?: string
}

export class StudioTrustStore {
  private readonly keys = new Map<string, StudioTrustedPublisherKey>()

  constructor(keys: readonly StudioTrustedPublisherKey[] = []) {
    for (const key of keys) this.add(key)
  }

  add(key: StudioTrustedPublisherKey): void {
    const publisherId = key.publisherId.trim()
    const keyId = key.keyId.trim()
    if (!publisherId || !keyId) throw new Error('Studio trust key requires publisherId and keyId')
    const id = trustKeyId(publisherId, keyId)
    if (this.keys.has(id)) throw new Error(`Studio trust key ${publisherId}/${keyId} is already registered`)
    this.keys.set(id, { ...key, publisherId, keyId })
  }

  get(publisherId: string, keyId: string): StudioTrustedPublisherKey | undefined {
    return this.keys.get(trustKeyId(publisherId, keyId))
  }
}

export async function loadStudioPackageSignature(rootDir: string): Promise<StudioPackageSignatureV1 | undefined> {
  const file = path.join(path.resolve(rootDir), FLOWIT_STUDIO_SIGNATURE_FILENAME)
  try {
    return parseStudioPackageSignature(JSON.parse(await readFile(file, 'utf8')) as unknown)
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export function parseStudioPackageSignature(value: unknown): StudioPackageSignatureV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Studio package signature must be an object')
  const object = value as Record<string, unknown>
  const allowed = new Set(['version', 'algorithm', 'publisherId', 'keyId', 'digest', 'signature'])
  const unknown = Object.keys(object).filter(key => !allowed.has(key))
  if (unknown.length) throw new Error(`Studio package signature contains unsupported fields: ${unknown.join(', ')}`)
  if (object.version !== 1) throw new Error('Studio package signature version must be 1')
  if (object.algorithm !== 'ed25519-sha256-tree') throw new Error('Studio package signature algorithm must be ed25519-sha256-tree')
  const publisherId = requiredString(object.publisherId, 'publisherId')
  const keyId = requiredString(object.keyId, 'keyId')
  const digest = requiredString(object.digest, 'digest')
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Studio package signature digest must be sha256 hex')
  const signature = requiredString(object.signature, 'signature')
  return { version: 1, algorithm: 'ed25519-sha256-tree', publisherId, keyId, digest, signature }
}

export async function computeStudioPackageDigest(rootDir: string): Promise<string> {
  const root = path.resolve(rootDir)
  const files: string[] = []
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const stat = await lstat(fullPath)
      if (stat.isSymbolicLink()) throw new Error(`Studio signature tree must not contain symbolic links: ${path.relative(root, fullPath)}`)
      if (stat.isDirectory()) await visit(fullPath)
      else if (stat.isFile()) {
        const relative = path.relative(root, fullPath).split(path.sep).join('/')
        if (relative !== FLOWIT_STUDIO_SIGNATURE_FILENAME) files.push(relative)
      }
    }
  }
  await visit(root)
  files.sort()
  const hash = createHash('sha256')
  for (const relative of files) {
    const bytes = await readFile(path.join(root, ...relative.split('/')))
    hash.update(relative, 'utf8')
    hash.update('\0')
    hash.update(String(bytes.length), 'utf8')
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function signStudioPackage(
  descriptor: StudioPackageDescriptor,
  keyId: string,
  privateKey: string | KeyObject,
): Promise<StudioPackageSignatureV1> {
  const digest = await computeStudioPackageDigest(descriptor.rootDir)
  const signature = sign(null, Buffer.from(digest, 'hex'), privateKey).toString('base64')
  return {
    version: 1,
    algorithm: 'ed25519-sha256-tree',
    publisherId: descriptor.manifest.publisher.id,
    keyId: keyId.trim(),
    digest,
    signature,
  }
}

export async function evaluateStudioPackageTrust(
  descriptor: StudioPackageDescriptor,
  trustStore: StudioTrustStore,
): Promise<StudioPackageTrust> {
  const envelope = await loadStudioPackageSignature(descriptor.rootDir)
  if (!envelope) return { status: 'unsigned', publisherId: descriptor.manifest.publisher.id }
  if (envelope.publisherId !== descriptor.manifest.publisher.id) {
    throw new Error(`Studio signature publisher ${envelope.publisherId} does not match manifest publisher ${descriptor.manifest.publisher.id}`)
  }
  const key = trustStore.get(envelope.publisherId, envelope.keyId)
  if (!key) throw new Error(`Studio publisher key ${envelope.publisherId}/${envelope.keyId} is not trusted locally`)
  const digest = await computeStudioPackageDigest(descriptor.rootDir)
  if (digest !== envelope.digest) throw new Error('Studio package digest does not match signed digest')
  const ok = verify(null, Buffer.from(digest, 'hex'), key.publicKey, Buffer.from(envelope.signature, 'base64'))
  if (!ok) throw new Error('Studio package signature verification failed')
  return { status: key.trust, publisherId: envelope.publisherId, keyId: envelope.keyId, digest }
}

function trustKeyId(publisherId: string, keyId: string): string {
  return `${publisherId.trim()}\0${keyId.trim()}`
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Studio package signature ${label} must be a non-empty string`)
  return value.trim()
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
}
