import path from 'node:path'
import type { HostSetupContext } from '../setup/types.js'
import type { HostSetupRegistry } from '../setup/registry.js'
import type { StudioPackageManifest } from './types.js'

export interface CurrentAgentContext {
  readonly hostId: string
  readonly sessionId?: string
  readonly workspace: string
  readonly source: 'explicit' | 'environment' | 'detected'
}

export interface ResolveCurrentAgentContextOptions {
  readonly hostId?: string
  readonly sessionId?: string
  readonly workspace?: string
  readonly projectDir: string
  readonly env?: Readonly<NodeJS.ProcessEnv>
}

export async function resolveCurrentAgentContext(
  manifest: StudioPackageManifest,
  options: ResolveCurrentAgentContextOptions,
  setupContext: HostSetupContext,
  setupRegistry: HostSetupRegistry,
): Promise<CurrentAgentContext> {
  const env = options.env ?? setupContext.env
  const explicitHost = options.hostId?.trim()
  const environmentHost = env.FLOWIT_WORKFLOW_ADAPTER?.trim()
  let hostId: string
  let source: CurrentAgentContext['source']

  if (explicitHost) {
    hostId = explicitHost
    source = 'explicit'
  } else if (environmentHost) {
    hostId = environmentHost
    source = 'environment'
  } else {
    const supported = new Set(manifest.supportedHosts)
    const detected = (await setupRegistry.detectAll(setupContext))
      .filter(row => row.status === 'detected' && supported.has(row.hostId))
      .map(row => row.hostId)
    if (detected.length === 0) {
      throw new Error(
        `no supported Agent host was detected for Studio ${manifest.id}; supported hosts: ${manifest.supportedHosts.join(', ')}`,
      )
    }
    if (detected.length > 1) {
      throw new Error(
        `multiple supported Agent hosts are available (${detected.join(', ')}); the invoking Agent must identify the current host`,
      )
    }
    hostId = detected[0]!
    source = 'detected'
  }

  if (!manifest.supportedHosts.includes(hostId)) {
    throw new Error(`Studio ${manifest.id} does not support current host ${hostId}`)
  }
  if (!setupRegistry.get(hostId)) throw new Error(`Flowit has no Setup Provider for current host ${hostId}`)

  const sessionId = options.sessionId?.trim() || env.FLOWIT_WORKFLOW_SESSION_ID?.trim()
  const workspace = path.resolve(
    options.projectDir,
    options.workspace?.trim() || env.FLOWIT_WORKFLOW_WORKSPACE?.trim() || '.',
  )
  return { hostId, ...(sessionId ? { sessionId } : {}), workspace, source }
}
