import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ClaudeCodeSetupProvider,
  type HostSetupContext,
  type SetupRequestOptions,
} from '../src/setup/index.js'

test('Claude setup wires prompt authority and PreToolUse caller attestation to the same routing state used by MCP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowit-claude-routing-setup-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  const bin = path.join(root, 'bin')
  try {
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(path.join(packageRoot, '.claude-plugin'), { recursive: true }),
      mkdir(path.join(packageRoot, 'skills', 'run-bound'), { recursive: true }),
      mkdir(path.join(packageRoot, 'skills', 'orchestrate'), { recursive: true }),
      mkdir(path.join(packageRoot, 'skills', 'route'), { recursive: true }),
      mkdir(path.join(packageRoot, 'dist'), { recursive: true }),
      mkdir(bin, { recursive: true }),
    ])
    await Promise.all([
      writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@coaseedge/flowit-workflow', version: '0.5.0-beta.1' }),
      ),
      writeFile(
        path.join(packageRoot, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'flowit-workflow', version: '0.0.0', description: 'fixture' }),
      ),
      writeFile(path.join(packageRoot, 'skills', 'run-bound', 'SKILL.md'), 'run-bound\n'),
      writeFile(path.join(packageRoot, 'skills', 'orchestrate', 'SKILL.md'), 'orchestrate\n'),
      writeFile(path.join(packageRoot, 'skills', 'route', 'SKILL.md'), 'route\n'),
      writeFile(path.join(packageRoot, 'dist', 'mcp-server.js'), 'export {}\n'),
      writeFile(path.join(packageRoot, 'dist', 'cli.js'), 'export {}\n'),
      writeFile(path.join(bin, 'claude'), '#!/bin/sh\n'),
    ])
    const context: HostSetupContext = {
      cwd: project,
      homeDir: home,
      packageRoot,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      env: { PATH: bin },
    }
    const options: SetupRequestOptions = { scope: 'user', projectDir: project }
    const provider = new ClaudeCodeSetupProvider()
    const plan = await provider.planSetup(context, options)
    const result = await provider.applySetup(context, plan, { ...options, assumeYes: true })
    assert.equal(result.status, 'complete')

    const pluginRoot = path.join(home, '.claude', 'skills', 'flowit-workflow')
    const hooks = JSON.parse(
      await readFile(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'),
    )
    assert.deepEqual(
      hooks.hooks.UserPromptSubmit[0].hooks[0].args,
      [path.join(packageRoot, 'dist', 'cli.js'), 'claude-routing-hook'],
    )
    assert.match(
      hooks.hooks.PreToolUse[0].matcher,
      /workflow_assess.*workflow_prepare.*workflow_commit/,
    )
    assert.deepEqual(
      hooks.hooks.PreToolUse[0].hooks[0].args,
      [path.join(packageRoot, 'dist', 'cli.js'), 'claude-routing-hook'],
    )

    const mcp = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'))
    const env = mcp.mcpServers.orchestration.env
    assert.equal(env.FLOWIT_WORKFLOW_ROUTING_MODE, 'suggest')
    assert.equal(env.FLOWIT_WORKFLOW_ROUTING_REQUIRE_CALLER_ATTESTATION, '1')
    assert.equal(
      env.FLOWIT_WORKFLOW_ROUTING_AUTHORITY_DIR,
      path.join(home, '.flowit-workflow', 'claude', 'routing-authority'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
