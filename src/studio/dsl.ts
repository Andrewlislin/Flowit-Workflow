import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CreatePipelineInput, PipelineEdge } from '../core/types.js'
import type {
  PresetDefinition,
  PresetRenderRequest,
  PresetRoleBinding,
} from '../preset/types.js'
import { runtimeAdapterIdForSetupHost } from '../setup/catalog.js'
import type { StudioPackageDescriptor } from './types.js'

export interface StudioRoleDslV1 {
  readonly id: string
  readonly displayName: string
  readonly description: string
}

export interface StudioNodeDslV1 {
  readonly id: string
  readonly roleId: string
  readonly promptFile: string
  readonly skills?: readonly string[]
  readonly inheritUpstreamContext?: boolean
}

export interface StudioEdgeDslV1 {
  readonly from: string
  readonly to: string
}

export interface StudioPresetDslV1 {
  readonly version: 1
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly input: {
    readonly required: boolean
    readonly label: string
  }
  readonly roles: readonly StudioRoleDslV1[]
  readonly nodes: readonly StudioNodeDslV1[]
  readonly edges: readonly StudioEdgeDslV1[]
}

export interface LoadedStudioPreset {
  readonly definition: PresetDefinition
  readonly sourceFile: string
}

const ID = /^[a-z0-9][a-z0-9-]*$/
const DSL_KEYS = new Set([
  'version',
  'id',
  'displayName',
  'description',
  'input',
  'roles',
  'nodes',
  'edges',
])
const INPUT_KEYS = new Set(['required', 'label'])
const ROLE_KEYS = new Set(['id', 'displayName', 'description'])
const NODE_KEYS = new Set([
  'id',
  'roleId',
  'promptFile',
  'skills',
  'inheritUpstreamContext',
])
const EDGE_KEYS = new Set(['from', 'to'])

export async function loadDeclarativeStudioPreset(
  descriptor: StudioPackageDescriptor,
): Promise<LoadedStudioPreset> {
  const sourceFile = safePackagePath(
    descriptor.rootDir,
    path.join('presets', `${descriptor.manifest.entryPreset}.json`),
    'entry preset',
  )
  const sourceStat = await lstat(sourceFile)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('Studio entry preset must be a regular package file')
  }
  const parsed = JSON.parse(await readFile(sourceFile, 'utf8')) as unknown
  const dsl = parseStudioPresetDsl(parsed)
  if (dsl.id !== descriptor.manifest.entryPreset) {
    throw new Error(
      `Studio entry preset id ${dsl.id} does not match manifest entryPreset ${descriptor.manifest.entryPreset}`,
    )
  }

  const promptEntries = await Promise.all(
    dsl.nodes.map(async node => {
      const promptFile = safePackagePath(
        descriptor.rootDir,
        node.promptFile,
        `node ${node.id} promptFile`,
      )
      const stat = await lstat(promptFile)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`node ${node.id} promptFile must be a regular package file`)
      }
      return [node.id, await readFile(promptFile, 'utf8')] as const
    }),
  )
  const prompts = new Map(promptEntries)

  return {
    sourceFile,
    definition: buildPresetDefinition(dsl, prompts),
  }
}

export function parseStudioPresetDsl(value: unknown): StudioPresetDslV1 {
  const object = requireObject(value, 'Studio preset')
  rejectUnknown(object, DSL_KEYS, 'Studio preset')
  if (object.version !== 1) throw new Error('Studio preset version must be 1')
  const id = idValue(object.id, 'Studio preset id')
  const displayName = stringValue(object.displayName, 'Studio preset displayName')
  const description = stringValue(object.description, 'Studio preset description')

  const inputObject = requireObject(object.input, 'Studio preset input')
  rejectUnknown(inputObject, INPUT_KEYS, 'Studio preset input')
  if (typeof inputObject.required !== 'boolean') {
    throw new Error('Studio preset input.required must be boolean')
  }
  const input = {
    required: inputObject.required,
    label: stringValue(inputObject.label, 'Studio preset input.label'),
  }

  if (!Array.isArray(object.roles) || object.roles.length === 0) {
    throw new Error('Studio preset roles must be a non-empty array')
  }
  const roles = object.roles.map((value, index) => {
    const role = requireObject(value, `roles[${index}]`)
    rejectUnknown(role, ROLE_KEYS, `roles[${index}]`)
    return {
      id: idValue(role.id, `roles[${index}].id`),
      displayName: stringValue(role.displayName, `roles[${index}].displayName`),
      description: stringValue(role.description, `roles[${index}].description`),
    }
  })
  assertUnique(
    roles.map(role => role.id),
    'role ids',
  )
  const roleIds = new Set(roles.map(role => role.id))

  if (!Array.isArray(object.nodes) || object.nodes.length === 0) {
    throw new Error('Studio preset nodes must be a non-empty array')
  }
  const nodes = object.nodes.map((value, index) => {
    const node = requireObject(value, `nodes[${index}]`)
    rejectUnknown(node, NODE_KEYS, `nodes[${index}]`)
    const roleId = idValue(node.roleId, `nodes[${index}].roleId`)
    if (!roleIds.has(roleId)) {
      throw new Error(`nodes[${index}] references unknown role ${roleId}`)
    }
    const skills =
      node.skills === undefined
        ? undefined
        : stringArray(node.skills, `nodes[${index}].skills`)
    if (
      node.inheritUpstreamContext !== undefined &&
      typeof node.inheritUpstreamContext !== 'boolean'
    ) {
      throw new Error(`nodes[${index}].inheritUpstreamContext must be boolean`)
    }
    return {
      id: idValue(node.id, `nodes[${index}].id`),
      roleId,
      promptFile: relativeFile(node.promptFile, `nodes[${index}].promptFile`),
      ...(skills ? { skills } : {}),
      ...(typeof node.inheritUpstreamContext === 'boolean'
        ? { inheritUpstreamContext: node.inheritUpstreamContext }
        : {}),
    }
  })
  assertUnique(
    nodes.map(node => node.id),
    'node ids',
  )
  const nodeIds = new Set(nodes.map(node => node.id))

  if (!Array.isArray(object.edges)) throw new Error('Studio preset edges must be an array')
  const edges = object.edges.map((value, index) => {
    const edge = requireObject(value, `edges[${index}]`)
    rejectUnknown(edge, EDGE_KEYS, `edges[${index}]`)
    const from = idValue(edge.from, `edges[${index}].from`)
    const to = idValue(edge.to, `edges[${index}].to`)
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      throw new Error(`edges[${index}] references an unknown node`)
    }
    if (from === to) throw new Error(`edges[${index}] cannot self-reference node ${from}`)
    return { from, to }
  })
  assertAcyclic(
    nodes.map(node => node.id),
    edges,
  )

  return { version: 1, id, displayName, description, input, roles, nodes, edges }
}

function buildPresetDefinition(
  dsl: StudioPresetDslV1,
  prompts: ReadonlyMap<string, string>,
): PresetDefinition {
  return {
    version: 1,
    id: dsl.id,
    displayName: dsl.displayName,
    description: dsl.description,
    roles: dsl.roles,
    inputRequired: dsl.input.required,
    inputLabel: dsl.input.label,
    render(request: PresetRenderRequest): CreatePipelineInput {
      if (dsl.input.required && !request.input?.trim()) {
        throw new Error(`preset ${dsl.id} requires ${dsl.input.label}`)
      }
      return {
        name: request.pipelineName,
        trigger: { kind: 'manual' },
        nodes: dsl.nodes.map(node => {
          const binding = requireBinding(request.bindings, node.roleId)
          const prompt = renderPrompt(prompts.get(node.id) ?? '', request)
          return {
            id: node.id,
            target: {
              adapterId: runtimeAdapterIdForSetupHost(binding.adapterId),
              sessionId: binding.sessionId,
              prompt,
              skills: unique([...(node.skills ?? []), ...binding.skills]),
              contextRefs: [],
            },
            inheritUpstreamContext: node.inheritUpstreamContext ?? true,
          }
        }),
        edges: dsl.edges.map(edge => ({ ...edge })),
      }
    },
  }
}

function renderPrompt(template: string, request: PresetRenderRequest): string {
  return template
    .replaceAll('{{input}}', request.input ?? '')
    .replaceAll('{{workspace}}', request.workspace)
    .replaceAll('{{pipelineName}}', request.pipelineName)
}

function requireBinding(
  bindings: Readonly<Record<string, PresetRoleBinding>>,
  roleId: string,
): PresetRoleBinding {
  const binding = bindings[roleId]
  if (!binding) throw new Error(`missing Studio role binding for ${roleId}`)
  return binding
}

function assertAcyclic(nodeIds: readonly string[], edges: readonly PipelineEdge[]): void {
  const incoming = new Map(nodeIds.map(id => [id, 0]))
  const outgoing = new Map(nodeIds.map(id => [id, [] as string[]]))
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }
  const ready = nodeIds.filter(id => incoming.get(id) === 0)
  let visited = 0
  while (ready.length) {
    const id = ready.shift()!
    visited += 1
    for (const next of outgoing.get(id) ?? []) {
      const count = (incoming.get(next) ?? 0) - 1
      incoming.set(next, count)
      if (count === 0) ready.push(next)
    }
  }
  if (visited !== nodeIds.length) throw new Error('Studio preset graph must be acyclic')
}

function safePackagePath(rootDir: string, relativePath: string, label: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative to the Studio package`)
  }
  const root = path.resolve(rootDir)
  const resolved = path.resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the Studio package root`)
  }
  return resolved
}

function relativeFile(value: unknown, label: string): string {
  const result = stringValue(value, label)
  if (path.isAbsolute(result) || result.split(/[\\/]+/).includes('..')) {
    throw new Error(`${label} must stay inside the Studio package`)
  }
  return result
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknown(
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(object).filter(key => !allowed.has(key))
  if (unknown.length) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`)
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function idValue(value: unknown, label: string): string {
  const result = stringValue(value, label)
  if (!ID.test(result)) throw new Error(`${label} must be kebab-case`)
  return result
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map((entry, index) => stringValue(entry, `${label}[${index}]`))
  assertUnique(result, label)
  return result
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}
