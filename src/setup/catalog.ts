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

export function knownSetupHost(id: string): SetupHostDescriptor | undefined {
  return KNOWN_SETUP_HOSTS.find(host => host.id === id)
}
