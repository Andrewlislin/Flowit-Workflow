<div align="center">

# Build with Flowit

## Turn professional methods into AI Studios

**Create an AI Studio that can be installed, run by Flowit and distributed to other users.**

Free authoring · Local-first · Multi-agent · No workflow runtime to rebuild

[Flowit product home](../../README.en.md) · [中文](README.md) · **English**

</div>

---

## You own the method; Flowit owns durable execution

The valuable part of professional work is rarely one prompt. It is usually a system of:

```text
role boundaries
+ decision criteria
+ repeatable stages
+ intermediate artifacts
+ review rules
+ recovery boundaries
```

A Flowit Studio packages that system as a declarative workflow application. Creators describe the method and delivery standard. Flowit Workflow provides persisted state, scheduling, retry, recovery, multi-agent orchestration and host integration.

```text
Your professional method
          ↓
Flowit Studio Package
          ↓
Flowit Workflow Runtime
          ↓
Claude Code / Codex / WorkBuddy / other hosts
```

A Studio is not merely a raw Agent Skill. A Skill usually tells an agent what it can do. A Studio can additionally declare roles, workflow structure, prompt files, quality boundaries, host compatibility, runtime ranges, licensing and package identity.

## Start here

| Entry | Purpose |
| --- | --- |
| [Create your first Studio in 10 minutes](quickstart.en.md) | Scaffold, validate, test and pack a minimal Studio |
| [Starter Studios](../../examples/studios/) | Learn from copyable Package, Preset and role-file examples |
| [Studio SDK / CLI](sdk.en.md) | Authoring APIs, CLI commands and declarative boundaries |
| [Studio Package Spec v1](package-spec.en.md) | Manifest, runtime compatibility and package trust boundaries |
| [Installation and runtime bootstrap](install.en.md) | Consumer installation, host setup, Doctor and approval boundaries |
| [Publishing and distribution](publish.en.md) | Packaging, signing, licensing, SkillHub and other channels |

## Creator loop

```text
Define the professional method
            ↓
Scaffold a Studio
            ↓
Edit roles / prompts / preset
            ↓
validate
            ↓
test
            ↓
pack
            ↓
sign / distribute / install
```

The current Creator CLI exposes `init`, `inspect`, `validate`, `test`, `pack` and `skillhub`. Studios are declarative by default: authors cannot use arbitrary JavaScript hooks, installer scripts or custom runtime URLs to cross Flowit’s trust boundary.

## Two product entries, one platform

```text
Flowit
│
├── Flowit Workflow
│   └── use and operate durable AI workflows
│
└── Build with Flowit
    └── create, validate, package and distribute AI Studios
                    │
                    ▼
           Flowit Studio Package
                    │
                    ▼
           Flowit Workflow Runtime
```

The repository therefore keeps one engineering center: Flowit Workflow. Creator documentation has its own entry and narrative, while the SDK, Package Spec, installer and Runtime continue to evolve in one Monorepo.

`Flowit Studio SDK` is the current technical entry into the Creator Platform, not the only long-term entry. A Studio CLI and a future Studio Builder GUI can live under the same product layer without changing the Package or Runtime boundary.

## Current beta boundary

Available now:

- scaffold a minimal Studio;
- validate manifests, package trees, paths and declarative work graphs;
- compile-test through the same PresetDefinition path used by the Runtime;
- produce a revalidated `.flowit` directory bundle;
- declare publisher, license, host compatibility and runtime range;
- verify commercial package signatures and local licenses;
- prepare package installation, a compatible Runtime, host integration and Doctor readiness through one install chain;
- generate data-only SkillHub payloads.

Still evolving:

- a universal installed-Studio `run` / `activate` / `studio_run` consumer API;
- automatic discovery of `StudioPackageStore` by the default Preset Registry;
- a no-code Studio Builder GUI;
- a complete publisher console, marketplace, transaction and delivery experience.

For now, “installation complete” precisely means that the Package, compatible Runtime and standard host integration are installed and Doctor has passed. It does not mean every host already has a universal one-click Studio launch entry.

## Responsibility boundary

Creators may declare:

```text
Studio identity and version
roles and prompts
preset and work graph
input and artifact contracts
supported hosts
required Skills and permissions
runtime compatibility range
license type
```

Flowit retains control of:

```text
durable runtime
host setup providers
package-tree validation
runtime bootstrap
publisher trust
signature and license verification
installation transactions
scheduling, retry, recovery and leases
```

This separation lets third-party Creators produce Studios without gaining arbitrary authority to modify the Flowit Runtime or an agent host’s configuration.

## Next step

Start with the [10-minute Quickstart](quickstart.en.md). For an existing method or workflow, copy the structure of [research-starter](../../examples/studios/research-starter/) and replace its roles, prompts and work graph incrementally.
