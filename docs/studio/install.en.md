# Installing a Flowit Studio

[Build with Flowit home](README.en.md) · [中文](install.md) · [Package Spec](package-spec.en.md) · [Publishing](publish.en.md)

The ordinary-user entry is **install this Studio**, not “learn and install a workflow runtime first.”

## First install or incompatible Runtime

```text
User: install this Studio
          ↓
copy into Flowit-owned immutable Studio snapshot A
          ↓
validate manifest and runtime range
          ↓
does the current Flowit satisfy the range?
   ├─ yes → continue reviewing A
   └─ no  → prepare a compatible Runtime from the fixed official registry
             → hand off A's snapshot path, digest and source label
             → compatible flowit-studio continues from A
             → never reopen the mutable publisher source
          ↓
detect the current Agent host
          ↓
review publisher / license / DSL / permissions over the same frozen bytes
          ↓
official Host Setup Provider
          ↓
atomically commit the reviewed snapshot to Flowit-owned storage
          ↓
Doctor
          ↓
complete → Package, Runtime and host integration are ready
manual-action-required → identify the remaining host-native trust step
partial / unhealthy → require Repair
```

Host Setup aggregation is fail-closed. `partial`, `failed` and `unsupported` keep the installation transaction in a partial state even when a later Doctor probe appears healthy. First-run reports such results as `repair-required`; they do not produce host-setup or Studio-install success diagnostics.

Runtime handoff is not a second external installation request. The old Runtime retains the frozen snapshot until the compatible child exits. The child receives the snapshot path and expected digest, then verifies byte identity again. Replacing the original download directory during handoff cannot change the bytes being installed.

After the user explicitly chooses a Studio, the standard dependency tree does not ask a second “install Flowit?” question. Administrator privileges, external publishing, production deployment, deletion, declared `elevated` permissions and host-native trust boundaries still require their own approval.

## Immutable installation chain

Flowit does not form trust conclusions over a mutable third-party directory. The external source is copied into Flowit-owned staging. Staging then crosses:

```text
symlink / tree fence
→ manifest and DSL validation
→ full Package digest
→ publisher signature
→ license verification
```

`apply` may commit only the snapshot reviewed during `prepare`. Flowit fences and hashes again before commit, so installed bytes must equal reviewed bytes.

Commercial Packages use Ed25519 signatures. Offline licenses support personal, team and enterprise entitlement types. In the local-only model, team seats are signed entitlement information; Flowit does not claim centralized cross-device seat consumption without a cloud authority.

## Official Runtime trust root

A Studio declares only a compatible range. It cannot choose the Runtime URL or installer.

The official bootstrap root is fixed to:

```text
package:  @coaseedgeltd/flowit-workflow
registry: https://registry.npmjs.org/
scope:    @coaseedgeltd → https://registry.npmjs.org/
```

npm lifecycle scripts are disabled during bootstrap and local provenance is recorded. A pre-existing Runtime without that provenance is not silently treated as official. The Studio runtime range is an enforced installation preflight, not documentation advice.

## SkillHub separation

A third-party SkillHub artifact is a **data-only payload**:

```text
flowit-skillhub.json
studio/
  flowit.package.json
  presets/
  roles/
  ...
```

`flowit-studio skillhub` does not copy `SKILL.md`, `install.mjs`, bootstrap scripts or other executable installers into the publisher payload.

Automatic installation belongs to a separately published official CoaseEdge Flowit Studio Installer Skill. A channel must authenticate that Installer’s publisher identity before execution; otherwise Flowit does not describe the path as trusted one-click installation.

The official Installer invokes:

```text
flowit-studio install-skillhub-payload <payload-directory>
```

The Flowit child first freezes the complete payload into `SkillHubPayloadStore`, then checks:

```text
tree / symlink fence
→ flowit-skillhub.json runtime metadata
→ channel metadata ↔ manifest identity
→ full payload digest
→ studio/ tree digest
```

Only the frozen `snapshot/studio` tree can enter ordinary Studio installation.

SkillHub is one transport channel. It is not the Studio application or trust format; the same `.flowit` Package may come from GitHub, a publisher site, an enterprise registry or a local file.

## Installation complete is not universal execution

The current installation chain establishes:

```text
Package installation
+ compatible Runtime
+ host integration
+ Doctor readiness
```

It does **not yet provide** a universal installed-Studio `run` / `activate` / `studio_run` consumer API, and the default Preset Registry does not automatically scan `StudioPackageStore`.

Therefore `transaction.status === complete` means:

> The Studio Package, compatible Runtime and standard host integration are installed, and Doctor has passed.

It does not mean every host has a universal launch prompt or one-click execution entry.

## Local diagnostics

Installation-experience events are written locally by default:

```text
~/.flowit-workflow/diagnostics/experience.jsonl
```

The Runtime applies a strict allowlist. Events may contain only the event type, time, Studio id/version, host id, duration and a bounded failure stage. They contain no prompts, user files, code, workspace paths, Session content or arbitrary metadata, and there is no automatic upload path.

`manual-action-required` is pending rather than successful. Only `complete` records Package and host installation success.

Read the local aggregate with:

```bash
flowit-studio experience-report
```
