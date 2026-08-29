import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FLOWIT_CLI_NAME,
  FLOWIT_PRODUCT_DISPLAY_NAME_ZH,
  FLOWIT_PRODUCT_NAME,
  FLOWIT_PRODUCT_NAME_ZH,
} from '../src/brand.js'
import { createDefaultPresetRegistry } from '../src/preset/index.js'

test('Chinese product naming keeps stable technical identifiers', () => {
  assert.equal(FLOWIT_PRODUCT_NAME, 'Flowit Workflow')
  assert.equal(FLOWIT_PRODUCT_NAME_ZH, '浮域')
  assert.equal(FLOWIT_PRODUCT_DISPLAY_NAME_ZH, '浮域（Flowit Workflow）')
  assert.equal(FLOWIT_CLI_NAME, 'flowit-workflow')
})

test('built-in work modes expose the approved Chinese user-facing names', () => {
  const presets = createDefaultPresetRegistry().list()
  assert.deepEqual(
    presets.map(preset => [preset.id, preset.displayName]),
    [
      ['content-studio', '内容工作室'],
      ['research-lab', '深度研究'],
      ['agent-team', 'AI 项目小组'],
    ],
  )
  assert.deepEqual(
    presets[0]?.roles.map(role => role.displayName),
    ['发现热点', '选择题目', '研究资料', '写作', '查事实', '主编审核'],
  )
  assert.deepEqual(
    presets[1]?.roles.map(role => role.displayName),
    ['规划问题', '搜证据', '找反例', '综合', '审核'],
  )
  assert.deepEqual(
    presets[2]?.roles.map(role => role.displayName),
    ['规划', '调研', '执行', 'Review'],
  )
})

test('built-in work modes resolve by Chinese names, English names, and stable ids', () => {
  const registry = createDefaultPresetRegistry()
  assert.equal(registry.require('内容工作室').id, 'content-studio')
  assert.equal(registry.require('Content Studio').id, 'content-studio')
  assert.equal(registry.require('content-studio').displayName, '内容工作室')

  assert.equal(registry.require('深度研究').id, 'research-lab')
  assert.equal(registry.require('Research Lab').id, 'research-lab')

  assert.equal(registry.require('AI 项目小组').id, 'agent-team')
  assert.equal(registry.require('Agent Team').id, 'agent-team')
  assert.equal(registry.require('ai project team').id, 'agent-team')
})

test('preset references cannot collide across user-facing aliases', () => {
  const registry = createDefaultPresetRegistry()
  assert.throws(
    () => registry.register({
      version: 1,
      id: 'other-studio',
      displayName: '内容工作室',
      description: 'collision test',
      roles: [],
      inputRequired: false,
      inputLabel: 'none',
      render() {
        return { name: 'other', trigger: { kind: 'manual' }, nodes: [], edges: [] }
      },
    }),
    /already registered/,
  )
})
