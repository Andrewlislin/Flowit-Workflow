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
- `thread/start` receives only `read-only` or `workspace-write`, with `approvalPolicy: never`.
- Every `turn/start` repeats the exact approved structured sandbox policy.
- Workspace-write roots contain only the normalized dedicated working directory.
- `danger-full-access`, browser authorization, arbitrary roots, and automatic approval escalation remain impossible.
- Host-returned sandbox and approval evidence is checked before Run admission.
- A newly created Session is archived if Host policy verification fails.
- Permission evidence survives in the provisioned Session and node checkpoints.
- Ordinary dispatch to a historical Session cannot borrow a run-scoped execution grant.
- New App Server approval requests remain fail-closed during unattended execution.
