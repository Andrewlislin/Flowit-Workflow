import assert from 'node:assert/strict'
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { HostSetupRegistry } from '../src/setup/registry.js'
import type {
  HostSetupContext,
  HostSetupProvider,
  SetupPlan,
  SetupResult,
} from '../src/setup/types.js'
import {
  assertSkillHubPayloadIdentity,
  communityStudioRoot,
  createSkillHubStudioBundle,
  installStudioForCurrentAgent,
  loadStudioPackage,
  runStudioCli,
  SkillHubPayloadStore,
  type SkillHubStudioMetadataV2,
} from '../src/studio/index.js'

function capture(): { stdout: Writable; read: () => string } {
  let text = ''
  return {
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString()
        callback()
      },
    }),
    read: () => text,
  }
}

class NoopClaudeProvider implements HostSetupProvider {
  readonly id = 'claude-code'
  readonly displayName = 'Claude Code Test Host'
  planCalls = 0

  async detect() {
    return { hostId: this.id, displayName: this.displayName, status: 'detected' as const }
  }

  async planSetup(
    _context: HostSetupContext,
    options: { scope: 'user' | 'project' },
  ): Promise<SetupPlan> {
    this.planCalls += 1
    return {
      version: 1,
      operation: 'setup',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: 'noop setup',
      actions: [],
      warnings: [],
      manualSteps: [],
    }
  }

  async applySetup(): Promise<SetupResult> {
    return {
      operation: 'setup',
      hostId: this.id,
      displayName: this.displayName,
      status: 'complete',
      appliedActions: [],
      skippedActions: [],
      warnings: [],
      manualSteps: [],
    }
  }

  async doctor() {
    return {
      hostId: this.id,
      displayName: this.displayName,
      status: 'healthy' as const,
      checks: [],
    }
  }

  async planRepair(
    context: HostSetupContext,
    _report: unknown,
    options: { scope: 'user' | 'project' },
  ) {
    return this.planSetup(context, options)
  }

  async applyRepair(): Promise<SetupResult> {
    return {
      operation: 'repair',
      hostId: this.id,
      displayName: this.displayName,
      status: 'complete',
      appliedActions: [],
      skippedActions: [],
      warnings: [],
      manualSteps: [],
    }
  }

  async planUninstall(
    _context: HostSetupContext,
    options: { scope: 'user' | 'project' },
  ): Promise<SetupPlan> {
    return {
      version: 1,
      operation: 'uninstall',
      hostId: this.id,
      displayName: this.displayName,
      scope: options.scope,
      summary: 'noop uninstall',
      actions: [],
      warnings: [],
      manualSteps: [],
    }
  }

  async applyUninstall(): Promise<SetupResult> {
    return {
      operation: 'uninstall',
      hostId: this.id,
      displayName: this.displayName,
      status: 'complete',
      appliedActions: [],
      skippedActions: [],
      warnings: [],
      manualSteps: [],
    }
  }
}

test('third-party SkillHub output is data-only and requires a channel-authenticated CoaseEdge installer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-skillhub-payload-'))
  try {
    const result = await createSkillHubStudioBundle(
      communityStudioRoot(process.cwd(), 'research-lab'),
      path.join(root, 'payload'),
    )
    const metadata = JSON.parse(
      await readFile(result.metadataFile, 'utf8'),
    ) as SkillHubStudioMetadataV2
    assert.equal(metadata.version, 2)
    assert.equal(metadata.kind, 'flowit-studio-payload')
    assert.deepEqual(metadata.installer, {
      publisherId: 'coaseedge',
      id: 'flowit-studio-installer',
      trust: 'channel-authenticated',
    })
    assert.equal(metadata.studio.licenseType, 'open-source')

    await assert.rejects(() => access(path.join(result.outputDir, 'SKILL.md')), /ENOENT/)
    await assert.rejects(() => access(path.join(result.outputDir, 'install.mjs')), /ENOENT/)
    await assert.rejects(() => access(path.join(result.outputDir, 'bootstrap')), /ENOENT/)
    const topLevel = await readdir(result.outputDir)
    assert.deepEqual(topLevel.sort(), ['flowit-skillhub.json', 'studio'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillHub payload rejects commercial-enterprise to freeware license downgrade', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-skillhub-license-'))
  const source = path.join(root, 'source')
  try {
    await cp(communityStudioRoot(process.cwd(), 'research-lab'), source, { recursive: true })
    const sourceManifestFile = path.join(source, 'flowit.package.json')
    const sourceManifest = JSON.parse(await readFile(sourceManifestFile, 'utf8')) as {
      license: { type: string }
    }
    sourceManifest.license.type = 'commercial-enterprise'
    await writeFile(sourceManifestFile, `${JSON.stringify(sourceManifest, null, 2)}\n`)

    const result = await createSkillHubStudioBundle(source, path.join(root, 'payload'))
    const metadata = JSON.parse(
      await readFile(result.metadataFile, 'utf8'),
    ) as SkillHubStudioMetadataV2
    assert.equal(metadata.studio.licenseType, 'commercial-enterprise')

    const manifestFile = path.join(result.studioDir, 'flowit.package.json')
    const downgraded = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      license: { type: string }
    }
    downgraded.license.type = 'freeware'
    await writeFile(manifestFile, `${JSON.stringify(downgraded, null, 2)}\n`)
    const replaced = await loadStudioPackage(result.studioDir)
    assert.throws(
      () => assertSkillHubPayloadIdentity(metadata, replaced.manifest),
      /licenseType/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Flowit-owned SkillHub snapshot binds checked payload A to installed Studio bytes even if source becomes B', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-skillhub-snapshot-'))
  const source = path.join(root, 'source')
  const payload = path.join(root, 'payload')
  const payloadStore = new SkillHubPayloadStore({ rootDir: path.join(root, 'payload-store') })
  try {
    await cp(communityStudioRoot(process.cwd(), 'research-lab'), source, { recursive: true })
    await createSkillHubStudioBundle(source, payload)
    const snapshot = await payloadStore.stageFromDirectory(payload)
    try {
      const frozenPrompt = await readFile(
        path.join(snapshot.studioDir, 'roles', 'researcher.md'),
        'utf8',
      )
      await writeFile(
        path.join(payload, 'studio', 'roles', 'researcher.md'),
        'Publisher replacement B after Flowit identity review.\n',
      )
      await payloadStore.assertSnapshotUnchanged(snapshot)

      const provider = new NoopClaudeProvider()
      const result = await installStudioForCurrentAgent(
        {
          sourceRoot: snapshot.studioDir,
          expectedSourceDigest: snapshot.studioDigest,
          sourceLabel: 'skillhub',
          hostId: 'claude-code',
          projectDir: root,
          storeRoot: path.join(root, 'studio-store'),
        },
        {
          cwd: root,
          homeDir: path.join(root, 'home'),
          setupRegistry: new HostSetupRegistry([provider]),
        },
      )
      assert.equal(result.transaction.status, 'complete')
      assert.equal(provider.planCalls, 1)
      assert.equal(
        await readFile(
          path.join(result.transaction.installed.installDir, 'roles', 'researcher.md'),
          'utf8',
        ),
        frozenPrompt,
      )
      assert.doesNotMatch(frozenPrompt, /replacement B/)
    } finally {
      await payloadStore.discardSnapshot(snapshot).catch(() => undefined)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tampering with the frozen SkillHub snapshot fails before Host setup mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-skillhub-frozen-tamper-'))
  const payload = path.join(root, 'payload')
  const payloadStore = new SkillHubPayloadStore({ rootDir: path.join(root, 'payload-store') })
  try {
    await createSkillHubStudioBundle(
      communityStudioRoot(process.cwd(), 'research-lab'),
      payload,
    )
    const snapshot = await payloadStore.stageFromDirectory(payload)
    const provider = new NoopClaudeProvider()
    try {
      await writeFile(
        path.join(snapshot.studioDir, 'roles', 'researcher.md'),
        'Tampered Flowit-owned payload snapshot.\n',
      )
      await assert.rejects(
        () => payloadStore.assertSnapshotUnchanged(snapshot),
        /snapshot changed|Studio bytes changed/,
      )
      await assert.rejects(
        () =>
          installStudioForCurrentAgent(
            {
              sourceRoot: snapshot.studioDir,
              expectedSourceDigest: snapshot.studioDigest,
              sourceLabel: 'skillhub',
              hostId: 'claude-code',
              projectDir: root,
              storeRoot: path.join(root, 'studio-store'),
            },
            {
              cwd: root,
              homeDir: path.join(root, 'home'),
              setupRegistry: new HostSetupRegistry([provider]),
            },
          ),
        /handoff snapshot digest|bytes frozen by the previous runtime/,
      )
      assert.equal(provider.planCalls, 0)
    } finally {
      await payloadStore.discardSnapshot(snapshot).catch(() => undefined)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillHub payload output cannot be the source ancestor and source bytes survive rejection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-skillhub-ancestor-'))
  const source = path.join(root, 'studio')
  try {
    await cp(communityStudioRoot(process.cwd(), 'research-lab'), source, { recursive: true })
    await assert.rejects(
      () => createSkillHubStudioBundle(source, root),
      /must be disjoint from the Studio source tree/,
    )
    assert.match(await readFile(path.join(source, 'flowit.package.json'), 'utf8'), /research-lab/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cd studio && flowit-studio skillhub . writes a data-only payload outside source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-skillhub-default-'))
  const source = path.join(root, 'studio')
  try {
    await cp(communityStudioRoot(process.cwd(), 'research-lab'), source, { recursive: true })
    const output = capture()
    await runStudioCli(['skillhub', '.', '--json'], { cwd: source, stdout: output.stdout })
    const result = JSON.parse(output.read()) as { outputDir: string; kind: string }
    assert.equal(result.kind, 'data-only-payload')
    const relative = path.relative(source, result.outputDir)
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`))
    await assert.rejects(() => access(path.join(result.outputDir, 'install.mjs')), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('official SkillHub installer delegates the first payload read to Flowit-owned snapshotting', async () => {
  const skill = await readFile('integrations/skillhub/official-installer/SKILL.md', 'utf8')
  const installer = await readFile('integrations/skillhub/official-installer/install.mjs', 'utf8')
  assert.match(skill, /CoaseEdge/)
  assert.match(skill, /publisher identity/)
  assert.match(skill, /immutable staging/)
  assert.match(installer, /@coaseedgeltd\/flowit-workflow/)
  assert.match(installer, /https:\/\/registry\.npmjs\.org\//)
  assert.match(installer, /execFile/)
  assert.match(installer, /install-skillhub-payload/)
  assert.match(installer, /--payload/)
  assert.doesNotMatch(installer, /readFile/)
  assert.doesNotMatch(installer, /flowit-skillhub\.json/)
  assert.doesNotMatch(installer, /licenseType/)
  assert.doesNotMatch(installer, /assertPayloadIdentity/)
  assert.doesNotMatch(installer, /shell\s*:/)
})
