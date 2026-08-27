import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = JSON.parse(await readFile('package.json', 'utf8'))
const dirs = await readdir('packages')
const manifests = new Map()
for (const dir of dirs) {
  const filename = path.join('packages', dir, 'package.json')
  const manifest = JSON.parse(await readFile(filename, 'utf8'))
  manifests.set(manifest.name, { manifest, filename })
}

const get = name => {
  const row = manifests.get(name)
  if (!row) throw new Error(`missing workspace package ${name}`)
  return row.manifest
}

const core = get('@coaseedge/flowit-core')
if (Object.keys(core.dependencies ?? {}).length || Object.keys(core.peerDependencies ?? {}).length) {
  throw new Error('@coaseedge/flowit-core must stay free of third-party runtime dependencies and peers')
}

const openCode = get('@coaseedge/flowit-adapter-opencode')
if (openCode.dependencies?.['@opencode-ai/sdk'] !== '1.18.23') {
  throw new Error('OpenCode adapter must own and pin @opencode-ai/sdk@1.18.23')
}

const dsh = get('@coaseedge/flowit-adapter-dsh')
const dshPeers = Object.keys(dsh.peerDependencies ?? {})
if (!dshPeers.length || dshPeers.some(name => !name.startsWith('@deepseek-ai/'))) {
  throw new Error('DSH host SDKs must stay peer dependencies of the DSH adapter')
}

for (const name of manifests.keys()) {
  if (!name.startsWith('@coaseedge/flowit-')) throw new Error(`unexpected workspace package ${name}`)
  if (root.dependencies?.[name] !== 'workspace:*') {
    throw new Error(`full package must aggregate ${name} through workspace:*`)
  }
}

async function walk(dir) {
  const rows = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name)
    if (entry.isDirectory()) rows.push(...await walk(filename))
    else if (entry.name.endsWith('.ts')) rows.push(filename)
  }
  return rows
}

for (const filename of await walk('packages/core/src')) {
  const source = await readFile(filename, 'utf8')
  for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
    const specifier = match[2]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    throw new Error(`Core source imports external package ${specifier} in ${filename}`)
  }
}

console.log(`Package boundary policy passed for ${manifests.size} workspace packages.`)
