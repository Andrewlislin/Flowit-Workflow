from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


path = Path('packages/adapter-codex/src/public.ts')
text = path.read_text()
text = replace_once(
    text,
    "    const selected = await this.selectPermissionClientForSession(\n      request.session.sessionId,\n      request.requirement.runtime,\n      signal,\n    )\n",
    "    const selected = await this.selectPermissionClientForSession(\n      request.session.sessionId,\n      request.requirement.runtime,\n      permissions,\n      signal,\n    )\n",
    'permission client call',
)
text = replace_once(
    text,
    "  private async selectPermissionClientForSession(\n    sessionId: string,\n    requirement: AgentRuntimeRequirement | undefined,\n    signal?: AbortSignal,\n",
    "  private async selectPermissionClientForSession(\n    sessionId: string,\n    requirement: AgentRuntimeRequirement | undefined,\n    permissions: CodexAdapterPermissionEvidence,\n    signal?: AbortSignal,\n",
    'permission client signature',
)
text = replace_once(
    text,
    "        await client.request(\n          'thread/read',\n          { threadId: sessionId, includeTurns: false },\n          signal,\n          this.requestTimeoutMs,\n        )\n        const runtime = await resolveRuntime(client, requirement, executable, signal)\n",
    "        const snapshot = await client.request(\n          'thread/read',\n          { threadId: sessionId, includeTurns: false },\n          signal,\n          this.requestTimeoutMs,\n        ) as any\n        assertHostCwd(snapshot, permissions, 'thread/read')\n        const runtime = await resolveRuntime(client, requirement, executable, signal)\n",
    'permission client probe cwd',
)
text = replace_once(
    text,
    "    throw contextualizeProtocolError(\n      new AggregateError(errors, `no Codex executable could read Session ${sessionId}`),\n      `Codex Session ${sessionId} is unavailable`,\n    )\n",
    "    const permissionFailure = errors.find(error =>\n      error instanceof AgentExecutionError && error.code === 'PERMISSION_UNAVAILABLE',\n    )\n    if (permissionFailure) throw permissionFailure\n    throw contextualizeProtocolError(\n      new AggregateError(errors, `no Codex executable could read Session ${sessionId}`),\n      `Codex Session ${sessionId} is unavailable`,\n    )\n",
    'permission failure classification',
)
text = replace_once(
    text,
    "      .catch(() => undefined)\n    const outputSummary = snapshot && turnId\n",
    "      .catch(() => undefined)\n    if (snapshot) assertHostCwd(snapshot, permissions, 'thread/read')\n    const outputSummary = snapshot && turnId\n",
    'post-turn read cwd',
)
path.write_text(text)
