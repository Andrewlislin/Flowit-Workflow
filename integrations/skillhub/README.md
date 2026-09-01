# SkillHub integration

Flowit treats SkillHub as a distribution channel, not as the Studio application/trust format.

## Trust boundary

Third-party publishers may generate and upload only a **data-only Studio payload**:

```text
flowit-skillhub.json
studio/
  flowit.package.json
  ...declarative Studio files...
```

A third-party payload MUST NOT contain `SKILL.md`, JavaScript installers, bootstrap scripts, shell scripts, or any executable installer copied from Flowit. The `flowit-studio skillhub` command enforces this generated shape.

Automatic installation is delegated to the separately published **CoaseEdge Flowit Studio Installer** Skill under `integrations/skillhub/official-installer/`. SkillHub (or another distribution channel) must authenticate that installer as published by CoaseEdge before the Host executes it. If the channel cannot establish that publisher identity, Flowit does not claim a trusted one-click installation path for third-party payloads.

The official installer does not form identity conclusions against the mutable channel directory. It pins the official npm package/registry and delegates the payload path to the Flowit-owned `flowit-studio install-skillhub-payload` entrypoint. The Flowit child first copies the complete payload into a Flowit-owned staging snapshot, fences the snapshot tree, parses `flowit-skillhub.json`, validates the bundled Studio manifest, checks channel identity on those frozen bytes, and records both the full payload digest and `studio/` digest.

The actual Studio install then uses only `snapshot/studio` and passes that Studio digest into the existing immutable install/handoff fence. If the original SkillHub payload changes after Flowit freezes it, the change is irrelevant. If the Flowit-owned snapshot is modified before the child Studio freeze, installation fails before Host setup mutation.

This closes the channel boundary as:

```text
mutable channel payload
→ Flowit-owned payload snapshot
→ metadata/manifest identity on snapshot
→ frozen Studio digest
→ Studio trust/license review
→ installed bytes
```

This separation means a Studio publisher can replace or customize its own channel payload, but cannot replace the executable installer while still satisfying the Flowit trusted-install contract, and cannot race checked channel metadata against different Studio bytes.
