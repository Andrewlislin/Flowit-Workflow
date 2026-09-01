import os from 'node:os'
import path from 'node:path'
import {
  bootstrapStudioRuntime,
  type OfficialRuntimeResolverOptions,
  type ResolvedOfficialFlowitRuntime,
} from './bootstrap.js'
import { resolveCurrentAgentContext, type CurrentAgentContext } from './context.js'
import {
  bestEffortRecordStudioExperience,
  type StudioExperienceFailureStage,
  type StudioExperienceRecorderOptions,
} from './diagnostics.js'
import { createStudioFirstRunGuide, type StudioFirstRunGuide } from './first-run.js'
import {
  applyStudioInstallTransaction,
  prepareStudioInstallTransaction,
  type AppliedStudioInstallTransaction,
  type PreparedStudioInstallTransaction,
} from './install.js'
import type { StudioLicenseDocumentV1 } from './license.js'
import { flowitRuntimeVersionSatisfies } from './runtime-range.js'
import { currentFlowitPackageVersion } from './sdk.js'
import type { StudioTrustStore } from './signing.js'
import { StudioPackageStore, type StudioPackageSnapshot } from './store.js'
import { createStudioInstallIntent } from './trust.js'
import { createHostSetupContext, type HostSetupContextOptions } from '../setup/context.js'
import {
  createDefaultHostSetupRegistry,
  type HostSetupRegistry,
} from '../setup/registry.js'
import type { SetupScope } from '../setup/types.js'

export interface ConsumerStudioInstallOptions {
  readonly sourceRoot: string
  readonly projectDir?: string
  readonly scope?: SetupScope
  readonly hostId?: string
  readonly sessionId?: string
  readonly workspace?: string
  readonly sourceLabel?: string
  /** Internal continuation fence used when a compatible Flowit runtime resumes a frozen install. */
  readonly expectedSourceDigest?: string
  readonly trustStore?: StudioTrustStore
  readonly license?: StudioLicenseDocumentV1
  readonly allowElevated?: boolean
  readonly storeRoot?: string
}

export interface ConsumerStudioInstallRuntime extends HostSetupContextOptions {
  readonly setupRegistry?: HostSetupRegistry
  readonly bootstrap?: OfficialRuntimeResolverOptions
  readonly diagnostics?: StudioExperienceRecorderOptions
  readonly now?: () => Date
}

export interface PreparedConsumerStudioInstall {
  readonly context: CurrentAgentContext
  readonly transaction: PreparedStudioInstallTransaction
}

export interface AppliedConsumerStudioInstall {
  readonly context: CurrentAgentContext
  readonly transaction: AppliedStudioInstallTransaction
  readonly firstRun: StudioFirstRunGuide
}

export class StudioRuntimeHandoffRequired extends Error {
  readonly runtime: ResolvedOfficialFlowitRuntime
  readonly requiredRange: string
  readonly snapshot: StudioPackageSnapshot
  readonly sourceLabel: string
  private released = false
  private readonly releaseSnapshotFn: () => Promise<void>

  constructor(
    runtime: ResolvedOfficialFlowitRuntime,
    requiredRange: string,
    snapshot: StudioPackageSnapshot,
    sourceLabel: string,
    releaseSnapshot: () => Promise<void>,
  ) {
    super(
      `Studio requires Flowit ${requiredRange}; compatible official runtime ${runtime.version} was prepared and must continue the frozen installation snapshot`,
    )
    this.name = 'StudioRuntimeHandoffRequired'
    this.runtime = runtime
    this.requiredRange = requiredRange
    this.snapshot = snapshot
    this.sourceLabel = sourceLabel
    this.releaseSnapshotFn = releaseSnapshot
  }

  async releaseSnapshot(): Promise<void> {
    if (this.released) return
    this.released = true
    await this.releaseSnapshotFn()
  }
}

export async function prepareStudioForCurrentAgent(
  options: ConsumerStudioInstallOptions,
  runtime: ConsumerStudioInstallRuntime = {},
): Promise<PreparedConsumerStudioInstall> {
  const setupContext = createHostSetupContext(runtime)
  const setupRegistry = runtime.setupRegistry ?? createDefaultHostSetupRegistry()
  const projectDir = path.resolve(options.projectDir ?? setupContext.cwd)
  const packageStore = new StudioPackageStore({
    rootDir:
      options.storeRoot ??
      path.join(runtime.homeDir ?? os.homedir(), '.flowit-workflow', 'studios'),
  })

  const preflightSnapshot = await packageStore.stageFromDirectory(options.sourceRoot)
  let handoff: StudioRuntimeHandoffRequired | undefined
  try {
    if (
      options.expectedSourceDigest &&
      preflightSnapshot.digest !== options.expectedSourceDigest
    ) {
      throw new Error(
        'Studio handoff snapshot digest does not match the bytes frozen by the previous runtime',
      )
    }

    const manifest = preflightSnapshot.manifest
    const sourceLabel = options.sourceLabel ?? path.resolve(options.sourceRoot)
    const intent = createStudioInstallIntent({
      studioId: manifest.id,
      source: sourceLabel,
      ...(runtime.now ? { now: runtime.now } : {}),
    })

    const currentVersion = await currentFlowitPackageVersion()
    if (!flowitRuntimeVersionSatisfies(currentVersion, manifest.runtime.version)) {
      const compatible = await bootstrapStudioRuntime(
        intent,
        manifest.runtime.version,
        {
          ...(runtime.bootstrap ?? {}),
          ...(runtime.homeDir ? { homeDir: runtime.homeDir } : {}),
        },
      )
      handoff = new StudioRuntimeHandoffRequired(
        compatible,
        manifest.runtime.version,
        preflightSnapshot,
        sourceLabel,
        () => packageStore.discardSnapshot(preflightSnapshot),
      )
      throw handoff
    }

    const context = await resolveCurrentAgentContext(
      manifest,
      {
        ...(options.hostId ? { hostId: options.hostId } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        projectDir,
        env: setupContext.env,
      },
      setupContext,
      setupRegistry,
    )

    const transaction = await prepareStudioInstallTransaction(
      {
        sourceRoot: preflightSnapshot.snapshotDir,
        hostId: context.hostId,
        scope: options.scope ?? 'user',
        projectDir,
        intent,
        ...(options.trustStore ? { trustStore: options.trustStore } : {}),
        ...(options.license ? { license: options.license } : {}),
        ...(runtime.now ? { now: runtime.now() } : {}),
      },
      setupContext,
      setupRegistry,
      packageStore,
    )
    if (transaction.snapshot.digest !== preflightSnapshot.digest) {
      await packageStore.discardSnapshot(transaction.snapshot).catch(() => undefined)
      throw new Error('Studio package bytes changed between runtime preflight and install review')
    }
    return { context, transaction }
  } finally {
    if (!handoff) {
      await packageStore.discardSnapshot(preflightSnapshot).catch(() => undefined)
    }
  }
}

export async function installStudioForCurrentAgent(
  options: ConsumerStudioInstallOptions,
  runtime: ConsumerStudioInstallRuntime = {},
): Promise<AppliedConsumerStudioInstall> {
  const startedAt = Date.now()
  const now = runtime.now ?? (() => new Date())
  const diagnostics = runtime.diagnostics ?? {}
  const setupContext = createHostSetupContext(runtime)
  const setupRegistry = runtime.setupRegistry ?? createDefaultHostSetupRegistry()
  let prepared: PreparedConsumerStudioInstall

  try {
    prepared = await prepareStudioForCurrentAgent(options, { ...runtime, setupRegistry })
  } catch (error: unknown) {
    if (error instanceof StudioRuntimeHandoffRequired) {
      await bestEffortRecordStudioExperience(
        {
          version: 1,
          event: 'runtime_bootstrap_success',
          at: now().toISOString(),
          studioId: error.snapshot.manifest.id,
          studioVersion: error.snapshot.manifest.version,
          durationMs: Date.now() - startedAt,
        },
        diagnostics,
      )
      throw error
    }
    await bestEffortRecordStudioExperience(
      {
        version: 1,
        event: 'studio_install_failed',
        at: now().toISOString(),
        durationMs: Date.now() - startedAt,
        failureStage: 'preflight',
      },
      diagnostics,
    )
    throw error
  }

  const packageStore = new StudioPackageStore({
    rootDir:
      options.storeRoot ??
      path.join(runtime.homeDir ?? os.homedir(), '.flowit-workflow', 'studios'),
  })
  try {
    const transaction = await applyStudioInstallTransaction(
      prepared.transaction,
      setupContext,
      setupRegistry,
      packageStore,
      { ...(options.allowElevated ? { allowElevated: true } : {}) },
    )
    const common = {
      version: 1 as const,
      at: now().toISOString(),
      studioId: transaction.studioId,
      studioVersion: transaction.version,
      hostId: prepared.context.hostId,
      durationMs: Date.now() - startedAt,
    }
    if (transaction.status === 'complete') {
      await bestEffortRecordStudioExperience(
        { ...common, event: 'host_setup_success' },
        diagnostics,
      )
      await bestEffortRecordStudioExperience(
        { ...common, event: 'studio_install_success' },
        diagnostics,
      )
    } else if (transaction.status === 'manual-action-required') {
      await bestEffortRecordStudioExperience(
        { ...common, event: 'studio_install_pending_manual' },
        diagnostics,
      )
    } else {
      await bestEffortRecordStudioExperience(
        {
          ...common,
          event: 'studio_install_failed',
          failureStage: failureStageForResult(transaction),
        },
        diagnostics,
      )
    }
    return {
      context: prepared.context,
      transaction,
      firstRun: createStudioFirstRunGuide(transaction.installed.manifest, transaction),
    }
  } catch (error: unknown) {
    await bestEffortRecordStudioExperience(
      {
        version: 1,
        event: 'studio_install_failed',
        at: now().toISOString(),
        studioId: prepared.transaction.snapshot.manifest.id,
        studioVersion: prepared.transaction.snapshot.manifest.version,
        hostId: prepared.context.hostId,
        durationMs: Date.now() - startedAt,
        failureStage:
          error instanceof Error && /host integration failed/i.test(error.message)
            ? 'host-setup'
            : 'package-install',
      },
      diagnostics,
    )
    throw error
  }
}

function failureStageForResult(
  transaction: AppliedStudioInstallTransaction,
): StudioExperienceFailureStage {
  return transaction.hostSetup.results.some(
    result => result.status === 'failed' || result.status === 'unsupported',
  )
    ? 'host-setup'
    : 'doctor'
}
