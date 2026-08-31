interface SemanticVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

interface VersionComparator {
  readonly operator: '>=' | '<=' | '>' | '<' | '='
  readonly version: SemanticVersion
}

export function assertFlowitRuntimeRange(value: string): string {
  const range = value.trim()
  if (!range) throw new Error('Flowit runtime version range must be non-empty')
  parseRuntimeRange(range)
  return range
}

export function flowitRuntimeVersionSatisfies(version: string, range: string): boolean {
  const current = parseFullVersion(version, 'Flowit runtime version')
  return parseRuntimeRange(assertFlowitRuntimeRange(range)).every(comparator =>
    compareWith(current, comparator),
  )
}

export function compatibleFlowitRuntimeRange(version: string): string {
  const current = parseFullVersion(version, 'Flowit runtime version')
  const normalized = version.split('+', 1)[0]!
  const nextMajor = current.major + 1
  return `>=${normalized} <${nextMajor}`
}

function parseRuntimeRange(range: string): VersionComparator[] {
  const tokens = range.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) throw new Error('Flowit runtime version range must not be empty')
  return tokens.map((token, index) => {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token)
    if (!match) throw new Error(`unsupported Flowit runtime range token ${token}`)
    const operator = (match[1] ?? '=') as VersionComparator['operator']
    const rawVersion = match[2]!
    if (!match[1] && !FULL_VERSION.test(rawVersion)) {
      throw new Error(
        `bare Flowit runtime range token ${rawVersion} must be a full semantic version`,
      )
    }
    return {
      operator,
      version: parseComparatorVersion(
        rawVersion,
        `Flowit runtime range token ${index + 1}`,
      ),
    }
  })
}

function compareWith(current: SemanticVersion, comparator: VersionComparator): boolean {
  const comparison = compareVersions(current, comparator.version)
  switch (comparator.operator) {
    case '>=':
      return comparison >= 0
    case '<=':
      return comparison <= 0
    case '>':
      return comparison > 0
    case '<':
      return comparison < 0
    case '=':
      return comparison === 0
  }
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumber = numericIdentifier(a)
    const bNumber = numericIdentifier(b)
    if (aNumber !== undefined && bNumber !== undefined) return aNumber < bNumber ? -1 : 1
    if (aNumber !== undefined) return -1
    if (bNumber !== undefined) return 1
    return a < b ? -1 : 1
  }
  return 0
}

function parseFullVersion(value: string, label: string): SemanticVersion {
  if (!FULL_VERSION.test(value)) throw new Error(`${label} must be a full semantic version`)
  return parseComparatorVersion(value, label)
}

function parseComparatorVersion(value: string, label: string): SemanticVersion {
  const match = PARTIAL_VERSION.exec(value)
  if (!match) {
    throw new Error(
      `${label} must use numeric semantic-version components and an optional prerelease`,
    )
  }
  if (match[4] && match[3] === undefined) {
    throw new Error(`${label} prerelease requires major.minor.patch`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4]?.split('.') ?? [],
  }
}

function numericIdentifier(value: string): number | undefined {
  return /^(0|[1-9]\d*)$/.test(value) ? Number(value) : undefined
}

const FULL_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PARTIAL_VERSION =
  /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
