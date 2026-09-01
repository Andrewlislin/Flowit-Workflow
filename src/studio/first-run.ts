import type { AppliedStudioInstallTransaction } from './install.js'
import type { StudioPackageManifest } from './types.js'

export type StudioFirstRunGuide =
  | {
      readonly state: 'installation-complete'
      readonly installationReady: true
      readonly directExecutionAvailable: false
      readonly message: string
      readonly entryPresetId: string
      readonly manualSteps: readonly []
    }
  | {
      readonly state: 'pending-manual-action'
      readonly installationReady: false
      readonly directExecutionAvailable: false
      readonly message: string
      readonly manualSteps: readonly string[]
    }
  | {
      readonly state: 'repair-required'
      readonly installationReady: false
      readonly directExecutionAvailable: false
      readonly message: string
      readonly manualSteps: readonly string[]
      readonly warnings: readonly string[]
    }

export function createStudioFirstRunGuide(
  manifest: StudioPackageManifest,
  transaction: Pick<
    AppliedStudioInstallTransaction,
    'status' | 'manualSteps' | 'warnings'
  >,
): StudioFirstRunGuide {
  if (transaction.status === 'complete') {
    return {
      state: 'installation-complete',
      installationReady: true,
      directExecutionAvailable: false,
      message: `${manifest.displayName} 的安装与 Host 集成已完成。当前版本尚未提供通用的已安装第三方 Studio 直接运行入口。`,
      entryPresetId: manifest.entryPreset,
      manualSteps: [],
    }
  }
  if (transaction.status === 'manual-action-required') {
    return {
      state: 'pending-manual-action',
      installationReady: false,
      directExecutionAvailable: false,
      message: `${manifest.displayName} 已安装，但还需要完成宿主 Agent 的信任/手动步骤。`,
      manualSteps: [...transaction.manualSteps],
    }
  }
  return {
    state: 'repair-required',
    installationReady: false,
    directExecutionAvailable: false,
    message: `${manifest.displayName} 的安装或健康检查未完整通过，请先修复。`,
    manualSteps: [...transaction.manualSteps],
    warnings: [...transaction.warnings],
  }
}
