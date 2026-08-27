import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const forbidden = /^(?:https?:|git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|file:|link:)/i
const violations = []

for (const section of sections) {
  const dependencies = pkg[section] ?? {}
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (typeof specifier !== 'string') continue
    if (forbidden.test(specifier) || /\.tgz(?:$|[?#])/i.test(specifier)) violations.push(`${section}.${name} = ${specifier}`)
  }
}

if (violations.length) {
  console.error('Flowit Workflow only accepts registry/version dependency specifiers in release manifests.')
  console.error('Non-registry dependency sources found:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log('Dependency source policy passed: no URL, Git, local-file, or tarball dependency specifiers.')
