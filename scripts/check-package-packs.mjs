import { mkdir, rm, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const out = '.tmp-packs'
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const packages = [
  '@coaseedgeltd/flowit-core',
  '@coaseedgeltd/flowit-adapter-claude-code',
  '@coaseedgeltd/flowit-adapter-opencode',
  '@coaseedgeltd/flowit-adapter-codex',
  '@coaseedgeltd/flowit-adapter-dsh',
  '@coaseedgeltd/flowit-adapter-file-bridge',
  '@coaseedgeltd/flowit-adapter-workbuddy',
  '@coaseedgeltd/flowit-adapter-doubao-office',
]
for (const name of packages) {
  const result = spawnSync('pnpm', ['--filter', name, 'pack', '--pack-destination', out], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const root = spawnSync('pnpm', ['pack', '--pack-destination', out], { stdio: 'inherit' })
if (root.status !== 0) process.exit(root.status ?? 1)
const tarballs = (await readdir(out)).filter(name => name.endsWith('.tgz'))
if (tarballs.length !== packages.length + 1) {
  throw new Error(`expected ${packages.length + 1} package tarballs, found ${tarballs.length}`)
}
for (const tarball of tarballs) {
  const packed = spawnSync('tar', ['-xOzf', path.join(out, tarball), 'package/package.json'], { encoding: 'utf8' })
  if (packed.status !== 0) throw new Error(`cannot inspect packed manifest for ${tarball}: ${packed.stderr}`)
  const manifest = JSON.parse(packed.stdout)
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (typeof specifier === 'string' && specifier.startsWith('workspace:')) throw new Error(`${tarball} leaked workspace protocol for ${section}.${name}`)
    }
  }
}
console.log(`Package pack smoke test passed for ${tarballs.length} tarballs with publishable manifests.`)
