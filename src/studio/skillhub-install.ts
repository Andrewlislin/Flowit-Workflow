import os from 'node:os'
import path from 'node:path'
import {
  installStudioForCurrentAgent,
  type AppliedConsumerStudioInstall,
  type ConsumerStudioInstallOptions,
  type ConsumerStudioInstallRuntime,
} from './consumer.js'
import { SkillHubPayloadStore } from './distribution.js'

export type SkillHubPayloadInstallOptions = Omit<
  ConsumerStudioInstallOptions,
  'sourceRoot' | 'sourceLabel' | 'expectedSourceDigest'
> & {
  readonly payloadRoot: string
}

/**
 * Trusted SkillHub entrypoint. The external channel payload is copied into a
 * Flowit-owned snapshot before metadata/manifest identity is evaluated. The
 * Studio child installation is then fenced to the digest of snapshot/studio.
 * If a compatible Runtime handoff is needed, #31 creates its own Studio
 * snapshot before this outer payload snapshot is released.
 */
export async function installSkillHubPayloadForCurrentAgent(
  options: SkillHubPayloadInstallOptions,
  runtime: ConsumerStudioInstallRuntime = {},
): Promise<AppliedConsumerStudioInstall> {
  const payloadStore = new SkillHubPayloadStore({
    rootDir: path.join(
      runtime.homeDir ?? os.homedir(),
      '.flowit-workflow',
      'skillhub-payloads',
    ),
  })
  const snapshot = await payloadStore.stageFromDirectory(options.payloadRoot)
  try {
    await payloadStore.assertSnapshotUnchanged(snapshot)
    return await installStudioForCurrentAgent(
      {
        sourceRoot: snapshot.studioDir,
        expectedSourceDigest: snapshot.studioDigest,
        sourceLabel: 'skillhub',
        ...(options.projectDir ? { projectDir: options.projectDir } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.hostId ? { hostId: options.hostId } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.trustStore ? { trustStore: options.trustStore } : {}),
        ...(options.license ? { license: options.license } : {}),
        ...(options.allowElevated ? { allowElevated: true } : {}),
        ...(options.storeRoot ? { storeRoot: options.storeRoot } : {}),
      },
      runtime,
    )
  } finally {
    await payloadStore.discardSnapshot(snapshot).catch(() => undefined)
  }
}
