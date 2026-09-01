import { sign, verify, type KeyObject } from 'node:crypto'
import type { StudioLicenseType } from './types.js'
import type { StudioTrustedPublisherKey, StudioTrustStore } from './signing.js'

export type StudioLicenseEdition = 'personal' | 'team' | 'enterprise'

export interface StudioLicensePayloadV1 {
  readonly version: 1
  readonly licenseId: string
  readonly packageId: string
  readonly publisherId: string
  readonly edition: StudioLicenseEdition
  readonly majorVersion: number
  readonly issuedAt: string
  readonly updatesUntil?: string
  readonly holder?: string
  /** Signed entitlement metadata. Flowit does not claim cloud-wide seat consumption tracking. */
  readonly seats?: number
}

export interface StudioLicenseDocumentV1 extends StudioLicensePayloadV1 {
  readonly signature: {
    readonly algorithm: 'ed25519'
    readonly keyId: string
    readonly value: string
  }
}

export interface VerifiedStudioLicense {
  readonly document: StudioLicenseDocumentV1
  readonly publisherKey: StudioTrustedPublisherKey
  readonly updatesEligible: boolean
}

export function createStudioLicense(
  payload: StudioLicensePayloadV1,
  keyId: string,
  privateKey: string | KeyObject,
): StudioLicenseDocumentV1 {
  validateStudioLicensePayload(payload)
  const value = sign(
    null,
    Buffer.from(canonicalLicensePayload(payload), 'utf8'),
    privateKey,
  ).toString('base64')
  return {
    ...payload,
    signature: { algorithm: 'ed25519', keyId: keyId.trim(), value },
  }
}

export function verifyStudioLicense(
  document: StudioLicenseDocumentV1,
  trustStore: StudioTrustStore,
  expected: {
    packageId: string
    publisherId: string
    packageVersion: string
    licenseType: StudioLicenseType
    now?: Date
  },
): VerifiedStudioLicense {
  validateStudioLicensePayload(document)
  if (!document.signature || document.signature.algorithm !== 'ed25519') {
    throw new Error('Studio license signature algorithm must be ed25519')
  }
  if (!document.signature.keyId.trim() || !document.signature.value.trim()) {
    throw new Error('Studio license signature requires keyId and value')
  }
  if (document.packageId !== expected.packageId) {
    throw new Error('Studio license is for a different package')
  }
  if (document.publisherId !== expected.publisherId) {
    throw new Error('Studio license publisher does not match package publisher')
  }
  if (!editionAllowedForLicenseType(document.edition, expected.licenseType)) {
    throw new Error(
      `Studio ${expected.licenseType} package does not accept a ${document.edition} license`,
    )
  }
  const major = packageMajor(expected.packageVersion)
  if (document.majorVersion !== major) {
    throw new Error(
      `Studio license covers major version ${document.majorVersion}, package is major version ${major}`,
    )
  }
  const key = trustStore.get(document.publisherId, document.signature.keyId)
  if (!key) {
    throw new Error(
      `Studio license key ${document.publisherId}/${document.signature.keyId} is not trusted locally`,
    )
  }
  const ok = verify(
    null,
    Buffer.from(canonicalLicensePayload(document), 'utf8'),
    key.publicKey,
    Buffer.from(document.signature.value, 'base64'),
  )
  if (!ok) throw new Error('Studio license signature verification failed')
  const now = expected.now ?? new Date()
  const updatesEligible =
    !document.updatesUntil || now.getTime() <= Date.parse(document.updatesUntil)
  return { document, publisherKey: key, updatesEligible }
}

export function licenseRequiredFor(type: string): boolean {
  return (
    type === 'commercial-perpetual' ||
    type === 'commercial-team' ||
    type === 'commercial-enterprise'
  )
}

export function editionAllowedForLicenseType(
  edition: StudioLicenseEdition,
  licenseType: StudioLicenseType,
): boolean {
  switch (licenseType) {
    case 'commercial-perpetual':
      return true
    case 'commercial-team':
      return edition === 'team' || edition === 'enterprise'
    case 'commercial-enterprise':
      return edition === 'enterprise'
    case 'open-source':
    case 'freeware':
      return false
  }
}

function validateStudioLicensePayload(payload: StudioLicensePayloadV1): void {
  if (payload.version !== 1) throw new Error('Studio license version must be 1')
  for (const [label, value] of [
    ['licenseId', payload.licenseId],
    ['packageId', payload.packageId],
    ['publisherId', payload.publisherId],
    ['issuedAt', payload.issuedAt],
  ] as const) {
    if (!value.trim()) throw new Error(`Studio license ${label} must be non-empty`)
  }
  if (
    payload.edition !== 'personal' &&
    payload.edition !== 'team' &&
    payload.edition !== 'enterprise'
  ) {
    throw new Error('Studio license edition is invalid')
  }
  if (!Number.isSafeInteger(payload.majorVersion) || payload.majorVersion < 0) {
    throw new Error('Studio license majorVersion must be a non-negative integer')
  }
  if (!Number.isFinite(Date.parse(payload.issuedAt))) {
    throw new Error('Studio license issuedAt must be an ISO date')
  }
  if (payload.updatesUntil && !Number.isFinite(Date.parse(payload.updatesUntil))) {
    throw new Error('Studio license updatesUntil must be an ISO date')
  }
  if (
    payload.seats !== undefined &&
    (!Number.isSafeInteger(payload.seats) || payload.seats < 1)
  ) {
    throw new Error('Studio license seats must be a positive integer')
  }
  if (payload.edition === 'personal' && payload.seats !== undefined && payload.seats !== 1) {
    throw new Error('personal Studio licenses may cover only one seat')
  }
  if (payload.edition === 'team' && payload.seats === undefined) {
    throw new Error('team Studio licenses must declare the signed seat entitlement')
  }
}

function canonicalLicensePayload(payload: StudioLicensePayloadV1): string {
  return JSON.stringify({
    version: payload.version,
    licenseId: payload.licenseId,
    packageId: payload.packageId,
    publisherId: payload.publisherId,
    edition: payload.edition,
    majorVersion: payload.majorVersion,
    issuedAt: payload.issuedAt,
    ...(payload.updatesUntil ? { updatesUntil: payload.updatesUntil } : {}),
    ...(payload.holder ? { holder: payload.holder } : {}),
    ...(payload.seats !== undefined ? { seats: payload.seats } : {}),
  })
}

function packageMajor(version: string): number {
  const match = /^(\d+)\./.exec(version)
  if (!match) throw new Error(`invalid package semantic version ${version}`)
  return Number(match[1])
}
