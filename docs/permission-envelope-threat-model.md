# Permission envelope threat model

The permission-envelope contract defends against four primary failure modes:

1. **Model self-authorization:** requested capabilities are treated as untrusted intent until the MCP client returns an accepted elicitation response.
2. **Grant replay across tasks:** the signed grant binds the request ID, normalized full input, working directory, capability set, and generated sandbox envelope.
3. **Host policy drift:** Flowit verifies the policy reported by Codex and repeats the exact structured sandbox policy on every turn.
4. **Duplicate Session provisioning:** request-ID and provisioning state are persisted before the Host lifecycle crosses an uncertain boundary.

The contract does not claim to defend against a compromised operating system, compromised Codex executable, malicious user-approved Skills, or external services reached through an approved network connection. Those remain separate trust boundaries.
