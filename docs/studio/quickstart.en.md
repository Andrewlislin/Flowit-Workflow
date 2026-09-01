# Create your first Flowit Studio in 10 minutes

[Build with Flowit home](README.en.md) · [中文](quickstart.md) · [Studio SDK](sdk.en.md) · [Package Spec](package-spec.en.md)

This Quickstart creates a minimal Customer Research Studio, validates it, compile-tests it and produces a distributable package.

## 1. Install the Creator CLI

Requires Node.js `^22.19.0` or `>=24.0.0`.

```bash
npm install --global @coaseedgeltd/flowit-workflow@beta
```

Verify that the CLI runs:

```bash
flowit-studio list
```

An empty list is expected when no Studios are installed.

## 2. Scaffold a Studio

```bash
flowit-studio init ./customer-research \
  --id=acme.customer-research \
  --name="Customer Research Studio" \
  --publisher=acme \
  --host=codex
```

Generated structure:

```text
customer-research/
├── flowit.package.json
├── README.md
├── presets/
│   └── customer-research.json
└── roles/
    └── worker.md
```

`init` creates version `0.1.0`, one `worker` role and one `work` node. The runtime compatibility range is derived from the Flowit version bundled with the current Creator CLI, so the scaffold is compatible with that CLI by default.

A non-empty target directory is never overwritten implicitly. Use `--force` only when replacement is intentional.

## 3. Describe the method

Start with `roles/worker.md`. A minimal professional prompt can define the delivery standard:

```markdown
# Customer researcher

Research the customer described by the input goal.

Separate:
- confirmed facts;
- reasonable inferences;
- unresolved information gaps.

Write the final report under {{workspace}}.
Goal: {{input}}
```

Prompt files support only the bounded substitutions:

```text
{{input}}
{{workspace}}
{{pipelineName}}
```

Then edit `presets/customer-research.json`. Replace the generic Worker with a professional process over time, for example:

```text
Frame the research question
          ↓
Collect evidence
          ↓
Find counter-evidence and gaps
          ↓
Synthesize conclusions
          ↓
Independent review
```

A Preset is data-only. It cannot define arbitrary JavaScript hooks; roles, nodes and edges must be expressed as a declarative work graph.

## 4. Validate

```bash
flowit-studio validate ./customer-research
```

Validation covers:

```text
flowit.package.json
package-tree and path boundaries
manifest / preset consistency
role and prompt references
nodes, edges and declarative graph
runtime and host declarations
```

Fix the Package contents when validation fails rather than bypassing the validator.

## 5. Compile-test

```bash
flowit-studio test ./customer-research
```

`test` compiles the Studio through the same `PresetDefinition` path used by the Flowit Runtime and renders a Pipeline with test bindings. It verifies that the Studio forms a valid workflow; it does not execute real external work.

## 6. Pack

```bash
flowit-studio pack ./customer-research --out=./dist
```

The output resembles:

```text
dist/
└── acme.customer-research-0.1.0.flowit/
```

The current `.flowit` format is a revalidated directory bundle, not a binary container with implicit executable installation code. Distribution channels may transport the directory, but Flowit re-establishes trust over the complete unpacked Package Tree during installation.

## 7. Continue from a Starter Studio

The repository includes a copyable example:

```text
examples/studios/research-starter/
```

It contains:

```text
flowit.package.json
presets/research-starter.json
roles/researcher.md
roles/reviewer.md
```

See [Starter Studios](../../examples/studios/) for the distinction between learning examples and `studios/community/`.

## Current boundary

At this point you have a Studio Package that can be validated, compile-tested and packed.

The current beta does not yet expose a universal installed-Studio `run` / `activate` / `studio_run` consumer API, and the default Preset Registry does not automatically scan every installed Package. Therefore:

```text
pack succeeded
≠ published to a marketplace
≠ every host has a universal one-click launch entry
```

Continue with:

- [Installation and runtime bootstrap](install.en.md)
- [Publishing and distribution](publish.en.md)
- [Studio Package Spec v1](package-spec.en.md)
