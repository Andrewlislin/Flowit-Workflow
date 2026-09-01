export type StudioPackageId = string
export type StudioPublisherId = string
export type StudioHostId = string

export type StudioLicenseType =
  | 'open-source'
  | 'freeware'
  | 'commercial-perpetual'
  | 'commercial-team'
  | 'commercial-enterprise'

export interface StudioPublisherDescriptor {
  readonly id: StudioPublisherId
  readonly displayName?: string
  readonly homepage?: string
}

export interface StudioRuntimeRequirement {
  readonly id: 'flowit-workflow'
  readonly version: string
  /** Third-party packages may require Flowit, but only the official resolver may bootstrap it. */
  readonly bootstrap: 'official'
}

export interface StudioLicenseDescriptor {
  readonly type: StudioLicenseType
  readonly licenseId?: string
  readonly notice?: string
}

export type StudioPermissionRisk = 'standard' | 'elevated'

export interface StudioPermissionRequirement {
  readonly id: string
  readonly description: string
  readonly risk: StudioPermissionRisk
  readonly reason: string
}

export interface StudioPackageManifestV1 {
  readonly schemaVersion: 1
  readonly id: StudioPackageId
  readonly displayName: string
  readonly description?: string
  readonly publisher: StudioPublisherDescriptor
  readonly version: string
  readonly runtime: StudioRuntimeRequirement
  readonly supportedHosts: readonly StudioHostId[]
  readonly entryPreset: string
  readonly license: StudioLicenseDescriptor
  readonly permissions?: readonly StudioPermissionRequirement[]
  readonly metadata?: Readonly<Record<string, string>>
}

export type StudioPackageManifest = StudioPackageManifestV1

export interface StudioPackageDescriptor {
  readonly rootDir: string
  readonly manifestPath: string
  readonly manifest: StudioPackageManifest
}
