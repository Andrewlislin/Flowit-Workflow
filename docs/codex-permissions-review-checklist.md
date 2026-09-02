# Codex permission-envelope review checklist

Use this checklist when reviewing changes to explicit Flowit run permissions.

- Capability input is limited to `workspace-read`, `workspace-write`, and `network`.
- Raw sandbox, approval-policy, writable-root, and grant fields remain rejected.
- Sensitive permission approval happens before Adapter startup or durable mutation.
- The elicitation text includes the workflow, directory, requested capabilities, model/effort, Skills, stage count, and exact input/envelope digest.
- Decline, cancel, timeout, and missing elicitation support leave no Session, provisioning intent, or Run.
- The signed grant binds request ID, normalized input, directory, capabilities, envelope, and expiry.
- Request-ID replay reuses the existing grant and does not prompt or provision twice.
- A request-ID conflict cannot change the directory, steps, goal, Skills, model, or permissions.
- `thread/start` and `thread/resume` receive only stable lifecycle fields: `read-only` or `workspace-write`, `approvalPolicy: never`, and workspace-write config where applicable.
- Lifecycle verification never accepts a policy broader than the grant; `workspaceWrite` remains exact.
- An approved network-enabled read-only run may bootstrap as the stable offline `readOnly` lifecycle, but no task work begins before `turn/start`.
- Every `turn/start` repeats the exact approved structured sandbox policy, including `readOnly(networkAccess=true)`.
- The pinned Codex v0.152.0 schema fixture and outbound-request regression remain in sync.
- Workspace-write roots contain only the normalized dedicated working directory.
- `danger-full-access`, browser authorization, arbitrary roots, and automatic approval escalation remain impossible.
- Host-returned lifecycle sandbox and approval evidence is checked before Run admission without demanding a state the lifecycle request cannot express.
- A newly created Session is archived if Host policy verification fails.
- Permission evidence survives in the provisioned Session and node checkpoints.
- Ordinary dispatch to a historical Session cannot borrow a run-scoped execution grant.
- New App Server approval requests remain fail-closed during unattended execution.
