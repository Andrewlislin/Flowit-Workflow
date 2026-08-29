import path from 'node:path'
import type { DoctorCheck, HostSetupContext, SetupRequestOptions } from '../types.js'
import {
  assertDirectory,
  assertReadable,
  digest,
  isRecord,
  missingBridgeDirectories,
  pathExists,
  readTextSnapshot,
  type TextSnapshot,
} from './workbuddy-files.js'

export const DOUBAO_OFFICE_SETUP_HOST_ID = 'doubao-office'
export const DOUBAO_OFFICE_SETUP_DISPLAY_NAME = '豆包办公'
export const DOUBAO_OFFICE_SETUP_MANIFEST_VERSION = 1
export const DOUBAO_OFFICE_SKILL_NAME = 'flowit-workflow-bridge-worker'

export interface DoubaoOfficeSetupPaths {
  readonly bridgeRoot: string
  readonly sourceSkillFile: string
  readonly stagedSkillFile: string
  readonly managedSkillFile?: string
  readonly setupManifestFile: string
}

export interface DoubaoOfficeSetupManifest {
  readonly version: 1
  readonly hostId: 'doubao-office'
  readonly scope: 'user' | 'project'
  readonly projectDir: string
  readonly bridgeRoot: string
  readonly stagedSkillFile: string
  readonly ownedStagedSkillHash?: string
  readonly managedSkillFile?: string
  readonly ownedManagedSkillHash?: string
  readonly installedAt: string
}

export interface DoubaoOfficeState {
  readonly paths: DoubaoOfficeSetupPaths
  readonly sourceSkill: TextSnapshot
  readonly stagedSkill: TextSnapshot
  readonly managedSkill?: TextSnapshot
  readonly manifestSnapshot: TextSnapshot
  readonly manifest?: DoubaoOfficeSetupManifest
  readonly desiredSkillHash: string
  readonly missingBridgeDirs: readonly string[]
  readonly conflicts: readonly string[]
}

export async function detectDoubaoOffice(context: HostSetupContext): Promise<boolean> {
  if (context.env.FLOWIT_WORKFLOW_DOUBAO_SKILL_DIR?.trim()) return true
  if (await pathExists(path.join(context.homeDir, '.flowit-workflow', 'setup', 'doubao-office-user.json'))) return true
  if (await pathExists(path.join(context.homeDir, '.flowit-workflow', 'bridges', DOUBAO_OFFICE_SETUP_HOST_ID))) return true
  return false
}

export async function inspectDoubaoOfficeState(
  context: HostSetupContext,
  options: SetupRequestOptions,
): Promise<DoubaoOfficeState> {
  if (options.scope === 'project') await assertDirectory(options.projectDir)
  const paths = doubaoOfficeSetupPaths(context, options)
  await assertReadable(paths.sourceSkillFile, 'Flowit 豆包办公 Bridge Worker Skill')
  const [sourceSkill, stagedSkill, managedSkill, manifestSnapshot, missingBridgeDirs] = await Promise.all([
    readTextSnapshot(paths.sourceSkillFile),
    readTextSnapshot(paths.stagedSkillFile),
    paths.managedSkillFile ? readTextSnapshot(paths.managedSkillFile) : Promise.resolve(undefined),
    readTextSnapshot(paths.setupManifestFile),
    missingBridgeDirectories(paths.bridgeRoot),
  ])
  if (!sourceSkill.content) throw new Error(`Flowit 豆包办公 Bridge Worker Skill is empty: ${paths.sourceSkillFile}`)
  const desiredSkillHash = digest(sourceSkill.content)
  const manifest = parseDoubaoOfficeManifest(manifestSnapshot, paths.setupManifestFile)
  const provisional: DoubaoOfficeState = {
    paths,
    sourceSkill,
    stagedSkill,
    ...(managedSkill ? { managedSkill } : {}),
    manifestSnapshot,
    ...(manifest ? { manifest } : {}),
    desiredSkillHash,
    missingBridgeDirs,
    conflicts: [],
  }
  return { ...provisional, conflicts: doubaoOfficeConflicts(provisional, options) }
}

export function doubaoOfficeSetupPaths(
  context: HostSetupContext,
  options: SetupRequestOptions,
): DoubaoOfficeSetupPaths {
  const projectDir = path.resolve(options.projectDir)
  const stagedRoot = options.scope === 'user'
    ? path.join(context.homeDir, '.flowit-workflow', 'integrations', DOUBAO_OFFICE_SETUP_HOST_ID, DOUBAO_OFFICE_SKILL_NAME)
    : path.join(projectDir, '.flowit-workflow', DOUBAO_OFFICE_SETUP_HOST_ID, DOUBAO_OFFICE_SKILL_NAME)
  const managedDirRaw = context.env.FLOWIT_WORKFLOW_DOUBAO_SKILL_DIR?.trim()
  const managedSkillFile = managedDirRaw
    ? path.join(path.resolve(context.cwd, managedDirRaw), 'SKILL.md')
    : undefined
  return {
    bridgeRoot: path.join(context.homeDir, '.flowit-workflow', 'bridges', DOUBAO_OFFICE_SETUP_HOST_ID),
    sourceSkillFile: path.join(context.packageRoot, 'integrations', DOUBAO_OFFICE_SETUP_HOST_ID, DOUBAO_OFFICE_SKILL_NAME, 'SKILL.md'),
    stagedSkillFile: path.join(stagedRoot, 'SKILL.md'),
    ...(managedSkillFile ? { managedSkillFile } : {}),
    setupManifestFile: options.scope === 'user'
      ? path.join(context.homeDir, '.flowit-workflow', 'setup', 'doubao-office-user.json')
      : path.join(projectDir, '.flowit-workflow', 'setup', 'doubao-office.json'),
  }
}

export function doubaoOfficeDoctorChecks(state: DoubaoOfficeState): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  if (state.conflicts.length > 0) {
    checks.push({
      id: 'doubao-office-ownership',
      status: 'error',
      summary: '豆包办公 Bridge Worker ownership conflict detected',
      detail: state.conflicts.join(' '),
      repairable: false,
    })
  } else {
    checks.push({ id: 'doubao-office-ownership', status: 'ok', summary: '豆包办公 setup ownership is consistent' })
  }

  checks.push(state.stagedSkill.hash === state.desiredSkillHash
    ? { id: 'doubao-office-staged-skill', status: 'ok', summary: `Bridge Worker Skill staged at ${state.paths.stagedSkillFile}` }
    : {
        id: 'doubao-office-staged-skill',
        status: 'error',
        summary: 'Bridge Worker Skill staging is missing or out of date',
        repairable: state.conflicts.length === 0,
      })

  if (state.paths.managedSkillFile) {
    checks.push(state.managedSkill?.hash === state.desiredSkillHash
      ? { id: 'doubao-office-managed-skill', status: 'ok', summary: `Bridge Worker Skill deployed to the configured managed Skill directory` }
      : {
          id: 'doubao-office-managed-skill',
          status: 'error',
          summary: `Configured 豆包办公 managed Skill target is missing or out of date: ${state.paths.managedSkillFile}`,
          repairable: state.conflicts.length === 0,
        })
  } else {
    checks.push({
      id: 'doubao-office-managed-skill',
      status: 'warning',
      summary: 'No managed 豆包办公 Skill directory is configured; import the staged Skill in the host UI',
      repairable: false,
    })
  }

  checks.push(state.missingBridgeDirs.length === 0
    ? { id: 'doubao-office-bridge', status: 'ok', summary: `Bridge transport directories are ready at ${state.paths.bridgeRoot}` }
    : {
        id: 'doubao-office-bridge',
        status: 'error',
        summary: 'Bridge transport directories are incomplete',
        detail: state.missingBridgeDirs.join(', '),
        repairable: true,
      })

  checks.push({
    id: 'doubao-office-host-automation',
    status: 'warning',
    summary: '豆包办公 exposes no public stable API for Flowit to create the native polling Automation',
    repairable: false,
  })
  return checks
}

export function doubaoOfficeManualSteps(state: DoubaoOfficeState): string[] {
  const steps: string[] = []
  if (state.paths.managedSkillFile) {
    steps.push(
      `Verify 豆包办公 loads the managed Flowit Bridge Worker Skill from ${path.dirname(state.paths.managedSkillFile)}; restart/reload the host if required.`,
    )
  } else {
    steps.push(
      `In 豆包办公, import/enable the Flowit Workflow Bridge Worker Skill staged at ${path.dirname(state.paths.stagedSkillFile)}.`,
    )
  }
  steps.push(
    `Authorize the Skill only for the Flowit Bridge root ${state.paths.bridgeRoot}, then create a 豆包办公 native scheduled task that periodically invokes the Bridge Worker.`,
  )
  steps.push('Run/restart the Flowit daemon with adapter `doubao-office` after the host Worker is enabled.')
  return steps
}

export function desiredDoubaoOwnership(
  state: DoubaoOfficeState,
  writeStage: boolean,
  writeManaged: boolean,
): Pick<DoubaoOfficeSetupManifest, 'ownedStagedSkillHash' | 'ownedManagedSkillHash'> {
  const ownedStagedSkillHash = writeStage
    ? state.desiredSkillHash
    : state.manifest?.ownedStagedSkillHash
  const ownedManagedSkillHash = writeManaged
    ? state.desiredSkillHash
    : state.manifest?.ownedManagedSkillHash
  return {
    ...(ownedStagedSkillHash ? { ownedStagedSkillHash } : {}),
    ...(ownedManagedSkillHash ? { ownedManagedSkillHash } : {}),
  }
}

function doubaoOfficeConflicts(state: DoubaoOfficeState, options: SetupRequestOptions): string[] {
  const conflicts: string[] = []
  const manifest = state.manifest
  if (manifest) {
    if (
      manifest.hostId !== DOUBAO_OFFICE_SETUP_HOST_ID
      || manifest.scope !== options.scope
      || manifest.stagedSkillFile !== state.paths.stagedSkillFile
      || manifest.bridgeRoot !== state.paths.bridgeRoot
      || (manifest.managedSkillFile ?? undefined) !== state.paths.managedSkillFile
    ) {
      conflicts.push('The 豆包办公 setup ownership manifest does not match the requested scope/paths.')
    }
  }

  assetConflict(
    'staged Bridge Worker Skill',
    state.paths.stagedSkillFile,
    state.stagedSkill,
    manifest?.ownedStagedSkillHash,
    state.desiredSkillHash,
    conflicts,
  )
  if (state.paths.managedSkillFile && state.managedSkill) {
    assetConflict(
      'managed 豆包办公 Bridge Worker Skill',
      state.paths.managedSkillFile,
      state.managedSkill,
      manifest?.ownedManagedSkillHash,
      state.desiredSkillHash,
      conflicts,
    )
  }
  return conflicts
}

function assetConflict(
  label: string,
  file: string,
  snapshot: TextSnapshot,
  ownedHash: string | undefined,
  desiredHash: string,
  conflicts: string[],
): void {
  if (!snapshot.exists) return
  if (ownedHash) {
    if (snapshot.hash !== ownedHash && snapshot.hash !== desiredHash) {
      conflicts.push(`The installer-owned ${label} was modified after setup: ${file}`)
    }
    return
  }
  if (snapshot.hash !== desiredHash) {
    conflicts.push(`Existing ${label} is not owned by Flowit setup and conflicts with the desired content: ${file}`)
  }
}

function parseDoubaoOfficeManifest(
  snapshot: TextSnapshot,
  file: string,
): DoubaoOfficeSetupManifest | undefined {
  if (!snapshot.exists) return undefined
  let value: unknown
  try {
    value = JSON.parse(snapshot.content ?? '')
  } catch (error: unknown) {
    throw new Error(`invalid 豆包办公 setup ownership manifest ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(value)) throw new Error(`invalid 豆包办公 setup ownership manifest ${file}`)
  if (
    value.version !== DOUBAO_OFFICE_SETUP_MANIFEST_VERSION
    || value.hostId !== DOUBAO_OFFICE_SETUP_HOST_ID
    || (value.scope !== 'user' && value.scope !== 'project')
    || typeof value.projectDir !== 'string'
    || typeof value.bridgeRoot !== 'string'
    || typeof value.stagedSkillFile !== 'string'
    || (value.ownedStagedSkillHash !== undefined && typeof value.ownedStagedSkillHash !== 'string')
    || (value.managedSkillFile !== undefined && typeof value.managedSkillFile !== 'string')
    || (value.ownedManagedSkillHash !== undefined && typeof value.ownedManagedSkillHash !== 'string')
    || typeof value.installedAt !== 'string'
  ) throw new Error(`invalid 豆包办公 setup ownership manifest ${file}`)
  return value as unknown as DoubaoOfficeSetupManifest
}
