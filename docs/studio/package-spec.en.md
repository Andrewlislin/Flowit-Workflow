# Flowit Studio Package Spec v1

[Build with Flowit home](README.en.md) · [中文](package-spec.md) · [Studio SDK](sdk.en.md) · [Installation](install.en.md)

A **Flowit Studio** is an installable workflow application that runs on the local Flowit Runtime.

It is intentionally distinct from a raw Agent Skill. A Studio can describe roles, Presets, templates, quality rules, host compatibility, licensing and runtime requirements while Flowit continues to own durable execution and host integration.

## Product boundary

The Studio Package is the application format, not a distribution channel.

The same Package may arrive from:

```text
SkillHub
a publisher website
GitHub
an enterprise registry
a local file
```

Every source must eventually cross the same Flowit Package and trust boundary. A channel does not replace Package Tree validation, publisher trust, signatures, licensing or runtime compatibility checks.

The first public manifest is:

```text
flowit.package.json
schemaVersion: 1
```

## Manifest example

```json
{
  "schemaVersion": 1,
  "id": "acme.saas-intelligence",
  "displayName": "SaaS Intelligence Studio",
  "publisher": {
    "id": "acme-research",
    "displayName": "ACME Research"
  },
  "version": "1.0.0",
  "runtime": {
    "id": "flowit-workflow",
    "version": ">=1.0 <2",
    "bootstrap": "official"
  },
  "supportedHosts": ["claude-code", "codex", "workbuddy"],
  "entryPreset": "saas-intelligence",
  "license": {
    "type": "commercial-perpetual"
  }
}
```

The fields carry separate semantics:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Manifest schema version |
| `id` | Stable global Studio identity |
| `displayName` | User-facing name |
| `publisher` | Publisher identity, distinct from channel identity |
| `version` | Studio Package version |
| `runtime` | Required Flowit Runtime and compatibility range |
| `supportedHosts` | Agent hosts declared compatible by the Studio |
| `entryPreset` | Declarative entry Preset |
| `license` | Local installation and commercial entitlement type |

## Runtime bootstrap rule

A third-party Package may declare that it requires Flowit, but it **must not define how Flowit itself is installed**.

In v1:

```text
runtime.id        = flowit-workflow
runtime.bootstrap = official
```

The Package format intentionally has no:

```text
installScript
arbitrary executable hook
publisher-controlled Runtime URL
custom host-configuration script
```

This lets a user make one product-level decision—“install this Studio”—while the official bootstrap layer resolves the shared Runtime and standard current-host integration. Publishers do not receive arbitrary authority to modify an Agent host.

## One install intent, bounded authority

After the user explicitly asks to install a Studio, that intent may cover the standard dependency scope:

```text
bootstrap the official Flowit Runtime when missing
establish standard Flowit integration for the current Agent host
write inside Flowit-managed Package locations
```

These standard dependency actions do not require a second “install Flowit?” confirmation.

Elevated behavior still crosses its own user or host approval boundary:

```text
administrator privileges
publishing to an external account
production deployment
deleting user data
access outside declared workspaces
Studio-declared elevated permissions
```

Host-native workspace trust, MCP approval, Plugin trust and Automation boundaries also remain authoritative.

## Declarative Package Tree

A typical Studio:

```text
my-studio/
├── flowit.package.json
├── README.md
├── presets/
│   └── <entryPreset>.json
└── roles/
    ├── researcher.md
    └── reviewer.md
```

Presets contain data only, and prompts use bounded substitutions. A v1 Package does not expand installation authority through arbitrary code execution.

## Shared Runtime model

```text
Studio A ─┐
Studio B ─┼─→ shared Flowit Workflow Runtime
Studio C ─┘
```

Each Studio declares a compatible version range instead of bundling a private Runtime. This keeps scheduling, recovery, host adapters, security fixes and state ownership unified.

Studio uninstall must not delete durable Flowit state outside the Package ownership boundary.

## Trust principles

1. Publishers declare requirements; Flowit owns the implementation of Runtime and host integration.
2. Third-party Packages are declarative by default and do not gain arbitrary installation code execution.
3. Flowit Runtime is shared across Studios; Packages declare compatible ranges instead of bundling private runtimes.
4. Studio uninstall must not delete durable state outside Package ownership.
5. Package signing, licensing, storage, DSL compilation and lifecycle tooling are layered on the v1 contract.
6. Channel identity, publisher identity, Package identity and installed local identity are verified separately and cannot substitute for one another.

## Current container

`pack` currently produces a path such as:

```text
acme.saas-intelligence-1.0.0.flowit/
```

It is a directory bundle. A future binary container may be added, but it should not change the core Manifest / DSL contract or weaken full validation of the unpacked Package Tree.
