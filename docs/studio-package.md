# Flowit Studio Package v1

A **Flowit Studio** is an installable workflow application that runs on the local Flowit runtime. It is intentionally distinct from a raw Agent Skill: a Studio can describe roles, presets, templates, quality rules, host compatibility, licensing, and runtime requirements while Flowit continues to own durable execution and host integration.

## Product boundary

The Studio Package is the application format. Distribution is deliberately separate: a package may arrive from SkillHub, a publisher website, GitHub, an enterprise registry, or a local file. Every source is installed through the same Flowit package/trust boundary.

The first public manifest is `flowit.package.json` and has `schemaVersion: 1`.

```json
{
  "schemaVersion": 1,
  "id": "acme.saas-intelligence",
  "displayName": "SaaS 竞品情报工作室",
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

## Runtime bootstrap rule

A third-party package may declare that it requires Flowit, but it **must not** define how Flowit itself is installed. `runtime.bootstrap` is fixed to `official` in v1. The package format intentionally has no `installScript`, arbitrary executable hook, or publisher-controlled runtime URL.

This lets a user make one product-level decision — “install this Studio” — while the official bootstrap layer resolves the shared Flowit runtime and the standard current-host integration. Publishers do not receive authority to mutate Agent host configuration directly.

## One install intent, bounded authority

A user-initiated Studio install grants the standard dependency scope once:

- bootstrap the official Flowit runtime when it is missing;
- establish a standard Flowit integration for the current Agent host;
- write files inside Flowit-managed package locations.

These standard dependency actions do not require a second Flowit-specific confirmation after the user has explicitly asked to install the Studio. Elevated permissions remain outside that intent and must still cross their own user/host approval boundary.

Examples of elevated behavior include administrator privileges, publishing to an external account, production deployment, deleting user data, or access outside declared/standard workspaces.

## Trust principles

1. Publishers declare requirements; Flowit owns the implementation of runtime and host integration.
2. Third-party packages are declarative by default and must not gain arbitrary installation code execution.
3. Flowit runtime is shared across Studios; packages declare a compatible version range instead of bundling private runtimes.
4. Studio uninstall must not delete durable Flowit state that is outside the package ownership boundary.
5. Package signature, licensing, package storage, DSL compilation, and lifecycle tooling are layered on this v1 contract in subsequent changes.
