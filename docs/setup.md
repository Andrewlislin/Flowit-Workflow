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

WorkBuddy is the first concrete one-click provider:

```bash
# Review every planned mutation first.
flowit-workflow setup workbuddy --dry-run

# Interactive install.
flowit-workflow setup workbuddy

# Agent/non-interactive install after reviewing the plan.
flowit-workflow setup workbuddy --yes --json

# Validate or repair later.
flowit-workflow doctor workbuddy
flowit-workflow repair workbuddy --dry-run
```

The provider configures four machine-side integration layers:

1. **MCP** — merges `flowit-workflow` into `~/.workbuddy/mcp.json` for user scope or `<project>/.workbuddy/mcp.json` for project scope. Existing unrelated MCP servers are preserved. The Flowit server is configured with `FLOWIT_WORKFLOW_ADAPTER=workbuddy` and mutation tools enabled because applying the setup plan is itself confirmation-gated.
2. **Bridge Worker Skill** — installs the packaged Skill into `~/.codebuddy/skills/flowit-workflow-bridge-worker/` or the matching project `.codebuddy/skills/` directory. WorkBuddy's Agent execution layer consumes the same user/project Skill locations.
3. **Lifecycle Hooks** — merges SessionStart, Stop, and SessionEnd bridge-ingestion commands into `.codebuddy/settings.json` without replacing unrelated settings or Hooks.
4. **Bridge transport** — creates the durable WorkBuddy inbox/processing/outbox/cancellation/receipt/claim directories under `~/.flowit-workflow/bridges/workbuddy/`.

The provider writes a small ownership manifest so a later upgrade, repair, or uninstall can distinguish installer-owned values from user edits. Existing `flowit-workflow` MCP entries or Skill files that cannot be proven installer-owned block automatic setup instead of being overwritten. Applying a stale plan also fails if the target config changed after planning.

### Desktop Bridge limitation

Flowit can install every local file needed by the WorkBuddy Desktop Bridge, but WorkBuddy currently exposes no public API for a third-party installer to create or modify a native WorkBuddy Automation. Therefore desktop setup returns an explicit manual step for unattended execution: enable one WorkBuddy Automation that periodically invokes the installed **Flowit Workflow Bridge Worker** Skill. Interactive/manual Skill invocation works without that Automation.

If `FLOWIT_WORKFLOW_WORKBUDDY_DRIVER` is configured, the managed-agent-driver path does not require the desktop polling Automation.

After changing MCP, Skills, or Hooks, restart/reload WorkBuddy so it reloads those files.

### Uninstall semantics

`flowit-workflow uninstall workbuddy` removes only values that still exactly match installer ownership. It preserves:

- unrelated MCP servers;
- unrelated Hooks and settings;
- a Skill that the user modified after setup;
- Bridge state/history and pending transport files.

Bridge state is deliberately retained because deleting it could destroy pending work or audit history. A future explicit purge operation can own that destructive policy separately.

## Current rollout state

The known catalog includes:

- WorkBuddy — provider implemented;
- Claude Code — provider pending;
- Codex — provider pending;
- OpenCode — provider pending;
- DeepSeek Harness — provider pending;
- 豆包办公 — provider pending.

The remaining providers can land independently on the same framework without changing the CLI contract.
