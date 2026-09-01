import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPermissionEnvelope,
  permissionEvidenceForEnvelope,
  verifyPermissionEvidence,
} from '../../src/execution-grant.js'

test('approved Codex permission envelopes remain bounded to the dedicated workspace', () => {
  const cwd = process.platform === 'win32' ? 'C:\\flowit\\workspace' : '/tmp/flowit-workspace'
  const readOnly = createPermissionEnvelope(['workspace-read', 'network'], cwd)
  assert.equal(readOnly.threadSandbox, 'read-only')
  assert.deepEqual(readOnly.turnSandboxPolicy, {
    type: 'readOnly',
    networkAccess: true,
  })
  assert.deepEqual(readOnly.writableRoots, [])
  assert.equal(readOnly.approvalPolicy, 'never')

  const writable = createPermissionEnvelope(
    ['workspace-read', 'workspace-write', 'network'],
    cwd,
  )
  assert.equal(writable.threadSandbox, 'workspace-write')
  assert.deepEqual(writable.turnSandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  })
  assert.deepEqual(writable.writableRoots, [cwd])
  assert.equal(writable.approvalPolicy, 'never')
})

test('permission evidence rejects Host policy drift', () => {
  const cwd = process.platform === 'win32' ? 'C:\\flowit\\workspace' : '/tmp/flowit-workspace'
  const envelope = createPermissionEnvelope(
    ['workspace-read', 'workspace-write', 'network'],
    cwd,
  )
  const evidence = permissionEvidenceForEnvelope(envelope, {
    source: 'mcp-elicitation',
    scope: 'run',
  })
  assert.doesNotThrow(() => verifyPermissionEvidence(evidence, envelope))

  assert.throws(
    () => verifyPermissionEvidence(
      {
        ...evidence,
        networkAccess: false,
      },
      envelope,
    ),
    /permission|network|envelope|policy/i,
  )
  assert.throws(
    () => verifyPermissionEvidence(
      {
        ...evidence,
        writableRoots: [],
      },
      envelope,
    ),
    /permission|writable|envelope|policy/i,
  )
})
