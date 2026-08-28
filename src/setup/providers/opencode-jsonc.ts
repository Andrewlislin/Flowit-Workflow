export type JsoncNode = JsoncObjectNode | JsoncArrayNode | JsoncScalarNode

export interface JsoncObjectNode {
  readonly kind: 'object'
  readonly start: number
  readonly end: number
  readonly properties: readonly JsoncProperty[]
}

export interface JsoncArrayNode {
  readonly kind: 'array'
  readonly start: number
  readonly end: number
  readonly items: readonly JsoncNode[]
}

export interface JsoncScalarNode {
  readonly kind: 'scalar'
  readonly start: number
  readonly end: number
  readonly value: string | number | boolean | null
}

export interface JsoncProperty {
  readonly key: string
  readonly start: number
  readonly end: number
  readonly value: JsoncNode
  readonly commaStart?: number
  readonly commaEnd?: number
}

export interface JsoncDocument {
  readonly source: string
  readonly root: JsoncObjectNode
  readonly newline: '\n' | '\r\n'
  readonly indent: string
}

export function parseJsoncDocument(source: string): JsoncDocument {
  const parser = new JsoncParser(source)
  const root = parser.parseDocument()
  if (root.kind !== 'object') throw new Error('OpenCode config root must be a JSON object')
  return {
    source,
    root,
    newline: source.includes('\r\n') ? '\r\n' : '\n',
    indent: detectIndent(source),
  }
}

export function jsoncPropertyValue(
  document: JsoncDocument,
  path: readonly string[],
): unknown | undefined {
  const property = findJsoncProperty(document, path)
  return property ? nodeValue(property.value) : undefined
}

export function findJsoncProperty(
  document: JsoncDocument,
  path: readonly string[],
): JsoncProperty | undefined {
  if (path.length === 0) return undefined
  let current: JsoncObjectNode = document.root
  for (let index = 0; index < path.length; index += 1) {
    const property = uniqueProperty(current, path[index]!)
    if (!property) return undefined
    if (index === path.length - 1) return property
    if (property.value.kind !== 'object') {
      throw new Error(`OpenCode config ${path.slice(0, index + 1).join('.')} must be an object`)
    }
    current = property.value
  }
  return undefined
}

export function setJsoncProperty(
  document: JsoncDocument,
  path: readonly string[],
  value: unknown,
): string {
  if (path.length === 0) throw new Error('JSONC property path must be non-empty')
  let current: JsoncObjectNode = document.root
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!
    const property = uniqueProperty(current, key)
    if (!property) {
      const nested = nestedValue(path.slice(index + 1), value)
      return insertProperty(document, current, key, nested)
    }
    if (property.value.kind !== 'object') {
      throw new Error(`OpenCode config ${path.slice(0, index + 1).join('.')} must be an object`)
    }
    current = property.value
  }

  const key = path[path.length - 1]!
  const property = uniqueProperty(current, key)
  if (!property) return insertProperty(document, current, key, value)
  const propertyIndent = lineIndent(document.source, property.start)
  const formatted = formatValue(value, propertyIndent, document.indent, document.newline)
  return splice(document.source, property.value.start, property.value.end, formatted)
}

export function removeJsoncProperty(
  document: JsoncDocument,
  path: readonly string[],
): string {
  const property = findJsoncProperty(document, path)
  if (!property) return document.source
  const end = property.commaEnd ?? property.end
  return splice(document.source, property.start, end, '')
}

export function jsoncSemanticValue(document: JsoncDocument): Record<string, unknown> {
  return nodeValue(document.root) as Record<string, unknown>
}

function insertProperty(
  document: JsoncDocument,
  object: JsoncObjectNode,
  key: string,
  value: unknown,
): string {
  const close = object.end - 1
  const existing = object.properties
  const parentIndent = objectParentIndent(document.source, object)
  const childIndent = existing.length > 0
    ? lineIndent(document.source, existing[0]!.start)
    : `${parentIndent}${document.indent}`
  const valueText = formatValue(value, childIndent, document.indent, document.newline)
  const propertyText = `${JSON.stringify(key)}: ${valueText}`

  const insert = `${document.newline}${childIndent}${propertyText}${document.newline}${parentIndent}`
  if (existing.length === 0) return splice(document.source, close, close, insert)

  const last = existing[existing.length - 1]!
  let source = document.source
  let adjustedClose = close
  if (last.commaStart === undefined) {
    source = splice(source, last.value.end, last.value.end, ',')
    if (last.value.end <= close) adjustedClose += 1
  }
  return splice(source, adjustedClose, adjustedClose, insert)
}

function nestedValue(path: readonly string[], value: unknown): unknown {
  let result = value
  for (let index = path.length - 1; index >= 0; index -= 1) {
    result = { [path[index]!]: result }
  }
  return result
}

function formatValue(
  value: unknown,
  propertyIndent: string,
  indent: string,
  newline: string,
): string {
  const raw = JSON.stringify(value, null, indent)
  if (raw === undefined) throw new Error('OpenCode setup value is not JSON serializable')
  const lines = raw.split('\n')
  if (lines.length === 1) return raw
  return lines.map((line, index) => index === 0 ? line : `${propertyIndent}${line}`).join(newline)
}

function uniqueProperty(object: JsoncObjectNode, key: string): JsoncProperty | undefined {
  const matches = object.properties.filter(property => property.key === key)
  if (matches.length > 1) throw new Error(`OpenCode config contains duplicate property ${key}`)
  return matches[0]
}

function nodeValue(node: JsoncNode): unknown {
  if (node.kind === 'scalar') return node.value
  if (node.kind === 'array') return node.items.map(item => nodeValue(item))
  const result: Record<string, unknown> = {}
  for (const property of node.properties) {
    if (Object.prototype.hasOwnProperty.call(result, property.key)) {
      throw new Error(`OpenCode config contains duplicate property ${property.key}`)
    }
    result[property.key] = nodeValue(property.value)
  }
  return result
}

function lineIndent(source: string, offset: number): string {
  const lineStart = Math.max(source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1, 0)
  const prefix = source.slice(lineStart, offset)
  return prefix.match(/^[\t ]*/)?.[0] ?? ''
}

function objectParentIndent(source: string, object: JsoncObjectNode): string {
  if (object.start === 0) return ''
  return lineIndent(source, object.start)
}

function detectIndent(source: string): string {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([\t ]+)"/)
    if (match?.[1]) return match[1].includes('\t') ? '\t' : ' '.repeat(Math.min(match[1].length, 4))
  }
  return '  '
}

function splice(source: string, start: number, end: number, replacement: string): string {
  return source.slice(0, start) + replacement + source.slice(end)
}

class JsoncParser {
  private index = 0

  constructor(private readonly source: string) {}

  parseDocument(): JsoncNode {
    this.skipTrivia()
    const value = this.parseValue()
    this.skipTrivia()
    if (this.index !== this.source.length) this.fail('unexpected trailing content')
    return value
  }

  private parseValue(): JsoncNode {
    this.skipTrivia()
    const start = this.index
    const current = this.source[this.index]
    if (current === '{') return this.parseObject()
    if (current === '[') return this.parseArray()
    if (current === '"') {
      const value = this.parseString()
      return { kind: 'scalar', start, end: this.index, value }
    }
    if (this.source.startsWith('true', this.index)) {
      this.index += 4
      return { kind: 'scalar', start, end: this.index, value: true }
    }
    if (this.source.startsWith('false', this.index)) {
      this.index += 5
      return { kind: 'scalar', start, end: this.index, value: false }
    }
    if (this.source.startsWith('null', this.index)) {
      this.index += 4
      return { kind: 'scalar', start, end: this.index, value: null }
    }
    return this.parseNumber()
  }

  private parseObject(): JsoncObjectNode {
    const start = this.index
    this.expect('{')
    const properties: JsoncProperty[] = []
    this.skipTrivia()
    if (this.peek('}')) {
      this.index += 1
      return { kind: 'object', start, end: this.index, properties }
    }

    while (this.index < this.source.length) {
      this.skipTrivia()
      const propertyStart = this.index
      if (!this.peek('"')) this.fail('object property name must be a JSON string')
      const key = this.parseString()
      this.skipTrivia()
      this.expect(':')
      const value = this.parseValue()
      const property: {
        key: string
        start: number
        end: number
        value: JsoncNode
        commaStart?: number
        commaEnd?: number
      } = { key, start: propertyStart, end: value.end, value }
      this.skipTrivia()
      if (this.peek(',')) {
        property.commaStart = this.index
        this.index += 1
        property.commaEnd = this.index
        this.skipTrivia()
        properties.push(property)
        if (this.peek('}')) {
          this.index += 1
          return { kind: 'object', start, end: this.index, properties }
        }
        continue
      }
      properties.push(property)
      if (!this.peek('}')) this.fail('expected comma or closing brace')
      this.index += 1
      return { kind: 'object', start, end: this.index, properties }
    }
    this.fail('unterminated object')
  }

  private parseArray(): JsoncArrayNode {
    const start = this.index
    this.expect('[')
    const items: JsoncNode[] = []
    this.skipTrivia()
    if (this.peek(']')) {
      this.index += 1
      return { kind: 'array', start, end: this.index, items }
    }
    while (this.index < this.source.length) {
      items.push(this.parseValue())
      this.skipTrivia()
      if (this.peek(',')) {
        this.index += 1
        this.skipTrivia()
        if (this.peek(']')) {
          this.index += 1
          return { kind: 'array', start, end: this.index, items }
        }
        continue
      }
      if (!this.peek(']')) this.fail('expected comma or closing bracket')
      this.index += 1
      return { kind: 'array', start, end: this.index, items }
    }
    this.fail('unterminated array')
  }

  private parseString(): string {
    const start = this.index
    this.expect('"')
    let escaped = false
    while (this.index < this.source.length) {
      const char = this.source[this.index]!
      this.index += 1
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        const raw = this.source.slice(start, this.index)
        try {
          return JSON.parse(raw) as string
        } catch {
          this.fail('invalid JSON string')
        }
      }
      if (char === '\n' || char === '\r') this.fail('unterminated JSON string')
    }
    this.fail('unterminated JSON string')
  }

  private parseNumber(): JsoncScalarNode {
    const start = this.index
    const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!match) this.fail('expected JSON value')
    this.index += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) this.fail('invalid JSON number')
    return { kind: 'scalar', start, end: this.index, value }
  }

  private skipTrivia(): void {
    while (this.index < this.source.length) {
      const char = this.source[this.index]!
      if (/\s/.test(char)) {
        this.index += 1
        continue
      }
      if (char === '/' && this.source[this.index + 1] === '/') {
        this.index += 2
        while (this.index < this.source.length && this.source[this.index] !== '\n') this.index += 1
        continue
      }
      if (char === '/' && this.source[this.index + 1] === '*') {
        const end = this.source.indexOf('*/', this.index + 2)
        if (end < 0) this.fail('unterminated block comment')
        this.index = end + 2
        continue
      }
      return
    }
  }

  private expect(value: string): void {
    if (!this.source.startsWith(value, this.index)) this.fail(`expected ${value}`)
    this.index += value.length
  }

  private peek(value: string): boolean {
    return this.source.startsWith(value, this.index)
  }

  private fail(message: string): never {
    throw new Error(`invalid OpenCode JSONC at offset ${this.index}: ${message}`)
  }
}
