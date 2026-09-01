# Publishing and distributing a Flowit Studio

[Build with Flowit home](README.en.md) · [中文](publish.md) · [Package Spec](package-spec.en.md) · [Installation](install.en.md)

Publishing a Studio is not merely uploading a directory. Four facts must remain separate:

```text
what the Studio Package is
who the publisher is
what license the user owns
which channel delivered the Package
```

Flowit Studio Package is the application and trust format. SkillHub, GitHub, publisher websites, enterprise registries and local files are distribution channels.

## Basic publishing pipeline

```text
Studio source
      ↓
validate
      ↓
test
      ↓
pack
      ↓
completed Package Tree
      ↓
publisher signature / license policy
      ↓
channel packaging
      ↓
consumer-side Flowit installation revalidates everything
```

At minimum run:

```bash
flowit-studio validate ./my-studio
flowit-studio test ./my-studio
flowit-studio pack ./my-studio --out=./dist
```

`pack` produces a revalidated `.flowit` directory bundle. Do not modify the bundle after signing while continuing to use the old signature or digest. Publisher identity must bind to the final frozen Package Tree.

## Package, publisher, channel and license

These layers cannot substitute for one another:

| Layer | Question answered |
| --- | --- |
| Package identity | Which Studio, version and exact bytes did the user receive? |
| Publisher identity | Who is responsible for the Package? |
| Channel identity | Through which channel did the bytes arrive? |
| License entitlement | How is this user authorized to use it? |

For example:

```text
SkillHub authenticated the official Installer in its channel
≠ SkillHub automatically endorses a third-party publisher
≠ commercial Packages may bypass publisher-signature or trust requirements
≠ the user automatically owns a commercial license
```

Consumer installation still freezes the source, validates the complete tree, binds a digest and independently checks publisher trust and licensing.

## Open-source, freeware and commercial Studios

Manifest license types support different product models:

```text
open source
  code and content are distributed under an open-source license

freeware
  free to use, without automatically granting redistribution or modification rights

commercial
  usage is governed by the signed Package and local license entitlement
```

The license text, Manifest type, sales page and delivered terms must agree. Do not declare `freeware` while implying open-source redistribution rights, or claim cloud seat management for `commercial-*` unless such an online authority actually exists.

## Commercial signatures and offline licenses

Commercial Packages currently use Ed25519 signatures. The publisher signs the completed Package Tree; the receiving installation verifies it against a locally trusted publisher key.

Offline licenses support:

```text
personal
team
enterprise
```

Team seats are signed local entitlement information. Without a cloud authority, Flowit does not claim real-time cross-device seat consumption.

A signature answers “who published these bytes?” A license answers “what may this user do?” They are separate controls.

## SkillHub distribution

Generate a channel payload with:

```bash
flowit-studio skillhub ./my-studio --out=./dist
```

A third-party publisher payload is data-only:

```text
flowit-skillhub.json
studio/
  flowit.package.json
  presets/
  roles/
  ...
```

It does not contain:

```text
SKILL.md
install.mjs
bootstrap scripts
arbitrary executable installers
```

Automatic installation is owned by a separately published official CoaseEdge Installer whose publisher identity must be authenticated by the channel. A third-party payload cannot impersonate the official Installer or choose an arbitrary Runtime source.

## Other channels

The same `.flowit` Package may be delivered through:

```text
GitHub Releases
a publisher download site
an enterprise registry
controlled file sharing
a local directory
```

Regardless of channel, the consumer should enter the same Flowit installation transaction. A channel may provide discovery, download, payment and delivery, but it must not bypass:

```text
immutable snapshot
Package Tree fence
manifest / DSL validation
digest
publisher trust
signature / license
runtime compatibility
Host Setup / Doctor
```

## Pre-publish check

Before publishing, confirm that:

1. `flowit-studio validate` and `test` pass in a clean environment;
2. `flowit.package.json` accurately declares identity, publisher, version, hosts and runtime range;
3. the Package contains no escaping symlinks, temporary files, secrets, user data or unrelated build output;
4. prompts and Presets do not disguise publishing, deletion or production deployment as ordinary default steps;
5. the `.flowit` bundle does not change after final signing;
6. the channel page does not present future launch, marketplace or cloud-license capabilities as already delivered.

## Current commercial boundary

Available now:

```text
authoring
validation
testing
packing
signing
offline licensing
channel payloads
local installation and host readiness
```

Not yet a complete platform service:

```text
publisher console
Studio marketplace
payments, refunds and tax handling
automatic license issuance
cloud seat management
universal installed-Studio launch entry
```

“Can be sold” currently means that a publisher may sell the Package and license through its own commercial and delivery system. Flowit provides the local Package, trust and license foundation, but not yet a complete marketplace transaction platform.
