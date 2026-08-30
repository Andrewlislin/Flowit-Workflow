import { readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const packageEntries = [
  ['.', '@coaseedgeltd/flowit-workflow'],
  ['packages/core', '@coaseedgeltd/flowit-core'],
  ['packages/adapter-claude-code', '@coaseedgeltd/flowit-adapter-claude-code'],
  ['packages/adapter-codex', '@coaseedgeltd/flowit-adapter-codex'],
  ['packages/adapter-doubao-office', '@coaseedgeltd/flowit-adapter-doubao-office'],
  ['packages/adapter-dsh', '@coaseedgeltd/flowit-adapter-dsh'],
  ['packages/adapter-file-bridge', '@coaseedgeltd/flowit-adapter-file-bridge'],
  ['packages/adapter-opencode', '@coaseedgeltd/flowit-adapter-opencode'],
  ['packages/adapter-workbuddy', '@coaseedgeltd/flowit-adapter-workbuddy'],
]

const rootManifest = JSON.parse(await readFile('package.json', 'utf8'))
const version = rootManifest.version
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version)) {
  throw new Error(`release version must be a semver prerelease, received ${JSON.stringify(version)}`)
}

for (const [directory, expectedName] of packageEntries) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== expectedName) throw new Error(`${directory} package name drift: ${manifest.name}`)
  if (manifest.version !== version) {
    throw new Error(`${expectedName} version ${manifest.version} does not match root ${version}`)
  }
}

const plugin = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8'))
if (plugin.version !== version) {
  throw new Error(`Claude plugin version ${plugin.version} does not match ${version}`)
}
const mcpSource = await readFile('src/mcp-server.ts', 'utf8')
if (!mcpSource.includes(`serverInfo: { name: 'flowit-workflow', version: '${version}' }`)) {
  throw new Error(`MCP serverInfo.version is not synchronized to ${version}`)
}

const out = '.tmp-packs'
const tarballs = (await readdir(out)).filter(name => name.endsWith('.tgz')).sort()
if (tarballs.length !== packageEntries.length) {
  throw new Error(`expected ${packageEntries.length} release tarballs, found ${tarballs.length}`)
}
const expectedNames = new Set(packageEntries.map(([, name]) => name))
const packedNames = new Set()
let rootTarball
for (const tarball of tarballs) {
  const packed = spawnSync('tar', ['-xOzf', path.join(out, tarball), 'package/package.json'], {
    encoding: 'utf8',
  })
  if (packed.status !== 0) throw new Error(`cannot inspect ${tarball}: ${packed.stderr}`)
  const manifest = JSON.parse(packed.stdout)
  if (!expectedNames.has(manifest.name)) throw new Error(`unexpected release package ${manifest.name}`)
  if (packedNames.has(manifest.name)) throw new Error(`duplicate release package ${manifest.name}`)
  packedNames.add(manifest.name)
  if (manifest.version !== version) {
    throw new Error(`${tarball} packed version ${manifest.version} does not match ${version}`)
  }
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith('@coaseedgeltd/flowit-')) continue
      if (specifier !== version) {
        throw new Error(`${tarball} ${section}.${name} must pin ${version}; received ${specifier}`)
      }
    }
  }
  if (manifest.name === '@coaseedgeltd/flowit-workflow') rootTarball = tarball
}
if (packedNames.size !== expectedNames.size) throw new Error('release tarball package set is incomplete')
if (!rootTarball) throw new Error('root workflow tarball is missing')

const listing = spawnSync('tar', ['-tzf', path.join(out, rootTarball)], { encoding: 'utf8' })
if (listing.status !== 0) throw new Error(`cannot list root tarball: ${listing.stderr}`)
const files = new Set(listing.stdout.split('\n').filter(Boolean))
for (const required of [
  'package/dist/cli.js',
  'package/dist/mcp-server.js',
  'package/dist/setup/index.js',
  'package/dist/preset/index.js',
  'package/.claude-plugin/plugin.json',
  'package/integrations/workbuddy/flowit-bridge-worker/SKILL.md',
  'package/integrations/doubao-office/flowit-bridge-worker/SKILL.md',
]) {
  if (!files.has(required)) throw new Error(`root release tarball is missing ${required}`)
}

console.log(`Release artifact validation passed for ${packageEntries.length} packages at ${version}.`)
