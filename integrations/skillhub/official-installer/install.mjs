#!/usr/bin/env node
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PACKAGE = '@coaseedgeltd/flowit-workflow'
const REGISTRY = 'https://registry.npmjs.org/'
const SCOPE_REGISTRY = `--@coaseedgeltd:registry=${REGISTRY}`

try {
  const payloadRoot = path.resolve(requiredOption(process.argv.slice(2), 'payload'))
  const forwarded = forwardedArgs(process.argv.slice(2))
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

  // Do not inspect publisher-controlled payload bytes here. The official Flowit
  // child must be the first component to freeze the complete payload into an
  // owned snapshot and only then form metadata/manifest identity conclusions.
  const result = await run(
    npm,
    [
      'exec',
      '--yes',
      '--ignore-scripts',
      `--registry=${REGISTRY}`,
      SCOPE_REGISTRY,
      `--package=${PACKAGE}@latest`,
      '--',
      'flowit-studio',
      'install-skillhub-payload',
      payloadRoot,
      ...forwarded,
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )
  process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}

function forwardedArgs(args) {
  const valueFlags = new Set([
    '--license', '--publisher-key', '--host', '--session', '--workspace',
    '--scope', '--project-dir', '--store',
  ])
  const booleanFlags = new Set(['--allow-elevated', '--json'])
  const result = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const equals = arg.indexOf('=')
    const name = equals >= 0 ? arg.slice(0, equals) : arg
    if (name === '--payload') {
      if (equals < 0) index += 1
      continue
    }
    if (booleanFlags.has(name)) {
      if (equals >= 0) throw new Error(`${name} does not accept a value`)
      result.push(arg)
      continue
    }
    if (!valueFlags.has(name)) throw new Error(`unsupported installer argument ${name}`)
    if (equals >= 0) {
      if (!arg.slice(equals + 1)) throw new Error(`${name} requires a value`)
      result.push(arg)
      continue
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    result.push(arg, value)
  }
  return result
}

function requiredOption(args, name) {
  const prefix = `--${name}=`
  const inline = args.find(arg => arg.startsWith(prefix))
  if (inline) {
    const value = inline.slice(prefix.length).trim()
    if (value) return value
  }
  const index = args.indexOf(`--${name}`)
  const value = index >= 0 ? args[index + 1]?.trim() : undefined
  if (!value) throw new Error(`--${name} is required`)
  return value
}
