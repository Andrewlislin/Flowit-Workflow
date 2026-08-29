# Host setup framework

Flowit Workflow is moving toward one setup experience across Agent hosts while keeping each host's technical integration honest. The setup layer is deployment orchestration; it does not change the `AgentAdapter` runtime contract.

## Commands

```bash
flowit-workflow setup
flowit-workflow setup <host> --dry-run
flowit-workflow setup <host> --yes
flowit-workflow doctor [host|all]
flowit-workflow repair <host|all> --dry-run
flowit-workflow uninstall <host|all> --dry-run
```

Common options:

- `--scope=user|project` selects where a provider plans configuration changes.
- `--project-dir=<path>` sets the project root for project-scoped setup.
- `--dry-run` emits the exact provider plan without applying mutations.
- `--yes` approves confirmation-gated actions for non-interactive Agent-driven setup.
- `--json` emits machine-readable discovery, plans, doctor reports, and results.

With no host argument, `setup` lists the known host catalog and whether an implementation is registered. The framework intentionally fails closed when a known host does not yet have a provider; it does not pretend setup succeeded.

## Provider contract

Each host implements `HostSetupProvider` and owns its real detection, setup, repair, and uninstall semantics. The shared CLI only performs discovery, plan validation, consent, execution dispatch, and rendering.

A provider supplies:

- host detection;
- a versioned `SetupPlan` for setup, repair, and uninstall;
- application of the exact validated plan;
- `DoctorReport` health checks;
- explicit manual steps when host APIs cannot automate a required action.

`SetupPlan` actions carry a stable action id, risk class, confirmation requirement, reversibility flag, optional target, and provider-owned details. This lets WorkBuddy, Claude Code, Codex, OpenCode, DSH, and Bridge providers expose the same user experience without pretending their underlying integration mechanisms are identical.

## Safety and idempotency expectations

Every concrete provider must preserve these rules:

1. Parse and merge existing configuration rather than overwrite it.
2. Support repeated setup runs without duplicating managed entries.
3. Record enough ownership to make repair and uninstall conservative.
4. Revalidate ownership and current configuration before applying a previously generated plan.
5. Keep destructive uninstall actions confirmation-gated.
6. Report unsupported or manual-only host steps explicitly.
7. Never enable model-visible mutation permissions without an explicit user/deployment opt-in.
8. Fail closed on malformed or conflicting configuration instead of guessing how to rewrite it.

## WorkBuddy provider

```bash
flowit-workflow setup workbuddy --dry-run
flowit-workflow setup workbuddy
flowit-workflow setup workbuddy --yes --json
flowit-workflow doctor workbuddy
flowit-workflow repair workbuddy --dry-run
```

The provider configures four machine-side integration layers:

1. **MCP** — merges `flowit-workflow` into `~/.workbuddy/mcp.json` for user scope or `<project>/.workbuddy/mcp.json` for project scope. Existing unrelated MCP servers are preserved. The Flowit server is configured with `FLOWIT_WORKFLOW_ADAPTER=workbuddy` and mutation tools enabled because applying the setup plan is itself confirmation-gated.
2. **Bridge Worker Skill** — installs the packaged Skill into `~/.codebuddy/skills/flowit-workflow-bridge-worker/` or the matching project `.codebuddy/skills/` directory.
3. **Lifecycle Hooks** — merges SessionStart, Stop, and SessionEnd bridge-ingestion commands into `.codebuddy/settings.json` without replacing unrelated settings or Hooks.
4. **Bridge transport** — creates the durable WorkBuddy inbox/processing/outbox/cancellation/receipt/claim directories under `~/.flowit-workflow/bridges/workbuddy/`.

The provider writes an ownership manifest so a later upgrade, repair, or uninstall can distinguish installer-owned values from user edits. Existing same-name values that conflict with the desired installer configuration block automatic setup instead of being overwritten. Applying a stale plan also fails if the target config changed after planning.

### Desktop Bridge limitation

Flowit can install every local file needed by the WorkBuddy Desktop Bridge, but WorkBuddy currently exposes no public API for a third-party installer to create or modify a native WorkBuddy Automation. Therefore desktop setup returns an explicit manual step for unattended execution: enable one WorkBuddy Automation that periodically invokes the installed **Flowit Workflow Bridge Worker** Skill.

If `FLOWIT_WORKFLOW_WORKBUDDY_DRIVER` is configured, the managed-agent-driver path does not require the desktop polling Automation.

### WorkBuddy uninstall semantics

`flowit-workflow uninstall workbuddy` removes only values that still exactly match installer ownership. It preserves unrelated MCP servers/Hooks/settings, user-modified Skills, and all Bridge history/pending transport state.

## Claude Code provider

Claude Code uses its native **skills-directory plugin** mechanism rather than scattering Flowit configuration across user settings:

```bash
flowit-workflow setup claude-code --dry-run
flowit-workflow setup claude-code
flowit-workflow setup claude-code --yes --json
flowit-workflow doctor claude-code
flowit-workflow repair claude-code --dry-run
```

For user scope, Flowit installs one managed plugin root at:

```text
~/.claude/skills/flowit-workflow/
  .claude-plugin/plugin.json
  skills/run-bound/SKILL.md
  skills/orchestrate/SKILL.md
  hooks/hooks.json
  .mcp.json
```

Claude Code automatically discovers a directory under `~/.claude/skills/` that contains `.claude-plugin/plugin.json` as a personal plugin. This lets one isolated plugin bundle the exact Flowit Skills, lifecycle Hooks, and orchestration MCP server without rewriting unrelated `~/.claude/settings.json` entries.

The generated MCP server enables Flowit mutation tools only as part of the confirmation-gated setup operation and sets `FLOWIT_WORKFLOW_PLUGIN_ROOT` to the installed plugin root so cold dispatch can use the same plugin boundary. The generated Hook commands call the built Flowit CLI directly with `claude-hook`.

For project scope, the same plugin is installed at `<project>/.claude/skills/flowit-workflow/`. Claude Code intentionally keeps its own workspace-trust and project MCP approval gates for project-provided executable components; Flowit reports those as manual steps and does not bypass them.

### Claude ownership and repair

A Flowit ownership manifest records hashes only for files the installer actually owns. If the target `flowit-workflow` plugin directory already exists without that manifest, setup fails closed instead of adopting it. If an installer-owned file is later modified by the user, repair/uninstall preserves that modified file and reports the ownership conflict.

The first install seeds ownership before creating managed plugin files. This makes an interrupted initial install recoverable: a subsequent repair can finish missing files without confusing the partial plugin with a foreign directory.

### Claude uninstall semantics

`flowit-workflow uninstall claude-code` removes only files whose current hash still matches the installer ownership manifest. Empty managed directories are pruned, but non-empty or user-added content is preserved. Durable Claude event/session state under `~/.flowit-workflow/claude/` is retained.

After setup, repair, or uninstall, restart Claude Code or run `/reload-plugins` to reload plugin components.

## Current rollout state

The known catalog includes:

- WorkBuddy — provider implemented;
- Claude Code — provider implemented;
- Codex — provider pending;
- OpenCode — provider pending;
- DeepSeek Harness — provider pending;
- 豆包办公 — provider pending.

The remaining providers can land independently on the same framework without changing the CLI contract.
