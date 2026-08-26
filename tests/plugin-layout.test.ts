import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
test('Claude plugin layout declares manifest, lifecycle hooks, and MCP server', async () => { const manifest = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8')); const hooks = JSON.parse(await readFile('hooks/hooks.json', 'utf8')); const mcp = JSON.parse(await readFile('.mcp.json', 'utf8')); assert.equal(manifest.name, 'flowit-workflow'); for (const event of ['SessionStart','Stop','StopFailure','TaskCompleted','SubagentStop','SessionEnd']) assert.ok(Array.isArray(hooks.hooks[event]), `missing ${event} hook`); assert.equal(mcp.mcpServers.orchestration.command, 'node'); assert.ok(mcp.mcpServers.orchestration.args[0].includes('${CLAUDE_PLUGIN_ROOT}')) })
