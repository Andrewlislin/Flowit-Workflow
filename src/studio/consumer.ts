import os from 'node:os'
import path from 'node:path'
import {
  bootstrapStudioRuntime,
  type OfficialRuntimeResolverOptions,
  type ResolvedOfficialFlowitRuntime,
} from './bootstrap.js'
import { resolveCurrentAgentContext, type CurrentAgentContext } from './context.js'
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
}

export interface PreparedConsumerStudioInstall {
  readonly context: CurrentAgentContext
  readonly transaction: PreparedStudioInstallTransaction
}

export interface AppliedConsumerStudioInstall {
  readonly context: CurrentAgentContext
  readonly transaction: AppliedStudioInstallTransaction
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

  // Freeze publisher-controlled bytes before runtime/Host decisions. If a compatible
  // runtime handoff is required, this exact snapshot remains alive until the child
  // finishes and is passed as the child install source with its digest as a fence.
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
  const setupContext = createHostSetupContext(runtime)
  const setupRegistry = runtime.setupRegistry ?? createDefaultHostSetupRegistry()
  const prepared = await prepareStudioForCurrentAgent(options, {
    ...runtime,
    setupRegistry,
  })
  const packageStore = new StudioPackageStore({
    rootDir:
      options.storeRoot ??
      path.join(runtime.homeDir ?? os.homedir(), '.flowit-workflow', 'studios'),
  })
  const transaction = await applyStudioInstallTransaction(
    prepared.transaction,
    setupContext,
    setupRegistry,
    packageStore,
    { ...(options.allowElevated ? { allowElevated: true } : {}) },
  )
  return { context: prepared.context, transaction }
}
