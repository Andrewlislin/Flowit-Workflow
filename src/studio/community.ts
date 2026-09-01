import path from 'node:path'
import { validateStudioProject, type StudioValidationResult } from './sdk.js'

export const COMMUNITY_STUDIO_IDS = [
  'content-studio',
  'research-lab',
  'agent-team',
] as const

export type CommunityStudioId = (typeof COMMUNITY_STUDIO_IDS)[number]

export function communityStudioRoot(packageRoot: string, id: CommunityStudioId): string {
  if (!COMMUNITY_STUDIO_IDS.includes(id)) throw new Error(`unknown Community Studio ${id}`)
  return path.join(path.resolve(packageRoot), 'studios', 'community', id)
}

export async function validateCommunityStudios(packageRoot: string): Promise<StudioValidationResult[]> {
  const results: StudioValidationResult[] = []
  for (const id of COMMUNITY_STUDIO_IDS) {
    const validation = await validateStudioProject(communityStudioRoot(packageRoot, id))
    if (validation.descriptor.manifest.entryPreset !== id) {
      throw new Error(`Community Studio ${id} must keep stable entryPreset id ${id}`)
    }
    results.push(validation)
  }
  return results
}
