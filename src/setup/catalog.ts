import type { SetupHostId } from './types.js'

export interface SetupHostDescriptor {
  readonly id: SetupHostId
  readonly displayName: string
  readonly integrationMode: 'native' | 'plugin' | 'mcp' | 'hybrid' | 'bridge'
}

export const KNOWN_SETUP_HOSTS = [
  { id: 'workbuddy', displayName: 'WorkBuddy', integrationMode: 'hybrid' },
  { id: 'claude-code', displayName: 'Claude Code', integrationMode: 'plugin' },
  { id: 'codex', displayName: 'Codex', integrationMode: 'mcp' },
  { id: 'opencode', displayName: 'OpenCode', integrationMode: 'mcp' },
  { id: 'dsh', displayName: 'DeepSeek Harness', integrationMode: 'native' },
  { id: 'doubao-office', displayName: '豆包办公', integrationMode: 'bridge' },
] as const satisfies readonly SetupHostDescriptor[]

const RUNTIME_ADAPTER_ID_OVERRIDES: Readonly<Partial<Record<SetupHostId, string>>> = {
  dsh: 'deepseek-harness',
}

export function knownSetupHost(id: string): SetupHostDescriptor | undefined {
  return KNOWN_SETUP_HOSTS.find(host => host.id === id)
}

export function runtimeAdapterIdForSetupHost(id: string): string {
  const host = knownSetupHost(id)
  if (!host) throw new Error(`unknown setup host ${id}`)
  return RUNTIME_ADAPTER_ID_OVERRIDES[host.id] ?? host.id
}
