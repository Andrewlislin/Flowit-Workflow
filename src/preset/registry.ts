import { knownSetupHost, runtimeAdapterIdForSetupHost } from '../setup/catalog.js'
import { BUILT_IN_PRESETS } from './builtins.js'
import type { PresetDefinition } from './types.js'

export class PresetRegistry {
  private readonly presets = new Map<string, PresetDefinition>()
  private readonly references = new Map<string, string>()

  constructor(presets: readonly PresetDefinition[] = []) {
    for (const preset of presets) this.register(preset)
  }

  register(preset: PresetDefinition): () => void {
    const id = preset.id.trim()
    if (!id) throw new Error('preset id must be non-empty')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`preset id must be kebab-case: ${id}`)
    if (!preset.displayName.trim()) throw new Error(`preset ${id} displayName must be non-empty`)
    if (this.presets.has(id)) throw new Error(`preset ${id} is already registered`)

    const roleIds = preset.roles.map(role => role.id)
    if (new Set(roleIds).size !== roleIds.length) throw new Error(`preset ${id} contains duplicate role ids`)

    const refs = [id, preset.displayName, ...(preset.aliases ?? [])]
    const normalizedRefs = [...new Set(refs.map(normalizeReference).filter(Boolean))]
    for (const reference of normalizedRefs) {
      const owner = this.references.get(reference)
      if (owner && owner !== id) throw new Error(`preset reference ${reference} is already registered by ${owner}`)
    }

    this.presets.set(id, preset)
    for (const reference of normalizedRefs) this.references.set(reference, id)
    return () => {
      if (this.presets.get(id) !== preset) return
      this.presets.delete(id)
      for (const [reference, owner] of this.references) {
        if (owner === id) this.references.delete(reference)
      }
    }
  }

  get(reference: string): PresetDefinition | undefined {
    const value = reference.trim()
    if (!value) return undefined
    const direct = this.presets.get(value)
    if (direct) return direct
    const id = this.references.get(normalizeReference(value))
    return id ? this.presets.get(id) : undefined
  }

  require(reference: string): PresetDefinition {
    const preset = this.get(reference)
    if (!preset) throw new Error(`unknown preset ${reference}`)
    return {
      version: preset.version,
      id: preset.id,
      displayName: preset.displayName,
      ...(preset.aliases ? { aliases: preset.aliases } : {}),
      description: preset.description,
      roles: preset.roles,
      inputRequired: preset.inputRequired,
      inputLabel: preset.inputLabel,
      render(request) {
        const pipeline = preset.render(request)
        return {
          ...pipeline,
          nodes: pipeline.nodes.map(node => {
            const adapterId = node.target.adapterId?.trim()
            if (!adapterId || !knownSetupHost(adapterId)) return node
            return {
              ...node,
              target: {
                ...node.target,
                adapterId: runtimeAdapterIdForSetupHost(adapterId),
              },
            }
          }),
        }
      },
    }
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

function normalizeReference(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}
