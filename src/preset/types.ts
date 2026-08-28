import type { CreatePipelineInput } from '../core/types.js'

export interface PresetRoleDescriptor {
  readonly id: string
  readonly displayName: string
  readonly description: string
}

export interface PresetDescriptor {
  readonly version: 1
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly roles: readonly PresetRoleDescriptor[]
  readonly inputRequired: boolean
  readonly inputLabel: string
}

export interface PresetRoleBinding {
  readonly roleId: string
  readonly adapterId: string
  readonly sessionId: string
  readonly skills: readonly string[]
}

export interface PresetRenderRequest {
  readonly pipelineName: string
  readonly workspace: string
  readonly input?: string
  readonly bindings: Readonly<Record<string, PresetRoleBinding>>
}

export interface PresetDefinition extends PresetDescriptor {
  render(request: PresetRenderRequest): CreatePipelineInput
}

export interface PreparedPresetInstall {
  readonly kind: 'preset-install-plan'
  readonly preset: PresetDescriptor
  readonly pipelineName: string
  readonly storageFile: string
  readonly instanceId: string
  readonly workspace: string
  readonly defaultAdapterId?: string
  readonly bindings: readonly PresetRoleBinding[]
  readonly missingRoles: readonly string[]
  readonly action: 'incomplete' | 'create' | 'reuse'
  readonly existingPipelineId?: string
  readonly pipeline?: CreatePipelineInput
  readonly warnings: readonly string[]
}

export interface AppliedPresetInstall {
  readonly kind: 'preset-install-result'
  readonly presetId: string
  readonly action: 'created' | 'reused'
  readonly pipelineId: string
  readonly pipelineName: string
  readonly storageFile: string
  readonly instanceId: string
  readonly workspace: string
  readonly warnings: readonly string[]
}
