import type { RoutingExplicitIntent } from './types.js'

/**
 * Parse only an anchored top-level user instruction. Quoted/code/JSON prefixes
 * are deliberately treated as data so embedded content cannot grant authority.
 */
export function inferExplicitIntentFromTopLevelPrompt(
  prompt: string,
): RoutingExplicitIntent {
  const trimmed = requiredString(prompt, 'prompt').normalize('NFKC').trim()
  if (/^(?:>|```|~~~|\{|\[)/.test(trimmed)) return 'unspecified'
  const prefix = trimmed.slice(0, 220)
  if (
    /^(?:请\s*)?(?:只|先)\s*(?:看|查看|预览|生成|给我).{0,36}(?:浮域|flowit|pipeline).{0,36}(?:方案|草案|拆解|proposal|plan)/i.test(prefix)
  ) return 'preview'
  if (
    /^(?:请\s*)?(?:不要|别)\s*(?:再\s*)?(?:用|使用|启用|调用)?\s*(?:浮域|flowit|pipeline)/i.test(prefix) ||
    /^(?:请\s*)?直接(?:完成|处理|做).{0,60}(?:不要|不需|无需).{0,30}(?:编排|浮域|flowit|pipeline)/i.test(prefix)
  ) return 'force-direct'
  if (
    /^(?:请\s*)?(?:用|使用|启用|调用)\s*(?:浮域|flowit)(?:\s*(?:来|处理|执行|拆解))?/i.test(prefix) ||
    /^(?:请\s*)?(?:将|把)?.{0,50}(?:拆成|拆解成)\s*(?:\d+\s*个)?\s*(?:pipeline|节点|阶段)/i.test(prefix)
  ) return 'force-flowit'
  return 'unspecified'
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}
