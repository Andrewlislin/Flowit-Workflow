from pathlib import Path
import json


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


# Align permission-bound Codex lifecycle verification with the stable v0.152.0
# App Server contract: thread/start and thread/resume express only SandboxMode
# plus the typed workspace-write config, while turn/start carries SandboxPolicy.
public_path = Path("packages/adapter-codex/src/public.ts")
public = public_path.read_text()
if public.count("assertHostPolicy(") != 3:
    raise SystemExit(
        "public lifecycle assertion occurrence count changed; expected two calls and one declaration"
    )
public = public.replace("assertHostPolicy(", "assertHostLifecyclePolicy(")

public = replace_once(
    public,
    """function sandboxConfig(
  permissions: CodexAdapterPermissionEvidence,
): Record<string, unknown> {
  if (permissions.sandboxPolicy.type !== 'workspaceWrite') return {}
""",
    """function sandboxConfig(
  permissions: CodexAdapterPermissionEvidence,
): Record<string, unknown> {
  // Stable App Server v2 exposes a typed lifecycle config only for
  // workspace-write. A network-enabled read-only grant is applied exactly at
  // turn/start through sandboxPolicy; the preceding lifecycle may therefore
  // report the narrower built-in readOnly(networkAccess=false) policy.
  if (permissions.sandboxPolicy.type !== 'workspaceWrite') return {}
""",
    "sandbox lifecycle compatibility comment",
)

policy_start = public.index("function assertHostLifecyclePolicy(\n")
policy_end = public.index("\nfunction assertHostCwd(\n", policy_start)
new_policy = """function assertHostLifecyclePolicy(
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
"""
public = public[:policy_start] + new_policy + public[policy_end:]
public_path.write_text(public)


# Pin the upstream stable protocol facts used by the Host contract test.
fixture_path = Path(
    "tests/fixtures/codex-app-server-v0.152.0-sandbox-contract.json"
)
fixture_path.parent.mkdir(parents=True, exist_ok=True)
if fixture_path.exists():
    raise SystemExit(f"{fixture_path} already exists")
fixture = {
    "source": {
        "repository": "openai/codex",
        "tag": "rust-v0.152.0",
        "commit": "316795b3cf2a45e90d121d9f46499d4658b2645c",
        "schemaRoot": "codex-rs/app-server-protocol/schema/typescript/v2",
        "threadStart": "ThreadStartParams.ts",
        "threadResume": "ThreadResumeParams.ts",
        "turnStart": "TurnStartParams.ts",
        "sandboxPolicy": "SandboxPolicy.ts",
        "config": "Config.ts",
    },
    "threadLifecycle": {
        "methods": ["thread/start", "thread/resume"],
        "requestFields": ["sandbox", "config"],
        "sandboxField": "sandbox",
        "sandboxType": "SandboxMode",
        "structuredSandboxPolicyField": None,
        "readOnlyNetworkConfigField": None,
        "workspaceWriteConfigField": "sandbox_workspace_write",
        "readOnlyDefault": {
            "type": "readOnly",
            "networkAccess": False,
        },
    },
    "turnStart": {
        "method": "turn/start",
        "structuredSandboxPolicyField": "sandboxPolicy",
        "appliesTo": "current-and-subsequent-turns",
    },
}
fixture_path.write_text(json.dumps(fixture, indent=2) + "\n")


# Make the fake derive lifecycle policy from outbound protocol parameters
# instead of injecting the approved answer, and cover the real online-readonly
# bootstrap -> exact turn-policy sequence.
contract_path = Path("tests/contracts/codex-permission-envelope.test.ts")
contract = contract_path.read_text()
contract = replace_once(
    contract,
    "import assert from 'node:assert/strict'\n",
    "import assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\n",
    "fixture fs import",
)
contract = replace_once(
    contract,
    "const SECRET = 'codex-permission-contract-secret-at-least-32-bytes'\n",
    """const SECRET = 'codex-permission-contract-secret-at-least-32-bytes'

interface CodexSandboxContractFixture {
  readonly source: {
    readonly repository: string
    readonly tag: string
    readonly commit: string
  }
  readonly threadLifecycle: {
    readonly methods: readonly string[]
    readonly requestFields: readonly string[]
    readonly sandboxField: string
    readonly sandboxType: string
    readonly structuredSandboxPolicyField: null
    readonly readOnlyNetworkConfigField: null
    readonly workspaceWriteConfigField: string
    readonly readOnlyDefault: {
      readonly type: 'readOnly'
      readonly networkAccess: false
    }
  }
  readonly turnStart: {
    readonly method: 'turn/start'
    readonly structuredSandboxPolicyField: 'sandboxPolicy'
    readonly appliesTo: 'current-and-subsequent-turns'
  }
}

const CODEX_SANDBOX_CONTRACT = JSON.parse(readFileSync(
  new URL(
    '../fixtures/codex-app-server-v0.152.0-sandbox-contract.json',
    import.meta.url,
  ),
  'utf8',
)) as CodexSandboxContractFixture
""",
    "pinned schema fixture loader",
)
contract = replace_once(
    contract,
    """interface FakeOptions {
  readonly hostCwd: string
  readonly networkAccess: boolean
  readonly reroute?: boolean
""",
    """interface FakeOptions {
  readonly hostCwd: string
  readonly readOnlyNetworkOverride?: boolean
  readonly reroute?: boolean
""",
    "fake options lifecycle network",
)
contract = replace_once(
    contract,
    "const hostNetwork = ${JSON.stringify(options.networkAccess)};\n",
    "const readOnlyNetworkOverride = ${JSON.stringify(options.readOnlyNetworkOverride)};\n",
    "fake network source",
)
contract = replace_once(
    contract,
    """const sandbox = params => {
  if (params && params.sandbox === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: [hostCwd],
      networkAccess: hostNetwork,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
  }
  return { type: 'readOnly', networkAccess: hostNetwork };
};
""",
    """const lifecycleSandbox = params => {
  if (params && params.sandbox === 'workspace-write') {
    const configured = params.config && params.config.sandbox_workspace_write;
    return {
      type: 'workspaceWrite',
      writableRoots: configured && Array.isArray(configured.writable_roots)
        ? configured.writable_roots
        : [],
      networkAccess: Boolean(configured && configured.network_access),
      excludeTmpdirEnvVar: Boolean(configured && configured.exclude_tmpdir_env_var),
      excludeSlashTmp: Boolean(configured && configured.exclude_slash_tmp),
    };
  }
  return {
    type: 'readOnly',
    networkAccess: readOnlyNetworkOverride === true,
  };
};
""",
    "fake lifecycle sandbox derivation",
)
if contract.count("sandbox: sandbox(msg.params)") != 2:
    raise SystemExit("expected thread/start and thread/resume fake sandbox responses")
contract = contract.replace(
    "sandbox: sandbox(msg.params)",
    "sandbox: lifecycleSandbox(msg.params)",
)

schema_test_anchor = "test('permission envelope and signed evidence use the current exact contract', async () => {\n"
contract = replace_once(
    contract,
    schema_test_anchor,
    """test('pinned Codex 0.152.0 schema separates lifecycle mode from turn policy', () => {
  assert.equal(CODEX_SANDBOX_CONTRACT.source.repository, 'openai/codex')
  assert.equal(CODEX_SANDBOX_CONTRACT.source.tag, 'rust-v0.152.0')
  assert.equal(
    CODEX_SANDBOX_CONTRACT.source.commit,
    '316795b3cf2a45e90d121d9f46499d4658b2645c',
  )
  assert.deepEqual(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.methods,
    ['thread/start', 'thread/resume'],
  )
  assert.deepEqual(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.requestFields,
    ['sandbox', 'config'],
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.structuredSandboxPolicyField,
    null,
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.readOnlyNetworkConfigField,
    null,
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.workspaceWriteConfigField,
    'sandbox_workspace_write',
  )
  assert.deepEqual(
    CODEX_SANDBOX_CONTRACT.threadLifecycle.readOnlyDefault,
    { type: 'readOnly', networkAccess: false },
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.turnStart.structuredSandboxPolicyField,
    'sandboxPolicy',
  )
  assert.equal(
    CODEX_SANDBOX_CONTRACT.turnStart.appliesTo,
    'current-and-subsequent-turns',
  )
})

""" + schema_test_anchor,
    "schema fixture contract test",
)

old_drift_test = """test('read-only policy verification rejects network drift in both directions', async () => {
  const scenarios = [
    { approved: false, actual: true, name: 'offline-to-online' },
    { approved: true, actual: false, name: 'online-to-offline' },
  ]
  for (const scenario of scenarios) {
    const root = await mkdtemp(path.join(os.tmpdir(), `flowit-${scenario.name}-`))
    const fake = await fakeCodex(root, {
      hostCwd: root,
      networkAccess: scenario.actual,
      name: scenario.name,
    })
    const adapter = new CodexAgentAdapter({
      executable: fake.executable,
      requestTimeoutMs: 5_000,
      permissionGrantVerifier: () => permissionEvidence(root, scenario.approved),
    })
    try {
      await assert.rejects(
        adapter.provisionSession({
          correlationId: scenario.name,
          session: { kind: 'dedicated', cwd: root },
          requirement: {
            requiredCapabilities: scenario.approved
              ? ['workspace-read', 'network']
              : ['workspace-read'],
          },
          skills: [],
        }),
        (error: unknown) => {
          permissionError(error)
          assert.match((error as Error).message, /networkAccess/i)
          return true
        },
      )
      const names = (await recorded(fake.marker)).map(row => row.name)
      assert.equal(names.includes('thread/archive'), true)
    } finally {
      await adapter.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
})
"""
new_drift_tests = """test('offline read-only grant rejects a broader online lifecycle policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-offline-to-online-'))
  const fake = await fakeCodex(root, {
    hostCwd: root,
    readOnlyNetworkOverride: true,
    name: 'offline-to-online',
  })
  const adapter = new CodexAgentAdapter({
    executable: fake.executable,
    requestTimeoutMs: 5_000,
    permissionGrantVerifier: () => permissionEvidence(root, false),
  })
  try {
    await assert.rejects(
      adapter.provisionSession({
        correlationId: 'offline-to-online',
        session: { kind: 'dedicated', cwd: root },
        requirement: { requiredCapabilities: ['workspace-read'] },
        skills: [],
      }),
      (error: unknown) => {
        permissionError(error)
        assert.match((error as Error).message, /networkAccess|online/i)
        return true
      },
    )
    const names = (await recorded(fake.marker)).map(row => row.name)
    assert.equal(names.includes('thread/archive'), true)
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('online read-only grant accepts offline lifecycle bootstrap and starts an exact online turn', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-readonly-network-'))
  const fake = await fakeCodex(root, {
    hostCwd: root,
    name: 'read-only-network-lifecycle',
  })
  const adapter = new CodexAgentAdapter({
    executable: fake.executable,
    requestTimeoutMs: 5_000,
    permissionGrantVerifier: () => permissionEvidence(root, true),
  })
  try {
    const provisioned = await adapter.provisionSession({
      correlationId: 'read-only-network-provision',
      session: { kind: 'dedicated', cwd: root },
      requirement: {
        requiredCapabilities: ['workspace-read', 'network'],
      },
      skills: [],
    })
    await adapter.dispatch({
      correlationId: 'read-only-network-dispatch',
      sessionId: provisioned.session.sessionId,
      prompt: 'perform network-backed read-only research',
      skills: [],
      contextRefs: [],
      execution: {
        requiredCapabilities: ['workspace-read', 'network'],
      },
    })

    const rows = await recorded(fake.marker)
    const threadStart = rows.find(row => row.name === 'thread/start')
    const threadResume = rows.find(row => row.name === 'thread/resume')
    const turnStart = rows.find(row => row.name === 'turn/start')
    assert.ok(threadStart)
    assert.ok(threadResume)
    assert.ok(turnStart)

    for (const lifecycle of [threadStart, threadResume]) {
      assert.equal(lifecycle.params.sandbox, 'read-only')
      assert.equal(lifecycle.params.approvalPolicy, 'never')
      assert.equal('sandboxPolicy' in lifecycle.params, false)
      assert.equal(
        Boolean(lifecycle.params.config?.sandbox_workspace_write),
        false,
      )
    }
    assert.equal(turnStart.params.approvalPolicy, 'never')
    assert.deepEqual(
      turnStart.params.sandboxPolicy,
      { type: 'readOnly', networkAccess: true },
    )
  } finally {
    await adapter.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
"""
contract = replace_once(
    contract,
    old_drift_test,
    new_drift_tests,
    "read-only lifecycle compatibility regressions",
)
remaining_fake_false = "    networkAccess: false,\n"
if contract.count(remaining_fake_false) != 3:
    raise SystemExit(
        f"expected three stale fake network options, found {contract.count(remaining_fake_false)}"
    )
contract = contract.replace(remaining_fake_false, "")
contract_path.write_text(contract)


# Document the lifecycle/turn split without weakening the exact user-approved
# turn envelope.
doc_path = Path("docs/codex-permissions.md")
doc = doc_path.read_text()
doc = replace_once(
    doc,
    """Codex `thread/start` and `thread/resume` responses report the active approval and sandbox policy. Flowit compares the Host response with the approved envelope.

If the Host returns a weaker, broader or structurally different policy, Flowit fails closed. A newly created managed Session is archived before a Run is admitted whenever a policy mismatch can be identified safely.

Every `turn/start` repeats the full bounded `sandboxPolicy`; later Pipeline nodes cannot silently drift to another permission profile.

For both `readOnly` and `workspaceWrite`, `networkAccess` is an exact field: a Host response that is either broader or narrower than the approved value is rejected. `thread/start`, every permission-bound `thread/read` (including executable probing and post-turn readback), and `thread/resume` must report the exact approved `dedicatedCwd`. A mismatch keeps the deterministic `PERMISSION_UNAVAILABLE` classification instead of being wrapped as a retryable Host outage. If an exact model is rerouted, Flowit immediately interrupts that specific turn rather than waiting for the replacement model to finish and applying a post-hoc error.
""",
    """Codex `thread/start` and `thread/resume` responses report the active approval and sandbox policy. Flowit compares that lifecycle state with the approved envelope before any task turn begins.

The stable Codex App Server v0.152.0 lifecycle request accepts `sandbox: SandboxMode` plus generic configuration. It has a typed `sandbox_workspace_write` configuration, but no stable field that can encode `readOnly(networkAccess=true)`. The full structured `SandboxPolicy` belongs to `turn/start`.

Flowit therefore separates two checks:

```text
thread/start / thread/resume
→ approvalPolicy must remain exactly never
→ sandbox type must match
→ lifecycle policy must never be broader than the grant
→ workspaceWrite remains exact because the stable config can express it
→ approved readOnly(networkAccess=true) may bootstrap as readOnly(false)

turn/start
→ send the complete exact approved sandboxPolicy
→ no task work begins before this request
```

A newly created managed Session is archived before Run admission if its lifecycle is broader or structurally incompatible. Every `turn/start` repeats the complete approved `sandboxPolicy`, so read-only network access is enabled only at the execution boundary and later Pipeline nodes cannot silently drift.

`thread/start`, every permission-bound `thread/read` (including executable probing and post-turn readback), and `thread/resume` must still report the exact approved `dedicatedCwd`. A mismatch keeps the deterministic `PERMISSION_UNAVAILABLE` classification instead of being wrapped as a retryable Host outage. If an exact model is rerouted, Flowit immediately interrupts that specific turn rather than waiting for the replacement model to finish and applying a post-hoc error.

The Host contract suite pins the relevant upstream v0.152.0 schema facts in `tests/fixtures/codex-app-server-v0.152.0-sandbox-contract.json`; the fake Host derives lifecycle state from the outbound request instead of being injected with the expected answer.
""",
    "host verification lifecycle split",
)
doc = replace_once(
    doc,
    """readOnly offline approved → Host reports network on  → reject and archive
readOnly online approved  → Host reports network off → reject and archive
approved dedicatedCwd     → thread/start cwd drifts   → reject before Run admission
approved dedicatedCwd     → any thread/read drifts    → reject before Skills or turn/start
approved dedicatedCwd     → thread/resume cwd drifts  → reject before turn/start
exact model X             → Host reroutes X to Y      → interrupt the exact turn before completion
journaled Session cwd      → differs after restart     → refuse recovery admission
```

These checks are exact rather than minimum-capability checks. A Host response that is broader or narrower than what the user approved is not silently accepted.
""",
    """readOnly offline approved → lifecycle reports network on → reject and archive
readOnly online approved  → lifecycle reports network off → accept narrower bootstrap
readOnly online approved  → first turn omits exact online policy → contract test fails
approved dedicatedCwd     → thread/start cwd drifts → reject before Run admission
approved dedicatedCwd     → any thread/read drifts → reject before Skills or turn/start
approved dedicatedCwd     → thread/resume cwd drifts → reject before turn/start
exact model X             → Host reroutes X to Y → interrupt the exact turn before completion
journaled Session cwd      → differs after restart → refuse recovery admission
```

The lifecycle check is no-broader-than-approved where the stable protocol cannot express the full envelope. The actual task boundary remains exact: every turn carries the complete user-approved structured policy.
""",
    "review regression lifecycle gates",
)
doc_path.write_text(doc)


failure_path = Path("docs/permission-envelope-failure-matrix.md")
failure = failure_path.read_text()
failure = replace_once(
    failure,
    "| Host reports broader or weaker policy | Archive managed Session and reject |\n",
    "| Host lifecycle is broader or structurally incompatible | Archive managed Session and reject |\n",
    "failure matrix lifecycle policy",
)
failure_path.write_text(failure)


checklist_path = Path("docs/codex-permissions-review-checklist.md")
checklist = checklist_path.read_text()
checklist = replace_once(
    checklist,
    """- `thread/start` receives only `read-only` or `workspace-write`, with `approvalPolicy: never`.
- Every `turn/start` repeats the exact approved structured sandbox policy.
""",
    """- `thread/start` and `thread/resume` receive only stable lifecycle fields: `read-only` or `workspace-write`, `approvalPolicy: never`, and workspace-write config where applicable.
- Lifecycle verification never accepts a policy broader than the grant; `workspaceWrite` remains exact.
- An approved network-enabled read-only run may bootstrap as the stable offline `readOnly` lifecycle, but no task work begins before `turn/start`.
- Every `turn/start` repeats the exact approved structured sandbox policy, including `readOnly(networkAccess=true)`.
- The pinned Codex v0.152.0 schema fixture and outbound-request regression remain in sync.
""",
    "review checklist lifecycle split",
)
checklist = replace_once(
    checklist,
    "- Host-returned sandbox and approval evidence is checked before Run admission.\n",
    "- Host-returned lifecycle sandbox and approval evidence is checked before Run admission without demanding a state the lifecycle request cannot express.\n",
    "review checklist host evidence",
)
checklist_path.write_text(checklist)
