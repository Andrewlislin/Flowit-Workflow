import { mkdir, rm, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const out = '.tmp-packs'
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const packages = [
  '@coaseedge/flowit-core',
  '@coaseedge/flowit-adapter-claude-code',
  '@coaseedge/flowit-adapter-opencode',
  '@coaseedge/flowit-adapter-codex',
  '@coaseedge/flowit-adapter-dsh',
  '@coaseedge/flowit-adapter-file-bridge',
  '@coaseedge/flowit-adapter-workbuddy',
  '@coaseedge/flowit-adapter-doubao-office',
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
console.log(`Package pack smoke test passed for ${tarballs.length} tarballs.`)
