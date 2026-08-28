import { access } from 'node:fs/promises'
import path from 'node:path'
import type { DoctorCheck, DoctorReport, HostSetupContext } from './types.js'
import type { HostSetupRegistry } from './registry.js'

export async function doctorSetupFramework(
  context: HostSetupContext,
  registry: HostSetupRegistry,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  checks.push({
    id: 'node-version',
    status: supportedNodeVersion(context.nodeVersion) ? 'ok' : 'error',
    summary: supportedNodeVersion(context.nodeVersion)
      ? `Node.js ${context.nodeVersion} satisfies Flowit Workflow requirements`
      : `Node.js ${context.nodeVersion} is unsupported; require ^22.19.0 or >=24.0.0`,
    repairable: false,
  })

  try {
    await access(path.join(context.packageRoot, 'package.json'))
    checks.push({
      id: 'package-root',
      status: 'ok',
      summary: `Flowit package root is readable at ${context.packageRoot}`,
    })
  } catch (error: unknown) {
    checks.push({
      id: 'package-root',
      status: 'error',
      summary: `Flowit package root is not readable at ${context.packageRoot}`,
      detail: error instanceof Error ? error.message : String(error),
      repairable: false,
    })
  }

  const providerCount = registry.list().length
  checks.push({
    id: 'setup-providers',
    status: providerCount > 0 ? 'ok' : 'warning',
    summary:
      providerCount > 0
        ? `${providerCount} host setup provider${providerCount === 1 ? '' : 's'} registered`
        : 'No host setup providers are registered in this build yet',
  })

  return {
    hostId: 'flowit-workflow',
    displayName: 'Flowit Workflow setup framework',
    status: deriveDoctorStatus(checks),
    checks,
  }
}

export function supportedNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major >= 24) return true
  return major === 22 && minor >= 19
}

function deriveDoctorStatus(checks: readonly DoctorCheck[]): DoctorReport['status'] {
  if (checks.some(check => check.status === 'error')) return 'unhealthy'
  if (checks.some(check => check.status === 'warning')) return 'degraded'
  return 'healthy'
}
