import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  OpenCodeSetupProvider,
  createDefaultHostSetupRegistry,
  type HostSetupContext,
  type SetupApplyOptions,
  type SetupRequestOptions,
} from '../src/setup/index.js'
import {
  OPENCODE_MCP_PATH,
  openCodeSetupPaths,
} from '../src/setup/providers/opencode-state.js'
import {
  jsoncPropertyValue,
  parseJsoncDocument,
  removeJsoncProperty,
  setJsoncProperty,
} from '../src/setup/providers/opencode-jsonc.js'

interface Fixture {
  root: string
  home: string
  project: string
  packageRoot: string
  context: HostSetupContext
  provider: OpenCodeSetupProvider
}

async function fixture(env: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-opencode-setup-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  const bin = path.join(root, 'bin')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(path.join(packageRoot, 'dist'), { recursive: true }),
    mkdir(bin, { recursive: true }),
  ])
  await writeFile(path.join(packageRoot, 'dist', 'mcp-server.js'), '// fixture\n', 'utf8')
  const executable = process.platform === 'win32' ? 'opencode2.exe' : 'opencode2'
  await writeFile(path.join(bin, executable), '', 'utf8')
  const context: HostSetupContext = {
    cwd: project,
    homeDir: home,
    packageRoot,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    env: {
      PATH: bin,
      FLOWIT_WORKFLOW_OPENCODE_URL: 'http://127.0.0.1:1',
      ...env,
    },
  }
  return { root, home, project, packageRoot, context, provider: new OpenCodeSetupProvider() }
}

const userOptions = (projectDir: string): SetupRequestOptions => ({ scope: 'user', projectDir })
const userApply = (projectDir: string): SetupApplyOptions => ({
  scope: 'user', projectDir, assumeYes: true,
})
const projectOptions = (projectDir: string): SetupRequestOptions => ({ scope: 'project', projectDir })
const projectApply = (projectDir: string): SetupApplyOptions => ({
  scope: 'project', projectDir, assumeYes: true,
})

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

test('default setup registry includes the OpenCode provider', () => {
  assert.equal(createDefaultHostSetupRegistry().get('opencode') instanceof OpenCodeSetupProvider, true)
})

test('OpenCode user setup preserves JSONC comments, trailing commas, and unrelated MCP servers', async () => {
  const f = await fixture()
  const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
  const original = `{
  // keep this user comment
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-5",
  "mcp": {
    "servers": {
      "other": {
        "type": "local",
        "command": ["other"],
      },
    },
  },
}
`
  try {
    await mkdir(path.dirname(paths.configFile), { recursive: true })
    await writeFile(paths.configFile, original, 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions.map(row => row.id), ['write-manifest', 'upsert-mcp-entry'])
    assert.equal(plan.actions.every(row => row.requiresConfirmation), true)

    const result = await f.provider.applySetup(f.context, plan, userApply(f.project))
    assert.equal(result.status, 'manual-action-required')
    const content = await readFile(paths.configFile, 'utf8')
    assert.match(content, /keep this user comment/)
    assert.match(content, /"model": "openai\/gpt-5"/)
    assert.match(content, /"other"/)
    const document = parseJsoncDocument(content)
    const entry = jsoncPropertyValue(document, OPENCODE_MCP_PATH) as Record<string, unknown>
    assert.equal(entry.type, 'local')
    assert.equal(entry.disabled, false)
    assert.deepEqual(entry.command, [process.execPath, path.join(f.packageRoot, 'dist', 'mcp-server.js')])
    assert.deepEqual(entry.environment, {
      FLOWIT_WORKFLOW_ADAPTER: 'opencode',
      FLOWIT_WORKFLOW_MUTATIONS: '1',
      FLOWIT_WORKFLOW_OPENCODE_URL: 'http://127.0.0.1:1',
    })

    const second = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(second.actions, [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode project setup writes project JSONC and preserves project activation as a host concern', async () => {
  const f = await fixture()
  const config = path.join(f.project, 'opencode.jsonc')
  try {
    const plan = await f.provider.planSetup(f.context, projectOptions(f.project))
    assert.equal(plan.manualSteps.some(step => /project/i.test(step)), true)
    const result = await f.provider.applySetup(f.context, plan, projectApply(f.project))
    assert.equal(result.status, 'manual-action-required')
    assert.equal(await exists(config), true)
    assert.equal(await exists(path.join(f.home, '.config', 'opencode', 'opencode.jsonc')), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode setup refuses to adopt an unmanaged V2 same-name MCP entry', async () => {
  const f = await fixture()
  const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(path.dirname(paths.configFile), { recursive: true })
    await writeFile(paths.configFile, `{
  "mcp": {
    "servers": {
      "flowit-workflow": { "type": "local", "command": ["custom"] }
    }
  }
}
`, 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions, [])
    assert.equal(plan.warnings.some(warning => /without a Flowit ownership manifest/i.test(warning)), true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode setup refuses a legacy direct mcp.flowit-workflow entry', async () => {
  const f = await fixture()
  const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(path.dirname(paths.configFile), { recursive: true })
    await writeFile(paths.configFile, `{
  "mcp": {
    "flowit-workflow": { "type": "local", "command": ["legacy"] }
  }
}
`, 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions, [])
    assert.equal(plan.warnings.some(warning => /legacy/i.test(warning)), true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode apply rejects a stale plan after unrelated JSONC changes', async () => {
  const f = await fixture()
  const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(path.dirname(paths.configFile), { recursive: true })
    await writeFile(paths.configFile, '{\n  "model": "openai/gpt-5"\n}\n', 'utf8')
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    await writeFile(paths.configFile, '{\n  "model": "openai/gpt-5",\n  "autoupdate": false\n}\n', 'utf8')
    await assert.rejects(
      f.provider.applySetup(f.context, plan, userApply(f.project)),
      /changed after planning|changed while setup was running/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode repair restores a missing installer-owned MCP entry', async () => {
  const f = await fixture()
  const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    const installed = await readFile(paths.configFile, 'utf8')
    const withoutEntry = removeJsoncProperty(parseJsoncDocument(installed), OPENCODE_MCP_PATH)
    await writeFile(paths.configFile, withoutEntry, 'utf8')

    const report = await f.provider.doctor(f.context, userOptions(f.project))
    assert.equal(report.status, 'unhealthy')
    const repair = await f.provider.planRepair(f.context, report, userOptions(f.project))
    assert.equal(repair.actions.some(row => row.id === 'upsert-mcp-entry'), true)
    const repaired = await f.provider.applyRepair(f.context, repair, userApply(f.project))
    assert.equal(repaired.status, 'manual-action-required')
    const entry = jsoncPropertyValue(parseJsoncDocument(await readFile(paths.configFile, 'utf8')), OPENCODE_MCP_PATH)
    assert.notEqual(entry, undefined)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode uninstall preserves unrelated JSONC content and removes only its MCP entry', async () => {
  const f = await fixture()
  const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
  const original = `{
  // user-owned
  "model": "openai/gpt-5",
  "mcp": {
    "servers": {
      "docs": { "type": "remote", "url": "https://example.invalid/mcp" },
    },
  },
}
`
  try {
    await mkdir(path.dirname(paths.configFile), { recursive: true })
    await writeFile(paths.configFile, original, 'utf8')
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))

    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    const result = await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(result.status, 'complete')
    const content = await readFile(paths.configFile, 'utf8')
    assert.match(content, /user-owned/)
    assert.match(content, /"model": "openai\/gpt-5"/)
    assert.match(content, /"docs"/)
    assert.equal(jsoncPropertyValue(parseJsoncDocument(content), OPENCODE_MCP_PATH), undefined)
    assert.equal(await exists(paths.setupManifestFile), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode uninstall removes a config file created solely by setup', async () => {
  const f = await fixture()
  const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(await exists(paths.configFile), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode uninstall preserves a user-modified managed entry and reports partial cleanup', async () => {
  const f = await fixture()
  const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    const installed = await readFile(paths.configFile, 'utf8')
    const document = parseJsoncDocument(installed)
    const entry = jsoncPropertyValue(document, OPENCODE_MCP_PATH) as Record<string, unknown>
    const environment = { ...(entry.environment as Record<string, unknown>), FLOWIT_WORKFLOW_MUTATIONS: '0' }
    const modified = setJsoncProperty(document, OPENCODE_MCP_PATH, { ...entry, environment })
    await writeFile(paths.configFile, modified, 'utf8')

    const uninstall = await f.provider.planUninstall(f.context, userOptions(f.project))
    assert.equal(uninstall.actions.some(row => row.id === 'remove-mcp-entry'), false)
    const result = await f.provider.applyUninstall(f.context, uninstall, userApply(f.project))
    assert.equal(result.status, 'partial')
    const remaining = jsoncPropertyValue(
      parseJsoncDocument(await readFile(paths.configFile, 'utf8')),
      OPENCODE_MCP_PATH,
    ) as Record<string, unknown>
    assert.equal((remaining.environment as Record<string, unknown>).FLOWIT_WORKFLOW_MUTATIONS, '0')
    assert.equal(await exists(paths.setupManifestFile), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode setup fails closed when multiple config files make scope ownership ambiguous', async () => {
  const f = await fixture()
  const directory = path.join(f.home, '.config', 'opencode')
  try {
    await mkdir(directory, { recursive: true })
    await Promise.all([
      writeFile(path.join(directory, 'opencode.jsonc'), '{}\n', 'utf8'),
      writeFile(path.join(directory, 'opencode.json'), '{}\n', 'utf8'),
    ])
    const plan = await f.provider.planSetup(f.context, userOptions(f.project))
    assert.deepEqual(plan.actions, [])
    assert.equal(plan.warnings.some(warning => /Multiple OpenCode config files/i.test(warning)), true)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode setup honors XDG_CONFIG_HOME and explicit connection URL', async () => {
  const custom = path.join(os.tmpdir(), `flowit-opencode-xdg-${Date.now()}-${Math.random()}`)
  const f = await fixture({
    XDG_CONFIG_HOME: custom,
    FLOWIT_WORKFLOW_OPENCODE_URL: 'http://127.0.0.1:43210',
  })
  try {
    const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    await f.provider.applySetup(f.context, setup, userApply(f.project))
    assert.equal(paths.configFile, path.join(custom, 'opencode', 'opencode.jsonc'))
    const entry = jsoncPropertyValue(
      parseJsoncDocument(await readFile(paths.configFile, 'utf8')),
      OPENCODE_MCP_PATH,
    ) as Record<string, unknown>
    assert.equal(
      (entry.environment as Record<string, unknown>).FLOWIT_WORKFLOW_OPENCODE_URL,
      'http://127.0.0.1:43210',
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(custom, { recursive: true, force: true })
  }
})

test('OpenCode setup fails closed on malformed JSONC instead of overwriting it', async () => {
  const f = await fixture()
  const paths = await openCodeSetupPaths(f.context, userOptions(f.project))
  try {
    await mkdir(path.dirname(paths.configFile), { recursive: true })
    await writeFile(paths.configFile, '{\n  // broken\n  "mcp": {\n', 'utf8')
    await assert.rejects(
      f.provider.planSetup(f.context, userOptions(f.project)),
      /invalid OpenCode JSONC/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('OpenCode doctor reports a reachable server as healthy after setup', async () => {
  let server: Server | undefined
  const listener = createServer((request, response) => {
    if (request.url === '/global/health' || request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"healthy":true}')
      return
    }
    response.writeHead(404)
    response.end()
  })
  server = listener
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolve())
  })
  const address = listener.address()
  assert.ok(address && typeof address === 'object')
  const f = await fixture({ FLOWIT_WORKFLOW_OPENCODE_URL: `http://127.0.0.1:${address.port}` })
  try {
    const setup = await f.provider.planSetup(f.context, userOptions(f.project))
    const result = await f.provider.applySetup(f.context, setup, userApply(f.project))
    assert.equal(result.status, 'complete')
    assert.equal(result.doctor?.checks.find(row => row.id === 'opencode-server')?.status, 'ok')
  } finally {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    await rm(f.root, { recursive: true, force: true })
  }
})
