import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const manifests = [['package.json', JSON.parse(await readFile('package.json', 'utf8'))]]
for (const dir of await readdir('packages')) {
  const filename = path.join('packages', dir, 'package.json')
  manifests.push([filename, JSON.parse(await readFile(filename, 'utf8'))])
}

const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const forbidden = /^(?:https?:|git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|file:|link:)/i
const violations = []
for (const [filename, pkg] of manifests) {
  for (const section of sections) {
    for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
      if (typeof specifier !== 'string') continue
      if (forbidden.test(specifier) || /\.tgz(?:$|[?#])/i.test(specifier)) {
        violations.push(`${filename}: ${section}.${name} = ${specifier}`)
      }
    }
  }
}

if (violations.length) {
  console.error('Flowit release manifests only accept registry/version or workspace dependency specifiers.')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}
console.log(`Dependency source policy passed across ${manifests.length} manifests.`)
