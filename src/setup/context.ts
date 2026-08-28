import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostSetupContext } from './types.js'

export interface HostSetupContextOptions {
  readonly cwd?: string
  readonly homeDir?: string
  readonly packageRoot?: string
  readonly env?: Readonly<NodeJS.ProcessEnv>
}

export function createHostSetupContext(
  options: HostSetupContextOptions = {},
): HostSetupContext {
  return {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    homeDir: path.resolve(options.homeDir ?? os.homedir()),
    packageRoot: path.resolve(
      options.packageRoot ?? path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url))),
    ),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    env: options.env ?? process.env,
  }
}
