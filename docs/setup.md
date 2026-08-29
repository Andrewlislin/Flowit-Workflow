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

`SetupPlan` actions carry a stable action id, risk class, confirmation requirement, reversibility flag, optional target, and provider-owned details. This lets future WorkBuddy, Claude Code, Codex, OpenCode, DSH, and Bridge providers expose the same user experience without pretending their underlying integration mechanisms are identical.

## Safety and idempotency expectations

Host providers added after this framework should preserve these rules:

1. Parse and merge existing configuration rather than overwrite it.
2. Support repeated setup runs without duplicating managed entries.
3. Back up or otherwise make reversible configuration mutations recoverable when practical.
4. Revalidate ownership and current configuration before applying a previously generated plan.
5. Keep destructive uninstall actions confirmation-gated.
6. Report unsupported or manual-only host steps explicitly.
7. Never enable model-visible mutation permissions without an explicit user/deployment opt-in.

## Current rollout state

This framework lands before the concrete host installers. The known catalog already includes:

- WorkBuddy
- Claude Code
- Codex
- OpenCode
- DeepSeek Harness
- 豆包办公

Until a host-specific provider is registered, `flowit-workflow setup <host>` fails with an explicit "provider not implemented" error. The next productization changes can add providers independently without changing the CLI contract.
