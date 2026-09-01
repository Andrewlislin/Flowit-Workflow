# Flowit Studio SDK

Flowit Studio SDK turns professional methods into declarative, locally runnable workflow applications without requiring authors to modify Flowit Core.

## Author loop

```bash
flowit-studio init ./customer-research \
  --id=acme.customer-research \
  --name="Customer Research" \
  --publisher=acme \
  --host=codex

flowit-studio validate ./customer-research
flowit-studio test ./customer-research
flowit-studio pack ./customer-research --out=./dist
```

`init` creates a minimal `flowit.package.json`, entry preset, role prompt and README. The generated runtime range is derived from the Flowit version running the SDK, so a Studio created by the current CLI is compatible with that CLI by default. A non-empty target directory is never overwritten implicitly; use `--force` only when replacement is intentional.

`validate` performs manifest, path, package-tree and declarative graph validation. `test` additionally compiles the Studio through the same `PresetDefinition` path used by Flowit. `pack` produces a validated directory bundle named `*.flowit`.

The first package container is intentionally a directory bundle. Distribution channels may transport it inside their own archive, but the Flowit trust boundary validates the unpacked package tree before installation. A future binary container can be added without changing the Studio manifest/DSL contract.

## Public API

Authors can import the same APIs from:

```ts
import {
  createStudioScaffold,
  validateStudioProject,
  packStudioProject,
} from '@coaseedgeltd/flowit-workflow/studio'
```

## Declarative preset

`presets/<entryPreset>.json` contains only data. It cannot define arbitrary JavaScript hooks. Prompt files may use the bounded substitutions `{{input}}`, `{{workspace}}`, and `{{pipelineName}}`.

## Security boundary

Studio authors declare runtime version, host compatibility, role prompts, Skills and permissions. They do not get to provide a Flowit runtime URL, a custom runtime installer, or arbitrary host-configuration scripts. Standard Host integration remains owned by Flowit's existing Setup Providers.

Commercial package signing and offline licenses are orthogonal to authoring: a publisher signs the completed package tree after `pack`, and the receiving Flowit installation verifies it against locally trusted publisher keys.
