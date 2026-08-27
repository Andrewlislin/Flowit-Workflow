# Dependency supply-chain policy

Flowit Workflow uses package-registry dependencies for release manifests and records their exact resolution in `pnpm-lock.yaml`.

## OpenCode remediation

The OpenCode adapter previously used an internal vendored tarball from a commit-pinned GitHub raw URL. That artifact was content-addressed by the upstream commit, but it bypassed normal npm-registry metadata, integrity and dependency-audit workflows and was not an intended third-party distribution channel.

Flowit now uses the public `@opencode-ai/sdk` package, pinned to the exact reviewed version `1.18.23`, and integrates through its exported V2 API. CI rejects direct HTTP(S), Git, local-file and tarball dependency specifiers and verifies the committed lockfile with a frozen install.
