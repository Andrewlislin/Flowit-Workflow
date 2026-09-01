# Flowit Studio SDK / CLI

[Build with Flowit home](README.en.md) · [中文](sdk.md) · [Quickstart](quickstart.en.md) · [Package Spec](package-spec.en.md)

Flowit Studio SDK turns professional methods into declarative workflow applications that run on the local Flowit Runtime. Authors do not need to modify Flowit Core or rebuild scheduling, recovery, host adapters or the installation trust chain.

The SDK currently ships with `@coaseedgeltd/flowit-workflow`:

```text
npm package: @coaseedgeltd/flowit-workflow
CLI:         flowit-studio
ESM export:  @coaseedgeltd/flowit-workflow/studio
```

## Author loop

```bash
flowit-studio init ./customer-research \
  --id=acme.customer-research \
  --name="Customer Research Studio" \
  --publisher=acme \
  --host=codex

flowit-studio validate ./customer-research
flowit-studio test ./customer-research
flowit-studio pack ./customer-research --out=./dist
```

`init` creates a minimal `flowit.package.json`, entry Preset, role prompt and README. The generated runtime range is derived from the Flowit version bundled with the current CLI, so a new Studio is compatible with that CLI by default.

A non-empty target directory is never overwritten implicitly. Use `--force` only when replacement is intentional.

## CLI commands

| Command | Purpose |
| --- | --- |
| `flowit-studio init <dir>` | Scaffold a minimal Studio |
| `flowit-studio inspect <dir>` | Load and display the Package Descriptor |
| `flowit-studio validate <dir>` | Validate the manifest, paths, Package Tree and declarative graph |
| `flowit-studio test <dir>` | Compile-test through the Runtime’s PresetDefinition path |
| `flowit-studio pack <dir>` | Produce a revalidated `.flowit` directory bundle |
| `flowit-studio skillhub <dir>` | Produce a data-only SkillHub payload |
| `flowit-studio list` | List locally installed Studios |
| `flowit-studio install <dir>` | Enter the consumer Package / Runtime / host installation chain |
| `flowit-studio install-skillhub-payload <dir>` | Install from a frozen and checked SkillHub payload |
| `flowit-studio experience-report` | Read the local installation-experience aggregate |

Installation involves publisher trust, licensing, host scope and possible runtime handoff. It is not ordinary file copying. See [Installation and runtime bootstrap](install.en.md).

## Public API

Authors can import the authoring APIs from the stable subpath:

```ts
import {
  createStudioScaffold,
  validateStudioProject,
  packStudioProject,
} from '@coaseedgeltd/flowit-workflow/studio'
```

The three primary functions map to:

```text
createStudioScaffold
  create the directory, manifest, Preset, role prompt and README

validateStudioProject
  load the Package, fence the tree, compile the declarative Preset
  and render a test Pipeline

packStudioProject
  validate, copy into a disjoint output tree, then validate the output again
```

The Studio subpath also exports schemas, package loading, storage, DSL, signing, licensing, installation, bootstrap, distribution and diagnostics. Treat those lower-level contracts as public security and version boundaries rather than convenience internals.

## Declarative Preset

`presets/<entryPreset>.json` contains data only. A Studio cannot define arbitrary JavaScript hooks in the Preset.

Prompt files support the bounded substitutions:

```text
{{input}}
{{workspace}}
{{pipelineName}}
```

The minimal graph consists of:

```text
roles
nodes
edges
input contract
promptFile references
```

`validate` and `test` compile these declarations into the same `PresetDefinition` used by Flowit and render a Pipeline with test Session bindings.

## Package output

`pack` currently produces a directory bundle:

```text
<studio-id>-<version>.flowit/
├── flowit.package.json
├── presets/
├── roles/
└── ...
```

It is not a binary container with implicit executable installation code. Channels may place the directory inside their own archive, but Flowit establishes trust over the complete unpacked Package Tree.

The default output directory is outside the Studio source. The SDK rejects source and output trees that contain one another, preventing recursive copies and destructive replacement.

## Security boundary

Studio authors may declare:

```text
runtime version range
host compatibility
roles and prompts
Skill and permission requirements
publisher and license
```

Studio authors may not declare:

```text
a custom Flowit Runtime URL
a custom Runtime installer
arbitrary host-configuration scripts
a package installScript
arbitrary code execution outside the declarative boundary
```

Standard host integration remains owned by Flowit Setup Providers. Commercial signing and offline licensing are layered after authoring: the publisher signs the completed Package Tree, and the receiving installation verifies it using locally trusted publisher keys and license documents.

## Version strategy

Studio capabilities are still beta and currently versioned with the main Runtime. Keeping one Monorepo and one npm distribution avoids premature version drift among the SDK, Package Spec, Runtime and installer.

A separate `flowit-studio-sdk` repository or package should be reconsidered after a stable `v1`, substantial third-party Creator usage, distinct issue categories and an independent release cadence emerge.

## Current execution boundary

The SDK can scaffold, validate, test, pack and install Studios. A universal installed-Studio `run` / `activate` / `studio_run` consumer API is not complete. Do not interpret `install complete` or `pack succeeded` as a universal launch entry across every host.
