import path from 'node:path'
import { AgentExecutionError } from '@coaseedgeltd/flowit-core'
import type {
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentExecutionCapability,
  AgentExecutionEvidence,
  AgentExecutionPreflightRequest,
  AgentExecutionPreflightResult,
  AgentRuntimeRequirement,
  AgentSessionDescriptor,
  ProvisionedAgentSession,
} from '@coaseedgeltd/flowit-core'
import {
  CodexAgentAdapter as BaseCodexAgentAdapter,
  CodexAppServerClient,
  type CodexAdapterConfig,
} from './index.js'

export * from './index.js'

const DEFAULT_OUTPUT_MAX_CHARS = 12_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000

export type CodexGrantedSandboxPolicy =
  | {
      readonly type: 'readOnly'
      readonly networkAccess: boolean
    }
  | {
      readonly type: 'workspaceWrite'
      readonly writableRoots: readonly string[]
      readonly networkAccess: boolean
      readonly excludeTmpdirEnvVar: true
      readonly excludeSlashTmp: true
    }

export interface CodexAdapterPermissionEvidence {
  readonly requestedCapabilities: readonly AgentExecutionCapability[]
  readonly grantedCapabilities: readonly AgentExecutionCapability[]
  readonly source: 'mcp-elicitation' | 'bounded-readonly-default'
  readonly scope: 'run'
  readonly dedicatedCwd: string
  readonly sandboxMode: 'read-only' | 'workspace-write'
  readonly sandboxPolicy: CodexGrantedSandboxPolicy
  readonly approvalPolicy: 'never'
  readonly networkAccess: boolean
  readonly writableRoots: readonly string[]
  readonly grantDigest: string
  readonly verified: true
}

export type CodexPermissionGrantVerifier = (
  input: {
    readonly correlationId: string
    readonly session: AgentExecutionPreflightRequest['session']
    readonly requirement: AgentExecutionPreflightRequest['requirement']
  },
) => CodexAdapterPermissionEvidence

export interface FlowitCodexAdapterConfig extends CodexAdapterConfig {
  readonly permissionGrantVerifier?: CodexPermissionGrantVerifier
}

interface ResolvedRuntime {
  readonly requestedModel?: string
  readonly requestedReasoningEffort?: string
  readonly actualModel?: string
  readonly actualReasoningEffort?: string
  readonly verified: boolean
}

interface PermissionClient {
  readonly executable: string
  readonly client: CodexAppServerClient
}

interface PreparedPermissionExecution extends PermissionClient {
  readonly runtime: ResolvedRuntime
  readonly permissions: CodexAdapterPermissionEvidence
}

/**
 * Public Codex adapter facade.
 *
 * Ordinary dispatch retains the underlying adapter behavior while filtering
 * output to the exact completed turn. Explicit Flowit run-once requests with a
 * permission grant use a separate bounded path that applies the approved
 * sandbox to both thread creation/resume and every turn.
 */
export class CodexAgentAdapter extends BaseCodexAgentAdapter {
  private readonly flowitConfig: FlowitCodexAdapterConfig
  private readonly outputMaxChars: number
  private readonly requestTimeoutMs: number
  private readonly turnTimeoutMs: number
  private readonly permissionClients = new Map<string, CodexAppServerClient>()
  private readonly permissionSessionExecutables = new Map<string, string>()

  constructor(config: FlowitCodexAdapterConfig = {}) {
    super(config)
    this.flowitConfig = config
    this.outputMaxChars = positiveInteger(
      config.contextMaxChars ?? DEFAULT_OUTPUT_MAX_CHARS,
      DEFAULT_OUTPUT_MAX_CHARS,
    )
    this.requestTimeoutMs = positiveInteger(
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    )
    this.turnTimeoutMs = positiveInteger(
      config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      DEFAULT_TURN_TIMEOUT_MS,
    )
  }

  override async preflightExecution(
    request: AgentExecutionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<AgentExecutionPreflightResult> {
    if (!hasCapabilities(request)) return super.preflightExecution(request, signal)
    let permissions: CodexAdapterPermissionEvidence
    try {
      permissions = this.verifyPermissionGrant(request)
      const prepared = request.session.kind === 'existing'
        ? await this.prepareExisting(request, permissions, signal)
        : await this.prepareDedicated(request, permissions, signal)
      return {
        status: 'ready',
        evidence: evidenceFor(
          request,
          prepared.runtime,
          prepared.executable,
          prepared.client.info,
          permissions,
          request.session.kind === 'existing'
            ? request.session.sessionId
            : undefined,
        ),
        blockers: [],
      }
    } catch (error: unknown) {
      const classified = classifyPermissionError(error)
      return {
        status: classified.code === 'UNSUPPORTED' ? 'unsupported' : 'blocked',
        evidence: evidenceFor(
          request,
          runtimeFromRequirement(request.requirement.runtime, false),
          undefined,
          undefined,
          safePermissionEvidence(error),
          request.session.kind === 'existing'
            ? request.session.sessionId
            : undefined,
        ),
        blockers: [{
          code: classified.code,
          message: classified.message,
          retryable: classified.retryable,
        }],
      }
    }
  }

  override async provisionSession(
    request: AgentExecutionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<ProvisionedAgentSession> {
    if (!hasCapabilities(request)) return super.provisionSession(request, signal)
    if (request.session.kind !== 'dedicated') {
      throw new AgentExecutionError(
        'UNSUPPORTED',
        'approved Codex permission provisioning requires a dedicated Session plan',
        false,
      )
    }
    const permissions = this.verifyPermissionGrant(request)
    const prepared = await this.prepareDedicated(request, permissions, signal)
    let response: any
    try {
      response = await prepared.client.request(
        'thread/start',
        threadParams(
          request.session.cwd,
          prepared.runtime,
          permissions,
        ),
        signal,
        this.requestTimeoutMs,
      )
    } catch (error: unknown) {
      throw contextualizeProtocolError(error, 'Codex thread/start rejected the approved permission envelope')
    }
    const thread = response?.thread ?? response
    const sessionId = firstString(thread?.id, thread?.threadId)
    if (!sessionId) {
      throw new AgentExecutionError(
        'HOST_VERSION_INCOMPATIBLE',
        'Codex thread/start returned no thread id for the approved Session',
        false,
      )
    }
    try {
      assertHostLifecyclePolicy(response, permissions, 'thread/start')
      const cwd = assertHostCwd(response, permissions, 'thread/start')
      const runtime = runtimeFromHostResponse(response, request.requirement.runtime)
      assertRuntimeMatch(request.requirement.runtime, runtime)
      const session: AgentSessionDescriptor = {
        adapterId: this.id,
        sessionId,
        cwd,
        status: isThreadRunning(thread) ? 'live' : 'idle',
        name: firstString(thread?.name) ?? 'Flowit dedicated Codex Session',
      }
      this.permissionSessionExecutables.set(sessionId, prepared.executable)
      return {
        session,
        managed: true,
        evidence: evidenceFor(
          request,
          runtime,
          prepared.executable,
          prepared.client.info,
          permissions,
          sessionId,
        ),
      }
    } catch (error: unknown) {
      await prepared.client
        .request('thread/archive', { threadId: sessionId }, undefined, 5_000)
        .catch(() => undefined)
      throw error
    }
  }

  override async releaseSession(
    session: ProvisionedAgentSession,
    signal?: AbortSignal,
  ): Promise<void> {
    const permissions = permissionEvidenceFrom(session.evidence)
    if (!permissions) return super.releaseSession(session, signal)
    if (!session.managed) return
    const sessionId = session.session.sessionId
    const executable =
      session.evidence.host?.executable ??
      this.permissionSessionExecutables.get(sessionId)
    if (!executable) {
      throw new AgentExecutionError(
        'HOST_UNAVAILABLE',
        `cannot resolve the Codex executable that owns approved Session ${sessionId}`,
        true,
      )
    }
    const client = await this.permissionClient(executable, signal)
    await client.request(
      'thread/archive',
      { threadId: sessionId },
      signal,
      5_000,
    )
    this.permissionSessionExecutables.delete(sessionId)
  }

  override async dispatch(
    request: AgentDispatchRequest,
    signal?: AbortSignal,
  ): Promise<AgentDispatchResult> {
    if (!hasCapabilitiesInDispatch(request)) {
      return this.filterOrdinaryDispatch(await super.dispatch(request, signal))
    }
    if (request.contextRefs.length > 0) {
      throw new AgentExecutionError(
        'UNSUPPORTED',
        'approved Codex run-once dispatch does not accept caller-supplied context references',
        false,
      )
    }
    const preflightRequest: AgentExecutionPreflightRequest = {
      correlationId: request.correlationId,
      session: { kind: 'existing', sessionId: request.sessionId },
      requirement: request.execution ?? {},
      skills: [...request.skills],
    }
    const permissions = this.verifyPermissionGrant(preflightRequest)
    const prepared = await this.prepareExisting(preflightRequest, permissions, signal)
    let resumed: any
    try {
      resumed = await prepared.client.request(
        'thread/resume',
        {
          threadId: request.sessionId,
          ...threadOverrides(prepared.runtime, permissions),
        },
        signal,
        this.requestTimeoutMs,
      )
    } catch (error: unknown) {
      throw contextualizeProtocolError(error, 'Codex thread/resume rejected the approved permission envelope')
    }
    assertHostLifecyclePolicy(resumed, permissions, 'thread/resume')
    const thread = resumed?.thread ?? resumed
    if (isThreadRunning(thread)) {
      throw new AgentExecutionError(
        'SESSION_BUSY',
        `Codex Session ${request.sessionId} is already running`,
        true,
      )
    }
    const resumedRuntime = runtimeFromHostResponse(resumed, request.execution?.runtime)
    assertRuntimeMatch(request.execution?.runtime, resumedRuntime)
    const cwd = assertHostCwd(resumed, permissions, 'thread/resume')
    const skills = await this.resolvePermissionSkills(
      prepared.client,
      request.skills,
      cwd,
      signal,
    )
    const skillPrefix = skills.map(skill => `$${skill.name}`).join(' ')
    const text = skillPrefix ? `${skillPrefix} ${request.prompt}` : request.prompt
    const input: any[] = [{ type: 'text', text }]
    for (const skill of skills) {
      input.push({ type: 'skill', name: skill.name, path: skill.path })
    }

    const reroutes: ModelRerouteRecord[] = []
    let activeTurnId: string | undefined
    let violationResolved = false
    let resolveViolation:
      | ((value: {
          error: AgentExecutionError
          interrupt: Promise<void>
        }) => void)
      | undefined
    const violationPromise = new Promise<{
      error: AgentExecutionError
      interrupt: Promise<void>
    }>(resolve => {
      resolveViolation = resolve
    })
    const signalExactRerouteViolation = (
      reroute: ModelRerouteRecord,
    ): void => {
      const requestedModel = request.execution?.runtime?.match === 'exact'
        ? request.execution.runtime.model
        : undefined
      const violatingTurnId = activeTurnId
      if (
        violationResolved ||
        !requestedModel ||
        !violatingTurnId ||
        reroute.turnId !== violatingTurnId ||
        reroute.toModel === requestedModel
      ) {
        return
      }
      violationResolved = true
      const error = new AgentExecutionError(
        'MODEL_UNAVAILABLE',
        `Codex rerouted exact model ${requestedModel} from ${reroute.fromModel} to ${reroute.toModel}`,
        false,
      )
      const interrupt = prepared.client
        .request(
          'turn/interrupt',
          { threadId: request.sessionId, turnId: violatingTurnId },
          undefined,
          5_000,
        )
        .then(
          () => undefined,
          () => undefined,
        )
      resolveViolation?.({ error, interrupt })
    }
    const stopReroutes = prepared.client.onNotification((method, params) => {
      if (method !== 'model/rerouted') return
      const reroute = parseModelReroute(params)
      if (reroute?.threadId !== request.sessionId) return
      reroutes.push(reroute)
      signalExactRerouteViolation(reroute)
    })
    let turnId: string | undefined
    let completion: any
    let interruptedForViolation = false
    try {
      const started: any = await prepared.client.request(
        'turn/start',
        {
          threadId: request.sessionId,
          input,
          approvalPolicy: 'never',
          sandboxPolicy: structuredClone(permissions.sandboxPolicy),
          ...(resumedRuntime.actualModel
            ? { model: resumedRuntime.actualModel }
            : {}),
          ...(resumedRuntime.actualReasoningEffort
            ? { effort: resumedRuntime.actualReasoningEffort }
            : {}),
        },
        signal,
        this.requestTimeoutMs,
      )
      turnId = firstString(started?.turn?.id, started?.id)
      if (!turnId) {
        throw new AgentExecutionError(
          'HOST_VERSION_INCOMPATIBLE',
          'Codex turn/start returned no turn id for the approved Session',
          false,
        )
      }
      activeTurnId = turnId
      for (const reroute of reroutes) signalExactRerouteViolation(reroute)
      const outcome = await Promise.race([
        prepared.client.waitFor(
          'turn/completed',
          params =>
            firstString(params?.threadId, params?.thread_id) === request.sessionId &&
            firstString(params?.turn?.id, params?.turnId) === turnId,
          signal,
          this.turnTimeoutMs,
        ).then(value => ({ kind: 'completed' as const, value })),
        violationPromise.then(value => ({
          kind: 'contract-violation' as const,
          value,
        })),
      ])
      if (outcome.kind === 'contract-violation') {
        interruptedForViolation = true
        await outcome.value.interrupt
        throw outcome.value.error
      }
      completion = outcome.value
      assertSuccessfulTurn(completion?.turn, request.sessionId, turnId)
    } catch (error: unknown) {
      if (turnId && !interruptedForViolation) {
        await prepared.client
          .request(
            'turn/interrupt',
            { threadId: request.sessionId, turnId },
            undefined,
            5_000,
          )
          .catch(() => undefined)
      }
      throw contextualizeProtocolError(error, 'Codex approved turn failed')
    } finally {
      stopReroutes()
    }

    const runtime = runtimeAfterReroutes(
      resumedRuntime,
      request.execution?.runtime,
      reroutes.filter(row => row.turnId === turnId),
    )
    assertRuntimeMatch(request.execution?.runtime, runtime)
    const snapshot = await prepared.client
      .request(
        'thread/read',
        { threadId: request.sessionId, includeTurns: true },
        signal,
        this.requestTimeoutMs,
      )
      .catch(() => undefined)
    if (snapshot) assertHostCwd(snapshot, permissions, 'thread/read')
    const outputSummary = snapshot && turnId
      ? summarizeThreadTurn(snapshot, turnId, this.outputMaxChars)
      : undefined
    this.permissionSessionExecutables.set(request.sessionId, prepared.executable)
    return {
      sessionId: request.sessionId,
      loadedSkills: skills.map(skill => skill.name),
      referencedSessions: [],
      ...(turnId ? { runId: turnId } : {}),
      ...(outputSummary ? { outputSummary } : {}),
      executionEvidence: evidenceFor(
        preflightRequest,
        runtime,
        prepared.executable,
        prepared.client.info,
        permissions,
        request.sessionId,
      ),
    }
  }

  override async dispose(): Promise<void> {
    const clients = [...this.permissionClients.values()]
    this.permissionClients.clear()
    this.permissionSessionExecutables.clear()
    await Promise.all([
      super.dispose(),
      ...clients.map(client => client.dispose()),
    ])
  }

  private async prepareDedicated(
    request: AgentExecutionPreflightRequest,
    permissions: CodexAdapterPermissionEvidence,
    signal?: AbortSignal,
  ): Promise<PreparedPermissionExecution> {
    if (request.session.kind !== 'dedicated') {
      throw new AgentExecutionError(
        'UNSUPPORTED',
        'dedicated permission preflight requires a dedicated Session plan',
        false,
      )
    }
    const selected = await this.selectPermissionClient(
      request.requirement.runtime,
      undefined,
      signal,
    )
    await this.resolvePermissionSkills(
      selected.client,
      request.skills,
      request.session.cwd,
      signal,
    )
    return { ...selected, permissions }
  }

  private async prepareExisting(
    request: AgentExecutionPreflightRequest,
    permissions: CodexAdapterPermissionEvidence,
    signal?: AbortSignal,
  ): Promise<PreparedPermissionExecution> {
    if (request.session.kind !== 'existing') {
      throw new AgentExecutionError(
        'UNSUPPORTED',
        'existing permission preflight requires an existing Session plan',
        false,
      )
    }
    const selected = await this.selectPermissionClientForSession(
      request.session.sessionId,
      request.requirement.runtime,
      permissions,
      signal,
    )
    const snapshot = await selected.client.request(
      'thread/read',
      { threadId: request.session.sessionId, includeTurns: false },
      signal,
      this.requestTimeoutMs,
    ) as any
    const thread = snapshot?.thread ?? snapshot
    const descriptor = descriptorFrom(thread)
    if (!descriptor.sessionId || descriptor.status === 'ended' || descriptor.status === 'unknown') {
      throw new AgentExecutionError(
        'SESSION_NOT_FOUND',
        `Codex Session ${request.session.sessionId} is not resumable`,
        false,
      )
    }
    if (descriptor.status === 'live') {
      throw new AgentExecutionError(
        'SESSION_BUSY',
        `Codex Session ${request.session.sessionId} is live`,
        true,
      )
    }
    const cwd = assertHostCwd(snapshot, permissions, 'thread/read')
    await this.resolvePermissionSkills(
      selected.client,
      request.skills,
      cwd,
      signal,
    )
    return { ...selected, permissions }
  }

  private verifyPermissionGrant(
    request: AgentExecutionPreflightRequest,
  ): CodexAdapterPermissionEvidence {
    const verifier = this.flowitConfig.permissionGrantVerifier
    if (!verifier) {
      throw new AgentExecutionError(
        'PERMISSION_UNAVAILABLE',
        'Codex permission capabilities require a Flowit Host-approved execution grant verifier',
        false,
      )
    }
    const permissions = verifier({
      correlationId: request.correlationId,
      session: structuredClone(request.session),
      requirement: structuredClone(request.requirement),
    })
    if (permissions.verified !== true || permissions.approvalPolicy !== 'never') {
      throw new AgentExecutionError(
        'PERMISSION_UNAVAILABLE',
        'Flowit Codex permission evidence is not verified or uses an unsafe approval policy',
        false,
      )
    }
    return structuredClone(permissions)
  }

  private async selectPermissionClient(
    requirement: AgentRuntimeRequirement | undefined,
    preferredExecutable: string | undefined,
    signal?: AbortSignal,
  ): Promise<PermissionClient & { runtime: ResolvedRuntime }> {
    const errors: Error[] = []
    for (const executable of this.permissionExecutableCandidates(preferredExecutable)) {
      try {
        const client = await this.permissionClient(executable, signal)
        const runtime = await resolveRuntime(client, requirement, executable, signal)
        return { executable, client, runtime }
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    throw contextualizeProtocolError(
      new AggregateError(errors, 'no compatible Codex executable accepted the approved permission policy'),
      'Codex permission preflight failed',
    )
  }

  private async selectPermissionClientForSession(
    sessionId: string,
    requirement: AgentRuntimeRequirement | undefined,
    permissions: CodexAdapterPermissionEvidence,
    signal?: AbortSignal,
  ): Promise<PermissionClient & { runtime: ResolvedRuntime }> {
    const errors: Error[] = []
    const preferred = this.permissionSessionExecutables.get(sessionId)
    for (const executable of this.permissionExecutableCandidates(preferred)) {
      try {
        const client = await this.permissionClient(executable, signal)
        const snapshot = await client.request(
          'thread/read',
          { threadId: sessionId, includeTurns: false },
          signal,
          this.requestTimeoutMs,
        ) as any
        assertHostCwd(snapshot, permissions, 'thread/read')
        const runtime = await resolveRuntime(client, requirement, executable, signal)
        return { executable, client, runtime }
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const permissionFailure = errors.find(error =>
      error instanceof AgentExecutionError && error.code === 'PERMISSION_UNAVAILABLE',
    )
    if (permissionFailure) throw permissionFailure
    throw contextualizeProtocolError(
      new AggregateError(errors, `no Codex executable could read Session ${sessionId}`),
      `Codex Session ${sessionId} is unavailable`,
    )
  }

  private permissionExecutableCandidates(preferred?: string): string[] {
    return [...new Set([
      preferred,
      ...(this.flowitConfig.executableCandidates ?? []),
      this.flowitConfig.executable,
      'codex',
    ].filter((value): value is string =>
      typeof value === 'string' && Boolean(value.trim()),
    ).map(value => value.trim()))]
  }

  private async permissionClient(
    executable: string,
    signal?: AbortSignal,
  ): Promise<CodexAppServerClient> {
    let client = this.permissionClients.get(executable)
    if (!client) {
      client = new CodexAppServerClient(
        executable,
        this.requestTimeoutMs,
        this.flowitConfig.serverRequestHandler,
      )
      this.permissionClients.set(executable, client)
    }
    try {
      await client.start(signal)
      return client
    } catch (error: unknown) {
      if (this.permissionClients.get(executable) === client) {
        this.permissionClients.delete(executable)
        await client.dispose().catch(() => undefined)
      }
      throw error
    }
  }

  private async resolvePermissionSkills(
    client: CodexAppServerClient,
    names: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<Array<{ name: string; path: string }>> {
    if (names.length === 0) return []
    const result = await client.request(
      'skills/list',
      { cwds: [cwd], forceReload: true },
      signal,
      this.requestTimeoutMs,
    ) as any
    const groups = Array.isArray(result?.data) ? result.data : []
    const rows = groups.flatMap((group: any) =>
      Array.isArray(group?.skills) ? group.skills : [],
    )
    return [...new Set(names)].map(name => {
      const row = rows.find(
        (item: any) => item?.name === name && item?.enabled !== false,
      )
      if (!row || typeof row.path !== 'string') {
        throw new AgentExecutionError(
          'SKILL_UNAVAILABLE',
          `Codex Skill ${name} is unavailable for ${cwd}`,
          false,
        )
      }
      return { name, path: row.path }
    })
  }

  private filterOrdinaryDispatch(result: AgentDispatchResult): AgentDispatchResult {
    const turnId = nonEmptyString(result.runId)
    const legacySummary = nonEmptyString(result.outputSummary)
    const outputSummary = turnId && legacySummary
      ? summarizeSerializedThreadTurn(legacySummary, turnId, this.outputMaxChars)
      : undefined
    const { outputSummary: _legacyWholeThreadSummary, ...safeResult } = result
    return outputSummary ? { ...safeResult, outputSummary } : safeResult
  }
}

interface ModelRerouteRecord {
  readonly threadId: string
  readonly turnId: string
  readonly fromModel: string
  readonly toModel: string
}

function hasCapabilities(request: AgentExecutionPreflightRequest): boolean {
  return (request.requirement.requiredCapabilities?.length ?? 0) > 0
}

function hasCapabilitiesInDispatch(request: AgentDispatchRequest): boolean {
  return (request.execution?.requiredCapabilities?.length ?? 0) > 0
}

function threadParams(
  cwd: string,
  runtime: ResolvedRuntime,
  permissions: CodexAdapterPermissionEvidence,
): Record<string, unknown> {
  return {
    cwd,
    ...threadOverrides(runtime, permissions),
  }
}

function threadOverrides(
  runtime: ResolvedRuntime,
  permissions: CodexAdapterPermissionEvidence,
): Record<string, unknown> {
  return {
    ...(runtime.actualModel ? { model: runtime.actualModel } : {}),
    approvalPolicy: 'never',
    sandbox: permissions.sandboxMode,
    allowProviderModelFallback: false,
    ...(runtime.actualReasoningEffort
      ? {
          config: {
            model_reasoning_effort: runtime.actualReasoningEffort,
            ...sandboxConfig(permissions),
          },
        }
      : Object.keys(sandboxConfig(permissions)).length > 0
        ? { config: sandboxConfig(permissions) }
        : {}),
  }
}

function sandboxConfig(
  permissions: CodexAdapterPermissionEvidence,
): Record<string, unknown> {
  // Stable App Server v2 exposes a typed lifecycle config only for
  // workspace-write. A network-enabled read-only grant is applied exactly at
  // turn/start through sandboxPolicy; the preceding lifecycle may therefore
  // report the narrower built-in readOnly(networkAccess=false) policy.
  if (permissions.sandboxPolicy.type !== 'workspaceWrite') return {}
  return {
    sandbox_workspace_write: {
      writable_roots: [...permissions.sandboxPolicy.writableRoots],
      network_access: permissions.sandboxPolicy.networkAccess,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    },
  }
}

function assertHostLifecyclePolicy(
  response: any,
  permissions: CodexAdapterPermissionEvidence,
  operation: string,
): void {
  if (response?.approvalPolicy !== 'never') {
    throw new AgentExecutionError(
      'PERMISSION_UNAVAILABLE',
      `${operation} returned approvalPolicy ${JSON.stringify(response?.approvalPolicy)} instead of never`,
      false,
    )
  }
  const actual = response?.sandbox
  if (!actual || typeof actual !== 'object') {
    throw new AgentExecutionError(
      'HOST_VERSION_INCOMPATIBLE',
      `${operation} did not report the active Codex sandbox policy`,
      false,
    )
  }
  const expected = permissions.sandboxPolicy
  if (actual.type !== expected.type) {
    throw new AgentExecutionError(
      'PERMISSION_UNAVAILABLE',
      `${operation} returned sandbox ${JSON.stringify(actual.type)} instead of ${expected.type}`,
      false,
    )
  }
  if (typeof actual.networkAccess !== 'boolean') {
    throw new AgentExecutionError(
      'HOST_VERSION_INCOMPATIBLE',
      `${operation} did not report a boolean networkAccess value`,
      false,
    )
  }

  if (expected.type === 'readOnly') {
    // Stable thread/start and thread/resume accept only SandboxMode and cannot
    // encode readOnly(networkAccess=true). Their built-in read-only state is
    // offline. Accept that narrower, non-executing bootstrap only when the
    // user approved online read-only; reject every broader lifecycle state.
    if (!expected.networkAccess && actual.networkAccess) {
      throw new AgentExecutionError(
        'PERMISSION_UNAVAILABLE',
        `${operation} returned networkAccess true for an offline read-only grant`,
        false,
      )
    }
    return
  }

  // workspaceWrite has a stable typed lifecycle config, so retain exact
  // verification for network, roots, and temporary-directory restrictions.
  if (
    actual.networkAccess !== expected.networkAccess ||
    canonicalStrings(actual.writableRoots) !== canonicalStrings(expected.writableRoots) ||
    actual.excludeTmpdirEnvVar !== true ||
    actual.excludeSlashTmp !== true
  ) {
    throw new AgentExecutionError(
      'PERMISSION_UNAVAILABLE',
      `${operation} returned a workspace sandbox that differs from the approved Flowit envelope`,
      false,
    )
  }
}

function assertHostCwd(
  response: any,
  permissions: CodexAdapterPermissionEvidence,
  operation: string,
): string {
  const reported = firstString(response?.cwd, response?.thread?.cwd)
  if (!reported) {
    throw new AgentExecutionError(
      'HOST_VERSION_INCOMPATIBLE',
      `${operation} did not report the active Codex working directory`,
      false,
    )
  }
  const actual = path.resolve(reported)
  const expected = path.resolve(permissions.dedicatedCwd)
  if (actual !== expected) {
    throw new AgentExecutionError(
      'PERMISSION_UNAVAILABLE',
      `${operation} returned working directory ${JSON.stringify(actual)} instead of approved dedicatedCwd ${JSON.stringify(expected)}`,
      false,
    )
  }
  return actual
}

async function resolveRuntime(
  client: CodexAppServerClient,
  requirement: AgentRuntimeRequirement | undefined,
  executable: string,
  signal?: AbortSignal,
): Promise<ResolvedRuntime> {
  if (!requirement || requirement.match === 'inherit') {
    return runtimeFromRequirement(requirement, false)
  }
  const rows: any[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 1_000; page += 1) {
    const result = await client.request(
      'model/list',
      { includeHidden: true, ...(cursor ? { cursor } : {}) },
      signal,
    ) as any
    rows.push(...(
      Array.isArray(result?.data)
        ? result.data
        : Array.isArray(result?.models)
          ? result.models
          : []
    ))
    const next = firstString(result?.nextCursor, result?.next_cursor)
    if (!next) break
    if (seen.has(next)) {
      throw new AgentExecutionError(
        'HOST_VERSION_INCOMPATIBLE',
        `Codex app-server ${executable} repeated model/list cursor ${next}`,
        false,
      )
    }
    seen.add(next)
    cursor = next
  }
  const models = rows.map(modelRow).filter((row): row is CatalogModel => Boolean(row))
  const fallback = models.find(row => row.isDefault) ?? models[0]
  let selected = requirement.model
    ? models.find(row => row.model === requirement.model)
    : fallback
  if (!selected && requirement.match === 'preferred') selected = fallback
  if (!selected) {
    throw new AgentExecutionError(
      'MODEL_UNAVAILABLE',
      requirement.model
        ? `Codex model ${requirement.model} is unavailable in ${executable}`
        : `Codex app-server ${executable} has no selectable model`,
      false,
    )
  }
  let effort = selected.defaultReasoningEffort
  if (requirement.reasoningEffort) {
    if (selected.supportedReasoningEfforts.includes(requirement.reasoningEffort)) {
      effort = requirement.reasoningEffort
    } else if (requirement.match === 'exact') {
      throw new AgentExecutionError(
        'REASONING_EFFORT_UNAVAILABLE',
        `Codex model ${selected.model} does not support ${requirement.reasoningEffort}`,
        false,
      )
    }
  }
  return {
    ...(requirement.model ? { requestedModel: requirement.model } : {}),
    ...(requirement.reasoningEffort
      ? { requestedReasoningEffort: requirement.reasoningEffort }
      : {}),
    actualModel: selected.model,
    actualReasoningEffort: effort,
    verified: true,
  }
}

interface CatalogModel {
  readonly model: string
  readonly isDefault: boolean
  readonly defaultReasoningEffort: string
  readonly supportedReasoningEfforts: readonly string[]
}

function modelRow(value: any): CatalogModel | undefined {
  const model = firstString(value?.model)
  const defaultReasoningEffort = firstString(
    value?.defaultReasoningEffort,
    value?.default_reasoning_effort,
  )
  const raw = Array.isArray(value?.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts
    : Array.isArray(value?.supported_reasoning_efforts)
      ? value.supported_reasoning_efforts
      : undefined
  if (!model || !defaultReasoningEffort || !raw) return undefined
  return {
    model,
    isDefault: value?.isDefault === true || value?.default === true,
    defaultReasoningEffort,
    supportedReasoningEfforts: raw.flatMap((item: any) => {
      const effort = typeof item === 'string'
        ? item
        : firstString(item?.reasoningEffort, item?.reasoning_effort, item?.effort)
      return effort ? [effort] : []
    }),
  }
}

function runtimeFromRequirement(
  requirement: AgentRuntimeRequirement | undefined,
  verified: boolean,
): ResolvedRuntime {
  return {
    ...(requirement?.model ? { requestedModel: requirement.model } : {}),
    ...(requirement?.reasoningEffort
      ? { requestedReasoningEffort: requirement.reasoningEffort }
      : {}),
    verified,
  }
}

function runtimeFromHostResponse(
  response: any,
  requirement: AgentRuntimeRequirement | undefined,
): ResolvedRuntime {
  const model = firstString(response?.model, response?.thread?.model)
  const effort = firstString(
    response?.reasoningEffort,
    response?.reasoning_effort,
    response?.thread?.reasoningEffort,
    response?.thread?.reasoning_effort,
  )
  return {
    ...(requirement?.model ? { requestedModel: requirement.model } : {}),
    ...(requirement?.reasoningEffort
      ? { requestedReasoningEffort: requirement.reasoningEffort }
      : {}),
    ...(model ? { actualModel: model } : {}),
    ...(effort ? { actualReasoningEffort: effort } : {}),
    verified: requirement?.match === 'exact' || requirement?.match === 'preferred'
      ? (!requirement.model || Boolean(model)) &&
        (!requirement.reasoningEffort || Boolean(effort))
      : Boolean(model || effort),
  }
}

function assertRuntimeMatch(
  requirement: AgentRuntimeRequirement | undefined,
  runtime: ResolvedRuntime,
): void {
  if (!requirement || requirement.match === 'inherit') return
  if (requirement.model && !runtime.actualModel) {
    throw new AgentExecutionError(
      'MODEL_UNAVAILABLE',
      `Codex did not report an actual model for ${requirement.model}`,
      false,
    )
  }
  if (requirement.reasoningEffort && !runtime.actualReasoningEffort) {
    throw new AgentExecutionError(
      'REASONING_EFFORT_UNAVAILABLE',
      `Codex did not report an actual reasoning effort for ${requirement.reasoningEffort}`,
      false,
    )
  }
  if (requirement.match !== 'exact') return
  if (requirement.model && runtime.actualModel !== requirement.model) {
    throw new AgentExecutionError(
      'MODEL_UNAVAILABLE',
      `Codex selected ${runtime.actualModel ?? 'unknown'} instead of ${requirement.model}`,
      false,
    )
  }
  if (
    requirement.reasoningEffort &&
    runtime.actualReasoningEffort !== requirement.reasoningEffort
  ) {
    throw new AgentExecutionError(
      'REASONING_EFFORT_UNAVAILABLE',
      `Codex selected ${runtime.actualReasoningEffort ?? 'unknown'} instead of ${requirement.reasoningEffort}`,
      false,
    )
  }
}

function runtimeAfterReroutes(
  runtime: ResolvedRuntime,
  requirement: AgentRuntimeRequirement | undefined,
  reroutes: readonly ModelRerouteRecord[],
): ResolvedRuntime {
  let actualModel = runtime.actualModel
  for (const reroute of reroutes) {
    actualModel = reroute.toModel
    if (
      requirement?.match === 'exact' &&
      requirement.model &&
      reroute.toModel !== requirement.model
    ) {
      throw new AgentExecutionError(
        'MODEL_UNAVAILABLE',
        `Codex rerouted exact model ${requirement.model} from ${reroute.fromModel} to ${reroute.toModel}`,
        false,
      )
    }
  }
  return { ...runtime, ...(actualModel ? { actualModel } : {}) }
}

function evidenceFor(
  request: AgentExecutionPreflightRequest,
  runtime: ResolvedRuntime,
  executable?: string,
  info?: any,
  permissions?: CodexAdapterPermissionEvidence,
  sessionId?: string,
): AgentExecutionEvidence {
  return {
    host: {
      ...(executable ? { executable } : {}),
      ...(firstString(info?.userAgent) ? { version: firstString(info?.userAgent) } : {}),
      ...(firstString(info?.protocolVersion)
        ? { protocolVersion: firstString(info?.protocolVersion) }
        : {}),
    },
    runtime: {
      ...(runtime.requestedModel ? { requestedModel: runtime.requestedModel } : {}),
      ...(runtime.requestedReasoningEffort
        ? { requestedReasoningEffort: runtime.requestedReasoningEffort }
        : {}),
      ...(runtime.actualModel ? { actualModel: runtime.actualModel } : {}),
      ...(runtime.actualReasoningEffort
        ? { actualReasoningEffort: runtime.actualReasoningEffort }
        : {}),
      verified: runtime.verified,
    },
    session: {
      strategy: request.session.kind,
      ...(sessionId ? { sessionId } : {}),
      exclusive: request.session.kind === 'dedicated',
    },
    ...(permissions ? { permissions: structuredClone(permissions) } : {}),
  } as AgentExecutionEvidence
}

function permissionEvidenceFrom(
  evidence: AgentExecutionEvidence | undefined,
): CodexAdapterPermissionEvidence | undefined {
  if (!evidence || typeof evidence !== 'object') return undefined
  const value = (evidence as AgentExecutionEvidence & {
    permissions?: CodexAdapterPermissionEvidence
  }).permissions
  return value?.verified === true ? value : undefined
}

function safePermissionEvidence(error: unknown): CodexAdapterPermissionEvidence | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as { permissions?: CodexAdapterPermissionEvidence }).permissions
  return value?.verified === true ? value : undefined
}

function classifyPermissionError(error: unknown): AgentExecutionError {
  if (error instanceof AgentExecutionError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined
  if (code === 'PERMISSION_UNAVAILABLE') {
    return new AgentExecutionError('PERMISSION_UNAVAILABLE', message, false)
  }
  return contextualizeProtocolError(error, 'Codex approved execution preflight failed')
}

function contextualizeProtocolError(error: unknown, context: string): AgentExecutionError {
  if (error instanceof AgentExecutionError) return error
  if (error instanceof AggregateError) {
    const details = error.errors.map(item =>
      item instanceof Error ? item.message : String(item),
    ).filter(Boolean).join('; ')
    return new AgentExecutionError(
      /invalid params|unknown method|method not found|unsupported/i.test(details)
        ? 'HOST_VERSION_INCOMPATIBLE'
        : 'HOST_UNAVAILABLE',
      `${context}${details ? `: ${details}` : ''}`,
      !/invalid params|unknown method|method not found|unsupported/i.test(details),
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return new AgentExecutionError(
    /invalid params|unknown method|method not found|unsupported/i.test(message)
      ? 'HOST_VERSION_INCOMPATIBLE'
      : 'HOST_UNAVAILABLE',
    `${context}: ${message}`,
    !/invalid params|unknown method|method not found|unsupported/i.test(message),
  )
}

function parseModelReroute(params: any): ModelRerouteRecord | undefined {
  const threadId = firstString(params?.threadId, params?.thread_id)
  const turnId = firstString(params?.turnId, params?.turn_id)
  const fromModel = firstString(params?.fromModel, params?.from_model)
  const toModel = firstString(params?.toModel, params?.to_model)
  return threadId && turnId && fromModel && toModel
    ? { threadId, turnId, fromModel, toModel }
    : undefined
}

function assertSuccessfulTurn(turn: any, threadId: string, turnId: string): void {
  const status = String(turn?.status ?? '').toLowerCase()
  if (status === 'completed') return
  const detail = turn?.error
    ? `: ${typeof turn.error === 'string' ? turn.error : JSON.stringify(turn.error)}`
    : ''
  throw new AgentExecutionError(
    'HOST_UNAVAILABLE',
    `Codex turn ${threadId}/${turnId} ended ${status || 'unknown'}${detail}`,
    status !== 'failed' && status !== 'interrupted',
  )
}

function descriptorFrom(thread: any): AgentSessionDescriptor {
  const sessionId = firstString(thread?.id, thread?.threadId) ?? ''
  const statusValue = String(thread?.status?.type ?? thread?.status ?? 'unknown').toLowerCase()
  const status: AgentSessionDescriptor['status'] =
    statusValue.includes('active') || statusValue.includes('run') || statusValue.includes('busy')
      ? 'live'
      : statusValue.includes('idle') || statusValue.includes('notloaded') || statusValue.includes('not_loaded')
        ? 'idle'
        : statusValue.includes('closed') || statusValue.includes('ended') || statusValue.includes('archived')
          ? 'ended'
          : 'unknown'
  const cwd = firstString(thread?.cwd)
  return {
    adapterId: 'codex',
    sessionId,
    ...(cwd ? { cwd } : {}),
    status,
  }
}

function isThreadRunning(thread: any): boolean {
  const status = String(thread?.status?.type ?? thread?.status ?? '').toLowerCase()
  return status.includes('active') || status.includes('run') || status.includes('busy')
}

function canonicalStrings(value: unknown): string {
  return JSON.stringify(
    Array.isArray(value)
      ? value.map(item => String(item)).sort()
      : [],
  )
}

function summarizeSerializedThreadTurn(
  value: string,
  turnId: string,
  limit: number,
): string | undefined {
  try {
    return summarizeThreadTurn(JSON.parse(value) as unknown, turnId, limit)
  } catch {
    return undefined
  }
}

function summarizeThreadTurn(
  snapshot: unknown,
  turnId: string,
  limit: number,
): string | undefined {
  const turn = findTurn(snapshot, turnId)
  if (!turn) return undefined
  const assistantText = assistantTextFromTurn(turn)
  const value = assistantText.length > 0
    ? assistantText.join('\n\n')
    : JSON.stringify(turn)
  return truncate(value, limit)
}

function findTurn(snapshot: unknown, turnId: string): Record<string, unknown> | undefined {
  if (!isRecord(snapshot)) return undefined
  const candidates = [
    snapshot.turns,
    isRecord(snapshot.thread) ? snapshot.thread.turns : undefined,
    isRecord(snapshot.data) ? snapshot.data.turns : undefined,
  ]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const turn = candidate.find(item => {
      if (!isRecord(item)) return false
      return nonEmptyString(item.id) === turnId || nonEmptyString(item.turnId) === turnId
    })
    if (isRecord(turn)) return turn
  }
  return undefined
}

function assistantTextFromTurn(turn: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const key of ['agentMessage', 'assistantMessage', 'finalResponse', 'outputText']) {
    collectText(turn[key], values)
  }
  for (const collection of [turn.items, turn.output, turn.messages]) {
    if (!Array.isArray(collection)) continue
    for (const item of collection) {
      if (!isRecord(item) || !isAssistantItem(item)) continue
      collectText(item.text, values)
      collectText(item.content, values)
      collectText(item.message, values)
      collectText(item.outputText, values)
      collectText(item.output_text, values)
    }
  }
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function isAssistantItem(item: Record<string, unknown>): boolean {
  const role = nonEmptyString(item.role)?.toLocaleLowerCase()
  const type = nonEmptyString(item.type ?? item.kind)?.toLocaleLowerCase()
  return role === 'assistant' ||
    type === 'output_text' ||
    type?.includes('agentmessage') === true ||
    type?.includes('agent_message') === true ||
    type?.includes('assistant') === true
}

function collectText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    if (value.trim()) output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output)
    return
  }
  if (!isRecord(value)) return
  for (const key of ['text', 'content', 'message', 'outputText', 'output_text']) {
    if (key in value) collectText(value[key], output)
  }
}

function truncate(value: string, limit: number): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit)}\n…[truncated]`
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim()) as string | undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
