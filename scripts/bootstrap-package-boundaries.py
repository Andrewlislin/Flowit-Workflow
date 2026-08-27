from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = ROOT / 'packages'


def move(source: str, destination: str) -> None:
    src = ROOT / source
    dst = ROOT / destination
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        raise SystemExit(f'migration source missing: {source}')
    if dst.exists():
        raise SystemExit(f'migration destination already exists: {destination}')
    shutil.move(str(src), str(dst))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def package_tsconfig() -> dict[str, object]:
    return {
        'extends': '../../tsconfig.base.json',
        'compilerOptions': {'rootDir': 'src', 'outDir': 'dist'},
        'include': ['src/**/*.ts'],
        'exclude': ['dist', 'node_modules'],
    }


def package_readme(name: str, description: str) -> str:
    return f'''# {name}\n\n{description}\n\nThis package is part of [Flowit Workflow](https://github.com/Andrewlislin/Flowit-Workflow).\n\nApache-2.0 licensed.\n'''


def rewrite_adapter_imports() -> None:
    for package_dir in PACKAGES.glob('adapter-*'):
        for path in package_dir.rglob('*.ts'):
            text = path.read_text()
            replacements = {
                "from '../core/types.js'": "from '@coaseedge/flowit-core'",
                "from '../core/runtime.js'": "from '@coaseedge/flowit-core'",
                "from '../core/domain.js'": "from '@coaseedge/flowit-core'",
                "from '../core/store.js'": "from '@coaseedge/flowit-core'",
            }
            for old, new in replacements.items():
                text = text.replace(old, new)
            path.write_text(text)

    bridge = PACKAGES / 'adapter-file-bridge/src/index.ts'
    text = bridge.read_text()
    text = text.replace("from '../bridge/receipt.js'", "from '@coaseedge/flowit-core/bridge/receipt'")
    text = text.replace("from '../bridge/state.js'", "from '@coaseedge/flowit-core/bridge/state'")
    text = text.replace(
        "from '../bridge/execution-lease.js'",
        "from '@coaseedge/flowit-core/bridge/execution-lease'",
    )
    bridge.write_text(text)

    for name in ['adapter-workbuddy', 'adapter-doubao-office']:
        path = PACKAGES / f'{name}/src/index.ts'
        path.write_text(
            path.read_text().replace(
                "from './file-bridge.js'",
                "from '@coaseedge/flowit-adapter-file-bridge'",
            )
        )


def write_compatibility_wrappers() -> None:
    core_source = PACKAGES / 'core/src/core'
    root_core = ROOT / 'src/core'
    root_core.mkdir(parents=True, exist_ok=True)
    for path in core_source.glob('*.ts'):
        target = '@coaseedge/flowit-core' if path.stem == 'index' else f'@coaseedge/flowit-core/core/{path.stem}'
        (root_core / path.name).write_text(f"export * from '{target}'\n")

    root_bridge = ROOT / 'src/bridge'
    root_bridge.mkdir(parents=True, exist_ok=True)
    for path in (PACKAGES / 'core/src/bridge').glob('*.ts'):
        (root_bridge / path.name).write_text(
            f"export * from '@coaseedge/flowit-core/bridge/{path.stem}'\n"
        )

    adapters = {
        'claude-code': '@coaseedge/flowit-adapter-claude-code',
        'opencode': '@coaseedge/flowit-adapter-opencode',
        'codex': '@coaseedge/flowit-adapter-codex',
        'dsh': '@coaseedge/flowit-adapter-dsh',
        'file-bridge': '@coaseedge/flowit-adapter-file-bridge',
        'workbuddy': '@coaseedge/flowit-adapter-workbuddy',
        'doubao-office': '@coaseedge/flowit-adapter-doubao-office',
    }
    root_adapters = ROOT / 'src/adapters'
    root_adapters.mkdir(parents=True, exist_ok=True)
    for filename, package in adapters.items():
        (root_adapters / f'{filename}.ts').write_text(f"export * from '{package}'\n")

    root_claude = ROOT / 'src/claude'
    root_claude.mkdir(parents=True, exist_ok=True)
    (root_claude / 'index.ts').write_text(
        "export * from '@coaseedge/flowit-adapter-claude-code/claude'\n"
    )
    for filename in ['hook', 'runtime', 'state']:
        (root_claude / f'{filename}.ts').write_text(
            f"export * from '@coaseedge/flowit-adapter-claude-code/{filename}'\n"
        )

    root_dsh = ROOT / 'src/dsh'
    root_dsh.mkdir(parents=True, exist_ok=True)
    (root_dsh / 'plugin.ts').write_text("export * from '@coaseedge/flowit-adapter-dsh/plugin'\n")
    (root_dsh / 'tools.ts').write_text("export * from '@coaseedge/flowit-adapter-dsh/tools'\n")


def write_policy_scripts() -> None:
    (ROOT / 'scripts/check-dependency-sources.mjs').write_text(r'''import { readFile, readdir } from 'node:fs/promises'
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
''')

    (ROOT / 'scripts/check-package-boundaries.mjs').write_text(r'''import { readFile, readdir } from 'node:fs/promises'
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
''')

    (ROOT / 'scripts/check-package-packs.mjs').write_text(r'''import { mkdir, rm, readdir } from 'node:fs/promises'
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
''')


def write_ci() -> None:
    (ROOT / '.github/workflows/ci.yml').write_text('''name: CI\n\non:\n  push:\n  pull_request:\n\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Enforce registry-only dependency sources\n        run: node scripts/check-dependency-sources.mjs\n      - uses: pnpm/action-setup@v4\n        with:\n          version: 11.7.0\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n      - name: Install reviewed workspace graph\n        run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Enforce package boundaries\n        run: pnpm check:package-boundaries\n      - name: Format and lint gate\n        run: pnpm check:style\n      - name: Build workspace packages and compatibility distribution\n        run: pnpm build\n      - name: Package tarball smoke test\n        run: pnpm check:pack\n      - name: OpenCode SDK supply-chain contract\n        run: node --import tsx --test tests/contracts/opencode-client.test.ts\n      - name: Typecheck compatibility distribution\n        run: pnpm typecheck:root\n      - name: Unit and recovery tests\n        run: pnpm test:raw\n      - name: Host contract tests\n        run: pnpm test:host-contracts:raw\n\n  release-lockfile:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Enforce registry-only dependency sources\n        run: node scripts/check-dependency-sources.mjs\n      - name: Require reviewed pnpm lockfile\n        run: test -f pnpm-lock.yaml\n      - uses: pnpm/action-setup@v4\n        with:\n          version: 11.7.0\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n      - name: Verify frozen dependency graph\n        run: pnpm install --frozen-lockfile --ignore-scripts\n''')


def append_docs() -> None:
    architecture = ROOT / 'docs/architecture.md'
    architecture.write_text(architecture.read_text() + '''\n\n## Package boundaries\n\nFlowit's `AgentAdapter` boundary is also an npm package boundary. `@coaseedge/flowit-core` contains the host-agnostic orchestration engine and has no third-party runtime dependencies or peers. Host integrations ship separately as `@coaseedge/flowit-adapter-*` packages. The existing `@coaseedge/flowit-workflow` package remains the batteries-included compatibility distribution and re-exports its previous public subpaths.\n\nMinimal consumers install only Core plus the adapters they use. The full package intentionally aggregates every built-in adapter and therefore has the broadest SBOM.\n''')

    hosts = ROOT / 'docs/host-adapters.md'
    hosts.write_text(hosts.read_text() + '''\n\n## Installation packages\n\n| Package | Dependency boundary |\n| --- | --- |\n| `@coaseedge/flowit-core` | Host-agnostic orchestration Core; no third-party runtime dependencies or peers. |\n| `@coaseedge/flowit-adapter-claude-code` | Claude Code integration; depends only on Core. |\n| `@coaseedge/flowit-adapter-opencode` | OpenCode integration; owns exact `@opencode-ai/sdk@1.18.23`. |\n| `@coaseedge/flowit-adapter-codex` | Codex App Server integration; depends only on Core. |\n| `@coaseedge/flowit-adapter-dsh` | DSH integration; DeepSeek Harness SDKs are explicit host-owned peer dependencies. |\n| `@coaseedge/flowit-adapter-file-bridge` | Generic Bridge integration. |\n| `@coaseedge/flowit-adapter-workbuddy` | WorkBuddy integration over the File Bridge package. |\n| `@coaseedge/flowit-adapter-doubao-office` | Doubao Office integration over the File Bridge package. |\n| `@coaseedge/flowit-workflow` | Full/convenience distribution aggregating every built-in adapter while preserving the legacy import surface. |\n''')

    readme = ROOT / 'README.md'
    readme.write_text(readme.read_text() + '''\n\n## Minimal package installs\n\nFlowit can now be installed at the same boundary used by the architecture:\n\n```bash\n# Host-agnostic Core only\npnpm add @coaseedge/flowit-core\n\n# OpenCode deployment\npnpm add @coaseedge/flowit-core @coaseedge/flowit-adapter-opencode\n\n# Claude Code deployment\npnpm add @coaseedge/flowit-core @coaseedge/flowit-adapter-claude-code\n\n# Batteries-included / backwards-compatible distribution\npnpm add @coaseedge/flowit-workflow\n```\n\nThe full package intentionally has the broadest SBOM. Minimal installations do not inherit unrelated Host SDKs. DSH consumers additionally satisfy the peer dependencies declared by `@coaseedge/flowit-adapter-dsh`.\n''')


def main() -> None:
    if PACKAGES.exists():
        raise SystemExit('packages/ already exists; refusing to rerun one-time migration')

    move('src/core', 'packages/core/src/core')
    move('src/bridge', 'packages/core/src/bridge')
    move('src/adapters/claude-code.ts', 'packages/adapter-claude-code/src/adapters/claude-code.ts')
    move('src/claude', 'packages/adapter-claude-code/src/claude')
    move('src/adapters/opencode.ts', 'packages/adapter-opencode/src/index.ts')
    move('src/adapters/codex.ts', 'packages/adapter-codex/src/index.ts')
    move('src/adapters/dsh.ts', 'packages/adapter-dsh/src/adapters/dsh.ts')
    move('src/dsh', 'packages/adapter-dsh/src/dsh')
    move('src/adapters/file-bridge.ts', 'packages/adapter-file-bridge/src/index.ts')
    move('src/adapters/workbuddy.ts', 'packages/adapter-workbuddy/src/index.ts')
    move('src/adapters/doubao-office.ts', 'packages/adapter-doubao-office/src/index.ts')

    rewrite_adapter_imports()
    (PACKAGES / 'adapter-claude-code/src/index.ts').write_text(
        "export * from './adapters/claude-code.js'\nexport * from './claude/index.js'\n"
    )
    (PACKAGES / 'adapter-dsh/src/index.ts').write_text(
        "export * from './adapters/dsh.js'\nexport * from './dsh/plugin.js'\nexport * from './dsh/tools.js'\n"
    )

    root_package_path = ROOT / 'package.json'
    root_package = json.loads(root_package_path.read_text())
    version = root_package['version']
    engine = {'node': '^22.19.0 || >=24.0.0'}
    repository_url = 'git+https://github.com/Andrewlislin/Flowit-Workflow.git'

    package_specs: dict[str, dict[str, object]] = {
        'core': {
            'name': '@coaseedge/flowit-core',
            'description': 'Host-agnostic durable orchestration core for Flowit Workflow.',
            'main': 'dist/core/index.js',
            'types': 'dist/core/index.d.ts',
            'exports': {
                '.': {'types': './dist/core/index.d.ts', 'default': './dist/core/index.js'},
                './core': {'types': './dist/core/index.d.ts', 'default': './dist/core/index.js'},
                './core/*': {'types': './dist/core/*.d.ts', 'default': './dist/core/*.js'},
                './bridge/*': {'types': './dist/bridge/*.d.ts', 'default': './dist/bridge/*.js'},
            },
        },
        'adapter-claude-code': {
            'name': '@coaseedge/flowit-adapter-claude-code',
            'description': 'Claude Code adapter for Flowit Workflow.',
            'main': 'dist/index.js', 'types': 'dist/index.d.ts',
            'exports': {
                '.': {'types': './dist/index.d.ts', 'default': './dist/index.js'},
                './hook': {'types': './dist/claude/hook.d.ts', 'default': './dist/claude/hook.js'},
                './runtime': {'types': './dist/claude/runtime.d.ts', 'default': './dist/claude/runtime.js'},
                './state': {'types': './dist/claude/state.d.ts', 'default': './dist/claude/state.js'},
                './claude': {'types': './dist/claude/index.d.ts', 'default': './dist/claude/index.js'},
            },
            'dependencies': {'@coaseedge/flowit-core': 'workspace:*'},
        },
        'adapter-opencode': {
            'name': '@coaseedge/flowit-adapter-opencode',
            'description': 'OpenCode V2 adapter for Flowit Workflow.',
            'main': 'dist/index.js', 'types': 'dist/index.d.ts',
            'exports': {'.': {'types': './dist/index.d.ts', 'default': './dist/index.js'}},
            'dependencies': {'@coaseedge/flowit-core': 'workspace:*', '@opencode-ai/sdk': '1.18.23'},
        },
        'adapter-codex': {
            'name': '@coaseedge/flowit-adapter-codex',
            'description': 'Codex App Server adapter for Flowit Workflow.',
            'main': 'dist/index.js', 'types': 'dist/index.d.ts',
            'exports': {'.': {'types': './dist/index.d.ts', 'default': './dist/index.js'}},
            'dependencies': {'@coaseedge/flowit-core': 'workspace:*'},
        },
        'adapter-dsh': {
            'name': '@coaseedge/flowit-adapter-dsh',
            'description': 'DeepSeek Harness reference adapter and plugin for Flowit Workflow.',
            'main': 'dist/index.js', 'types': 'dist/index.d.ts',
            'exports': {
                '.': {'types': './dist/index.d.ts', 'default': './dist/index.js'},
                './plugin': {'types': './dist/dsh/plugin.d.ts', 'default': './dist/dsh/plugin.js'},
                './tools': {'types': './dist/dsh/tools.d.ts', 'default': './dist/dsh/tools.js'},
            },
            'dependencies': {'@coaseedge/flowit-core': 'workspace:*'},
            'peerDependencies': {
                '@deepseek-ai/cordis': '^4.0.1',
                '@deepseek-ai/dsh-agent': '^0.1.1-rc.2',
                '@deepseek-ai/dsh-llm': '^0.1.1-rc.2',
                '@deepseek-ai/dsh-session': '^0.1.1-rc.2',
                '@deepseek-ai/dsh-session-persistence': '^0.1.1-rc.2',
                '@deepseek-ai/dsh-session-reference': '^0.1.1-rc.2',
                '@deepseek-ai/dsh-skill': '^0.1.1-rc.2',
                '@deepseek-ai/dsh-tools': '^0.1.1-rc.2',
                '@deepseek-ai/schemastery': '^3.18.1',
            },
        },
        'adapter-file-bridge': {
            'name': '@coaseedge/flowit-adapter-file-bridge',
            'description': 'Generic file-bridge adapter for Flowit Workflow.',
            'main': 'dist/index.js', 'types': 'dist/index.d.ts',
            'exports': {'.': {'types': './dist/index.d.ts', 'default': './dist/index.js'}},
            'dependencies': {'@coaseedge/flowit-core': 'workspace:*'},
        },
        'adapter-workbuddy': {
            'name': '@coaseedge/flowit-adapter-workbuddy',
            'description': 'WorkBuddy adapter for Flowit Workflow.',
            'main': 'dist/index.js', 'types': 'dist/index.d.ts',
            'exports': {'.': {'types': './dist/index.d.ts', 'default': './dist/index.js'}},
            'dependencies': {
                '@coaseedge/flowit-core': 'workspace:*',
                '@coaseedge/flowit-adapter-file-bridge': 'workspace:*',
            },
        },
        'adapter-doubao-office': {
            'name': '@coaseedge/flowit-adapter-doubao-office',
            'description': 'Doubao Office bridge adapter for Flowit Workflow.',
            'main': 'dist/index.js', 'types': 'dist/index.d.ts',
            'exports': {'.': {'types': './dist/index.d.ts', 'default': './dist/index.js'}},
            'dependencies': {
                '@coaseedge/flowit-core': 'workspace:*',
                '@coaseedge/flowit-adapter-file-bridge': 'workspace:*',
            },
        },
    }

    license_text = (ROOT / 'LICENSE').read_text()
    notice_text = (ROOT / 'NOTICE').read_text()
    for directory, spec in package_specs.items():
        package_dir = PACKAGES / directory
        name = str(spec['name'])
        description = str(spec['description'])
        manifest = {
            'name': name,
            'version': version,
            'description': description,
            'license': 'Apache-2.0',
            'type': 'module',
            **{key: value for key, value in spec.items() if key not in {'name', 'description'}},
            'files': ['dist', 'README.md', 'LICENSE', 'NOTICE'],
            'engines': engine,
            'scripts': {
                'build': 'tsc -p tsconfig.json',
                'typecheck': 'tsc -p tsconfig.json --noEmit',
            },
            'repository': {
                'type': 'git',
                'url': repository_url,
                'directory': f'packages/{directory}',
            },
            'publishConfig': {'access': 'public'},
        }
        write_json(package_dir / 'package.json', manifest)
        write_json(package_dir / 'tsconfig.json', package_tsconfig())
        (package_dir / 'LICENSE').write_text(license_text)
        (package_dir / 'NOTICE').write_text(notice_text)
        (package_dir / 'README.md').write_text(package_readme(name, description))

    write_json(
        ROOT / 'tsconfig.base.json',
        {
            'compilerOptions': {
                'target': 'ES2023',
                'module': 'NodeNext',
                'moduleResolution': 'NodeNext',
                'strict': True,
                'declaration': True,
                'skipLibCheck': True,
                'verbatimModuleSyntax': True,
                'noUncheckedIndexedAccess': True,
                'exactOptionalPropertyTypes': True,
                'types': ['node'],
            }
        },
    )
    write_json(
        ROOT / 'tsconfig.json',
        {
            'extends': './tsconfig.base.json',
            'compilerOptions': {'rootDir': 'src', 'outDir': 'dist'},
            'include': ['src/**/*.ts'],
            'exclude': ['dist', 'node_modules', 'tests', 'packages'],
        },
    )
    (ROOT / 'pnpm-workspace.yaml').write_text(
        "packages:\n  - 'packages/*'\n\nonlyBuiltDependencies:\n  - esbuild\n"
    )

    write_compatibility_wrappers()

    deepseek = {
        '@deepseek-ai/cordis': '^4.0.1',
        '@deepseek-ai/dsh-agent': '^0.1.1-rc.2',
        '@deepseek-ai/dsh-llm': '^0.1.1-rc.2',
        '@deepseek-ai/dsh-session': '^0.1.1-rc.2',
        '@deepseek-ai/dsh-session-persistence': '^0.1.1-rc.2',
        '@deepseek-ai/dsh-session-reference': '^0.1.1-rc.2',
        '@deepseek-ai/dsh-skill': '^0.1.1-rc.2',
        '@deepseek-ai/dsh-tools': '^0.1.1-rc.2',
        '@deepseek-ai/schemastery': '^3.18.1',
    }
    root_package['description'] = (
        'Batteries-included Flowit Workflow distribution aggregating the host-agnostic core and built-in adapters.'
    )
    root_package['dependencies'] = {
        '@coaseedge/flowit-core': 'workspace:*',
        '@coaseedge/flowit-adapter-claude-code': 'workspace:*',
        '@coaseedge/flowit-adapter-opencode': 'workspace:*',
        '@coaseedge/flowit-adapter-codex': 'workspace:*',
        '@coaseedge/flowit-adapter-dsh': 'workspace:*',
        '@coaseedge/flowit-adapter-file-bridge': 'workspace:*',
        '@coaseedge/flowit-adapter-workbuddy': 'workspace:*',
        '@coaseedge/flowit-adapter-doubao-office': 'workspace:*',
        **deepseek,
    }
    root_package.pop('peerDependencies', None)
    root_package.pop('peerDependenciesMeta', None)
    root_package.pop('pnpm', None)
    root_package['devDependencies'] = {
        '@biomejs/biome': '2.5.10',
        '@types/node': '^22.20.0',
        'tsx': '^4.22.4',
        'typescript': '^6.0.3',
    }
    root_package['scripts'].update(
        {
            'build:packages': "pnpm --filter './packages/**' -r build",
            'build:root': 'tsc -p tsconfig.json',
            'build': 'pnpm run build:packages && pnpm run build:root',
            'typecheck:root': 'tsc -p tsconfig.json --noEmit',
            'typecheck': 'pnpm run build:packages && pnpm run typecheck:root',
            'test:raw': 'node --import tsx --test tests/*.test.ts',
            'test:host-contracts:raw': 'node --import tsx --test tests/contracts/*.test.ts',
            'test': 'pnpm run build && pnpm run test:raw',
            'test:host-contracts': 'pnpm run build && pnpm run test:host-contracts:raw',
            'format': 'biome format --write packages/adapter-dsh/src/dsh/tools.ts',
            'format:check': 'biome format packages/adapter-dsh/src/dsh/tools.ts',
            'lint': 'biome lint packages/adapter-dsh/src/dsh/tools.ts',
            'check:style': 'biome ci --reporter=github packages/adapter-dsh/src/dsh/tools.ts',
            'check:package-boundaries': 'node scripts/check-package-boundaries.mjs',
            'check:pack': 'node scripts/check-package-packs.mjs',
            'check': (
                'npm run check:supply-chain && npm run check:package-boundaries && '
                'npm run check:style && npm run build && npm run check:pack && '
                'npm run typecheck:root && npm run test:raw && npm run test:host-contracts:raw'
            ),
        }
    )
    write_json(root_package_path, root_package)

    npmrc = ROOT / '.npmrc'
    if npmrc.exists():
        npmrc.unlink()

    write_policy_scripts()
    write_ci()
    append_docs()
    print('Package boundary migration prepared.')


if __name__ == '__main__':
    main()
