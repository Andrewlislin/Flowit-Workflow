export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const rows = Object.keys(record)
      .sort()
      .filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${rows.join(',')}}`
  }
  return JSON.stringify(value)
}

export function confirmationCodeForProposalHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('proposalHash must be a lowercase SHA-256 hex digest')
  }
  return value.slice(0, 12).toUpperCase()
}
