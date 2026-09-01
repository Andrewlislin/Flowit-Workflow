#!/usr/bin/env node
// Standalone bootstrap used before Flowit is installed. Publisher input is limited to a
// validated semantic-version range; package identity and registry are CoaseEdge-owned.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const PACKAGE = '@coaseedgeltd/flowit-workflow'
const REGISTRY = 'https://registry.npmjs.org/'
const SCOPE_REGISTRY = `--@coaseedgeltd:registry=${REGISTRY}`
const ORIGIN_FILE = 'flowit-runtime-origin.json'

try {
  const range = requiredOption('range')
  assertRange(range)
  const homeDir = option('home') ?? os.homedir()
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const version = await resolveVersion(npm, range)
  const target = path.join(homeDir, '.flowit-workflow', 'runtime', 'versions', version)
  let runtime = await inspect(target)
  let reused = true
  if (!runtime) {
    reused = false
    await mkdir(path.dirname(target), { recursive: true })
    const staging = `${target}.install-${randomUUID()}`
    try {
      await mkdir(staging, { recursive: true })
      await exec(
        npm,
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          `--registry=${REGISTRY}`,
          SCOPE_REGISTRY,
          '--prefix',
          staging,
          `${PACKAGE}@${version}`,
        ],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      )
      await writeFile(
        path.join(staging, ORIGIN_FILE),
        `${JSON.stringify({
          version: 1,
          packageName: PACKAGE,
          registry: REGISTRY,
          packageVersion: version,
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      const staged = await inspect(staging)
      if (!staged || staged.version !== version) {
        throw new Error('installed runtime failed identity/version/provenance verification')
      }
      try {
        await rename(staging, target)
      } catch (error) {
        const raced = await inspect(target)
        if (!raced || raced.version !== version) throw error
        reused = true
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    runtime = await inspect(target)
  }
  if (!runtime) throw new Error('Flowit runtime unavailable after bootstrap')
  process.stdout.write(`${JSON.stringify({ ok: true, reused, ...runtime })}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}

async function resolveVersion(npm, range) {
  assertRange(range)
  const { stdout } = await exec(
    npm,
    [
      'view',
      `${PACKAGE}@${range}`,
      'version',
      '--json',
      `--registry=${REGISTRY}`,
      SCOPE_REGISTRY,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  )
  const parsed = JSON.parse(stdout)
  const versions =
    typeof parsed === 'string'
      ? [parsed]
      : Array.isArray(parsed)
        ? parsed.filter(v => typeof v === 'string')
        : []
  const version = versions.at(-1)?.trim()
  if (
    !version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error(`no published official Flowit version satisfies ${range}`)
  }
  return version
}

async function inspect(rootDir) {
  try {
    await stat(rootDir)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw error
  }
  const originFile = path.join(rootDir, ORIGIN_FILE)
  let origin
  try {
    origin = JSON.parse(await readFile(originFile, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`runtime at ${rootDir} predates trusted official provenance; reinstall it`)
    }
    throw error
  }
  if (
    origin.version !== 1 ||
    origin.packageName !== PACKAGE ||
    origin.registry !== REGISTRY
  ) {
    throw new Error(`runtime at ${rootDir} has no trusted official npm provenance`)
  }

  const packageRoot = path.join(rootDir, 'node_modules', '@coaseedgeltd', 'flowit-workflow')
  const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (
    pkg.name !== PACKAGE ||
    typeof pkg.version !== 'string' ||
    origin.packageVersion !== pkg.version
  ) {
    throw new Error(`runtime at ${rootDir} has invalid package identity/provenance`)
  }
  const cliPath = path.join(packageRoot, 'dist', 'cli.js')
  const studioCliPath = path.join(packageRoot, 'dist', 'studio', 'cli-entry.js')
  await Promise.all([stat(cliPath), stat(studioCliPath)])
  return {
    packageName: PACKAGE,
    registry: REGISTRY,
    version: pkg.version,
    rootDir,
    packageRoot,
    cliPath,
    studioCliPath,
  }
}

function assertRange(value) {
  const tokens = String(value).trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) throw new Error('Flowit runtime version range must be non-empty')
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token)
    if (!match || !/^\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(match[2])) {
      throw new Error(`unsupported Flowit runtime range token ${token}`)
    }
    if (!match[1] && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(match[2])) {
      throw new Error(`bare Flowit runtime range token ${match[2]} must be a full semantic version`)
    }
  }
}

function option(name) {
  const args = process.argv.slice(2)
  const prefix = `--${name}=`
  const inline = args.find(arg => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length).trim() || undefined
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1]?.trim() || undefined : undefined
}

function requiredOption(name) {
  const value = option(name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}
