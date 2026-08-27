# Security

## Dependency sources

Flowit Workflow release manifests accept registry/version dependency specifiers only. Direct HTTP(S) tarballs, Git dependencies, and local file/link dependencies are rejected by `pnpm check:supply-chain` and CI.

The OpenCode integration uses the public npm package `@opencode-ai/sdk` at an exact reviewed version. Dependency resolution is captured in `pnpm-lock.yaml` and release CI requires a frozen install.

## Reporting vulnerabilities

Please use GitHub's private vulnerability reporting feature when available, or contact the repository maintainers privately before publishing details of an unpatched vulnerability.
