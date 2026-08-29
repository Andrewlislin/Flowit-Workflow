import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Claude plugin layout declares manifest, lifecycle hooks, MCP server, and adaptive route Skill', async () => {
  const manifest = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8'))
  const hooks = JSON.parse(await readFile('hooks/hooks.json', 'utf8'))
  const mcp = JSON.parse(await readFile('.mcp.json', 'utf8'))
  const route = await readFile('skills/route/SKILL.md', 'utf8')
  assert.equal(manifest.name, 'flowit-workflow')
  for (const event of ['SessionStart', 'Stop', 'StopFailure', 'TaskCompleted', 'SubagentStop', 'SessionEnd']) {
    assert.ok(Array.isArray(hooks.hooks[event]), `missing ${event} hook`)
  }
  assert.equal(mcp.mcpServers.orchestration.command, 'node')
  assert.ok(mcp.mcpServers.orchestration.args[0].includes('${CLAUDE_PLUGIN_ROOT}'))
  assert.match(route, /workflow_assess/)
  assert.match(route, /Never recurse/)
  assert.doesNotMatch(route, /disable-model-invocation:\s*true/)
})
