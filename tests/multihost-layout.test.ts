import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const files = [
  'integrations/opencode/opencode.jsonc.example',
  'integrations/codex/config.toml.example',
  'integrations/workbuddy/settings.json.example',
  'integrations/workbuddy/mcp.json.example',
  'integrations/workbuddy/flowit-bridge-worker/SKILL.md',
  'integrations/doubao-office/flowit-bridge-worker/SKILL.md',
  'integrations/bridge/PROTOCOL.md',
  'docs/host-adapters.md',
]

test('multi-host integration assets are shipped', async () => {
  await Promise.all(files.map(file => access(file)))
  const docs = await readFile('docs/host-adapters.md', 'utf8')
  assert.match(docs, /OpenCode/)
  assert.match(docs, /Codex/)
  assert.match(docs, /WorkBuddy/)
  assert.match(docs, /豆包办公/)
})
