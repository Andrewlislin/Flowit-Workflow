import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { FLOWIT_STUDIO_MANIFEST_FILENAME } from './schema.js'
import type {
  StudioLicenseDescriptor,
  StudioLicenseType,
  StudioPackageDescriptor,
  StudioPackageManifest,
  StudioPermissionRequirement,
  StudioPublisherDescriptor,
} from './types.js'

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'id',
  'displayName',
  'description',
  'publisher',
  'version',
  'runtime',
  'supportedHosts',
  'entryPreset',
  'license',
  'permissions',
  'metadata',
])
const PUBLISHER_KEYS = new Set(['id', 'displayName', 'homepage'])
const RUNTIME_KEYS = new Set(['id', 'version', 'bootstrap'])
const LICENSE_KEYS = new Set(['type', 'licenseId', 'notice'])
const PERMISSION_KEYS = new Set(['id', 'description', 'risk', 'reason'])
const PACKAGE_ID = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const LICENSE_TYPES = new Set<StudioLicenseType>([
  'open-source',
  'freeware',
  'commercial-perpetual',
  'commercial-team',
  'commercial-enterprise',
])

export async function loadStudioPackage(rootDir: string): Promise<StudioPackageDescriptor> {
  const resolvedRoot = path.resolve(rootDir)
  const manifestPath = path.join(resolvedRoot, FLOWIT_STUDIO_MANIFEST_FILENAME)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`unable to read Studio manifest ${manifestPath}: ${message}`, { cause: error })
  }
  return {
    rootDir: resolvedRoot,
    manifestPath,
    manifest: parseStudioPackageManifest(parsed),
  }
}

export function parseStudioPackageManifest(value: unknown): StudioPackageManifest {
  const object = requireObject(value, 'manifest')
  rejectUnknownKeys(object, TOP_LEVEL_KEYS, 'manifest')
  if (object.schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1')

  const id = requireString(object.id, 'manifest.id')
  if (!PACKAGE_ID.test(id)) throw new Error('manifest.id must use lowercase letters, numbers, dots, and hyphens')
  const displayName = requireString(object.displayName, 'manifest.displayName')
  const description = optionalString(object.description, 'manifest.description')
  const version = requireString(object.version, 'manifest.version')
  if (!SEMVER.test(version)) throw new Error('manifest.version must be semantic versioning')

  const publisher = parsePublisher(object.publisher)
  const runtime = requireObject(object.runtime, 'manifest.runtime')
  rejectUnknownKeys(runtime, RUNTIME_KEYS, 'manifest.runtime')
  if (runtime.id !== 'flowit-workflow') throw new Error('manifest.runtime.id must be flowit-workflow')
  const runtimeVersion = requireString(runtime.version, 'manifest.runtime.version')
  if (runtime.bootstrap !== 'official') throw new Error('manifest.runtime.bootstrap must be official')

  const supportedHosts = requireUniqueStringArray(object.supportedHosts, 'manifest.supportedHosts')
  if (supportedHosts.length === 0) throw new Error('manifest.supportedHosts must not be empty')
  const entryPreset = requireString(object.entryPreset, 'manifest.entryPreset')
  if (!PRESET_ID.test(entryPreset)) throw new Error('manifest.entryPreset must be kebab-case')

  const license = parseLicense(object.license)
  const permissions = parsePermissions(object.permissions)
  const metadata = parseMetadata(object.metadata)

  return {
    schemaVersion: 1,
    id,
    displayName,
    ...(description ? { description } : {}),
    publisher,
    version,
    runtime: { id: 'flowit-workflow', version: runtimeVersion, bootstrap: 'official' },
    supportedHosts,
    entryPreset,
    license,
    ...(permissions ? { permissions } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

function parsePublisher(value: unknown): StudioPublisherDescriptor {
  const object = requireObject(value, 'manifest.publisher')
  rejectUnknownKeys(object, PUBLISHER_KEYS, 'manifest.publisher')
  const id = requireString(object.id, 'manifest.publisher.id')
  if (!PACKAGE_ID.test(id)) throw new Error('manifest.publisher.id has an invalid format')
  const displayName = optionalString(object.displayName, 'manifest.publisher.displayName')
  const homepage = optionalString(object.homepage, 'manifest.publisher.homepage')
  if (homepage) {
    try {
      new URL(homepage)
    } catch {
      throw new Error('manifest.publisher.homepage must be a valid URL')
    }
  }
  return { id, ...(displayName ? { displayName } : {}), ...(homepage ? { homepage } : {}) }
}

function parseLicense(value: unknown): StudioLicenseDescriptor {
  const object = requireObject(value, 'manifest.license')
  rejectUnknownKeys(object, LICENSE_KEYS, 'manifest.license')
  const type = requireString(object.type, 'manifest.license.type') as StudioLicenseType
  if (!LICENSE_TYPES.has(type)) throw new Error(`unsupported Studio license type ${type}`)
  const licenseId = optionalString(object.licenseId, 'manifest.license.licenseId')
  const notice = optionalString(object.notice, 'manifest.license.notice')
  return { type, ...(licenseId ? { licenseId } : {}), ...(notice ? { notice } : {}) }
}

function parsePermissions(value: unknown): StudioPermissionRequirement[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('manifest.permissions must be an array')
  return value.map((entry, index) => {
    const object = requireObject(entry, `manifest.permissions[${index}]`)
    rejectUnknownKeys(object, PERMISSION_KEYS, `manifest.permissions[${index}]`)
    const risk = requireString(object.risk, `manifest.permissions[${index}].risk`)
    if (risk !== 'standard' && risk !== 'elevated') {
      throw new Error(`manifest.permissions[${index}].risk must be standard or elevated`)
    }
    return {
      id: requireString(object.id, `manifest.permissions[${index}].id`),
      description: requireString(object.description, `manifest.permissions[${index}].description`),
      risk,
      reason: requireString(object.reason, `manifest.permissions[${index}].reason`),
    }
  })
}

function parseMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const object = requireObject(value, 'manifest.metadata')
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, requireString(entry, `manifest.metadata.${key}`)]),
  )
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(object).filter(key => !allowed.has(key))
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, label)
}

function requireUniqueStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const values = value.map((entry, index) => requireString(entry, `${label}[${index}]`))
  if (new Set(values).size !== values.length) throw new Error(`${label} must contain unique values`)
  return values
}
