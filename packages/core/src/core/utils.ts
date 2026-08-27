export function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} must be a non-empty string`)
  return normalized
}

export function normalizeStringList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))]
}
