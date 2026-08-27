import { nonEmpty } from './utils.js'

export class SkillBinder {
  normalize(skills: readonly string[] | undefined): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const raw of skills ?? []) {
      const name = nonEmpty(raw, 'skill')
      if (seen.has(name)) continue
      seen.add(name)
      result.push(name)
    }
    return result
  }
}
