import { ClaudeCodeSetupProvider } from './providers/claude-code.js'
import { CodexSetupProvider } from './providers/codex.js'
import { WorkBuddySetupProvider } from './providers/workbuddy.js'
import type { HostDetection, HostSetupContext, HostSetupProvider, SetupHostId } from './types.js'

export class HostSetupRegistry {
  private readonly providers = new Map<SetupHostId, HostSetupProvider>()

  constructor(providers: readonly HostSetupProvider[] = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: HostSetupProvider): () => void {
    const id = provider.id.trim()
    if (!id) throw new Error('setup provider id must be non-empty')
    if (!provider.displayName.trim()) throw new Error(`setup provider ${id} displayName must be non-empty`)
    if (this.providers.has(id)) throw new Error(`setup provider ${id} is already registered`)
    this.providers.set(id, provider)
    return () => {
      if (this.providers.get(id) === provider) this.providers.delete(id)
    }
  }

  get(id: SetupHostId): HostSetupProvider | undefined {
    return this.providers.get(id)
  }

  require(id: SetupHostId): HostSetupProvider {
    const provider = this.get(id)
    if (!provider) throw new Error(`setup provider ${id} is not registered`)
    return provider
  }

  list(): HostSetupProvider[] {
    return [...this.providers.values()]
  }

  async detectAll(context: HostSetupContext): Promise<HostDetection[]> {
    return Promise.all(
      this.list().map(async provider => {
        try {
          return await provider.detect(context)
        } catch (error: unknown) {
          return {
            hostId: provider.id,
            displayName: provider.displayName,
            status: 'unknown' as const,
            message: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
  }
}

export function createDefaultHostSetupRegistry(
  providers: readonly HostSetupProvider[] = [],
): HostSetupRegistry {
  return new HostSetupRegistry([
    new WorkBuddySetupProvider(),
    new ClaudeCodeSetupProvider(),
    new CodexSetupProvider(),
    ...providers,
  ])
}
