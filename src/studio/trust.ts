export type StudioInstallGrant =
  | 'runtime-bootstrap'
  | 'standard-host-integration'
  | 'managed-package-files'

export const STANDARD_STUDIO_INSTALL_GRANTS = [
  'runtime-bootstrap',
  'standard-host-integration',
  'managed-package-files',
] as const satisfies readonly StudioInstallGrant[]

export interface StudioInstallIntent {
  readonly kind: 'studio-install'
  readonly studioId: string
  readonly source: string
  readonly initiatedByUser: true
  readonly grants: readonly StudioInstallGrant[]
  readonly createdAt: string
}

export function createStudioInstallIntent(input: {
  studioId: string
  source: string
  now?: () => Date
}): StudioInstallIntent {
  const studioId = input.studioId.trim()
  const source = input.source.trim()
  if (!studioId) throw new Error('studio install intent requires a studio id')
  if (!source) throw new Error('studio install intent requires a source')
  return {
    kind: 'studio-install',
    studioId,
    source,
    initiatedByUser: true,
    grants: [...STANDARD_STUDIO_INSTALL_GRANTS],
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  }
}

export function intentAuthorizesStandardInstall(
  intent: StudioInstallIntent,
  grant: StudioInstallGrant,
): boolean {
  return intent.initiatedByUser && intent.grants.includes(grant)
}
