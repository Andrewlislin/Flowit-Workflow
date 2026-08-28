import { BUILT_IN_PRESETS } from './builtins.js'
import type { PresetDefinition } from './types.js'

export class PresetRegistry {
  private readonly presets = new Map<string, PresetDefinition>()

  constructor(presets: readonly PresetDefinition[] = []) {
    for (const preset of presets) this.register(preset)
  }

  register(preset: PresetDefinition): () => void {
    const id = preset.id.trim()
    if (!id) throw new Error('preset id must be non-empty')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`preset id must be kebab-case: ${id}`)
    if (this.presets.has(id)) throw new Error(`preset ${id} is already registered`)
    const roleIds = preset.roles.map(role => role.id)
    if (new Set(roleIds).size !== roleIds.length) throw new Error(`preset ${id} contains duplicate role ids`)
    this.presets.set(id, preset)
    return () => {
      if (this.presets.get(id) === preset) this.presets.delete(id)
    }
  }

  get(id: string): PresetDefinition | undefined {
    return this.presets.get(id)
  }

  require(id: string): PresetDefinition {
    const preset = this.get(id)
    if (!preset) throw new Error(`unknown preset ${id}`)
    return preset
  }

  list(): PresetDefinition[] {
    return [...this.presets.values()]
  }
}

export function createDefaultPresetRegistry(
  presets: readonly PresetDefinition[] = [],
): PresetRegistry {
  return new PresetRegistry([...BUILT_IN_PRESETS, ...presets])
}
