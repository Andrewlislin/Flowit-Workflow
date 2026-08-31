# AgentAdapter contract

`packages/core/src/core/types.ts` is the host boundary. The root `src/core/*` files are compatibility re-exports only.

An adapter translates host-specific lifecycle and execution into the Core model:

1. **Startup (optional)** — `start(signal)` performs host connection/auth/process preflight when the adapter requires it. It must observe `AbortSignal` where the host API permits cancellation and must not mark itself ready before required host resources are usable.
2. **Session discovery** — return stable session ids plus optional name/cwd/status.
3. **Execution preflight (optional)** — validate runtime, permissions, Skills and Session ownership without creating user-visible or durable Host resources.
4. **Session provisioning (optional)** — after the reviewed proposal is confirmed, create a dedicated Session and return its actual runtime evidence.
5. **Dispatch** — accept a task, requested Skills, runtime requirements and Context Graph references while preserving the host's permission model.
6. **Context projection** — resolve a native reference when possible, otherwise use an explicitly bounded summary.
7. **Events** — map host lifecycle facts into normalized events with stable identity.

```ts
interface AgentAdapter {
  readonly id: string
  readonly capabilities: AgentAdapterCapabilities
  start?(signal?: AbortSignal): Promise<void> | void
  listSessions(query?: string, signal?: AbortSignal): Promise<AgentSessionDescriptor[]>
  preflightExecution?(
    request: AgentExecutionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<AgentExecutionPreflightResult>
  provisionSession?(
    request: AgentExecutionPreflightRequest,
    signal?: AbortSignal,
  ): Promise<ProvisionedAgentSession>
  releaseSession?(
    session: ProvisionedAgentSession,
    signal?: AbortSignal,
  ): Promise<void>
  dispatch(request: AgentDispatchRequest, signal?: AbortSignal): Promise<AgentDispatchResult>
  subscribe?(listener: (event: AgentEvent) => Promise<void> | void): () => void
  dispose?(): Promise<void> | void
}
```

Lifecycle state is per registered Adapter **instance/generation**, not only per string ID. Unregistering an Adapter aborts its generation; another instance with the same ID must start independently. Control-plane host operations lazily start the selected Adapter before use.

Capability flags are descriptive and must stay truthful:

```ts
interface AgentAdapterCapabilities {
  coldResume: boolean
  liveDispatch: boolean
  skillBinding: boolean
  contextReference: 'native' | 'summary' | 'none'
  eventSubscription: boolean
  executionPreflight?: boolean
  sessionProvisioning?: 'none' | 'dedicated' | 'pool'
  runtimeSelection?: 'none' | 'session' | 'turn'
  runtimeIntrospection?: boolean
  lockInspection?: boolean
}
```

## Execution preflight contract

`preflightExecution()` is a read-only capability probe. It may connect to the Host, inspect model catalogs, read Session state, validate Skills and inspect permission profiles, but it must not create a new Session, start a turn, mutate the Workflow Store or perform task side effects.

The request separates the Session plan from the final concrete target:

```ts
type AgentSessionPlan =
  | { kind: 'existing'; sessionId: string }
  | { kind: 'dedicated'; cwd: string }
```

A dedicated plan has no Session id before confirmation. `workflow_prepare` hashes the plan, requested model/reasoning policy, capabilities and preflight evidence into the proposal. `workflow_commit` repeats the preflight; only then may it call `provisionSession()` and materialize the returned Session id into the durable run snapshot.

Runtime matching is explicit:

- `inherit` uses the Host/Session runtime and cannot carry a model or reasoning override.
- `exact` must name a model and/or reasoning effort and fails closed unless the Adapter verifies it.
- `preferred` must name a preferred model and/or reasoning effort; a verified Host substitute is permitted and recorded as evidence.

Adapters must return structured blockers such as `MODEL_UNAVAILABLE`, `SESSION_BUSY`, `SESSION_WRITER_LOCKED`, `PERMISSION_UNAVAILABLE`, `HOST_UNAVAILABLE` or `HOST_VERSION_INCOMPATIBLE`. `HOST_UNAVAILABLE` is retryable and covers transient timeout, disconnect, broken-pipe and App Server exit conditions; `HOST_VERSION_INCOMPATIBLE` is reserved for deterministic method, protocol or schema incompatibility. Do not turn every preflight failure into an unclassified string. The Core dispatcher enforces this contract for direct dispatch, persistent Pipelines, Schedules and run-once recovery: exact/preferred runtime or required-capability targets cannot reach `dispatch()` unless the Adapter advertises and passes `preflightExecution()` immediately before execution. Deterministic execution-contract violations use `AgentExecutionError`; errors with `retryable=false` are dead-lettered on the current attempt rather than replaying forbidden substitute execution.

Provisioning is a mutation and therefore occurs only after the proposal confirmation boundary. A managed Session that was created but not durably admitted should be released or archived on a best-effort compensation path. Once admitted, its stable Session id belongs to the run snapshot so retries do not silently switch execution environments.

Host-native authorization remains authoritative. Preflight evidence is not permission, and Flowit must not convert an exact runtime request into authority to grant broader filesystem, command, network or browser access.

## Event acknowledgement contract

An Adapter event listener settling means **Flowit has durably admitted the event for every matching Pipeline**, not that the Pipeline business work has completed.

```text
Adapter event
   ↓
Core listener
   ↓
Store eventInbox transaction for all matching Pipelines
   ↓
listener resolves
   ↓
Pipeline workers execute asynchronously
```

Adapters that can replay/cursor their own source should advance host acknowledgement only after the listener resolves. Sources without replay still benefit from Flowit's durable admission for events already delivered into the listener.

## Adapter rules

- Do not copy host credentials into Flowit state.
- Do not treat cross-session text as permission or consent.
- Do not claim Skill binding succeeded unless the execution boundary fails closed when requested binding is unavailable.
- Do not claim an exact model or reasoning effort unless the Host execution response verifies it; catalog evidence only proves availability, not what the Host actually selected.
- Treat Host runtime-reroute notifications as execution evidence. Exact contracts fail if a turn is rerouted away from the requested model; preferred/inherit contracts record the final routed model.
- Keep execution preflight read-only; resource creation belongs after confirmation.
- Serialize concurrent dispatches to the same `(adapterId, sessionId)` in the Core dispatcher. Runtime-specific Adapter clients must not terminate work or event subscriptions owned by other Sessions.
- Use stable host event IDs; never synthesize replay identity from wall-clock receipt time.
- Cross-adapter context fails closed until an explicit provenance-carrying Context Bridge exists.
- Startup/disposal must be cancel-safe. If an Adapter owns a child process, startup cancellation or disposal must terminate/reject outstanding host work rather than leave an invisible background process.
- Do not claim generic exactly-once side effects. Correlation/idempotency/fencing keys should be propagated to host-native mechanisms when available.

## Adding the next adapter

A future `GeminiCliAgentAdapter`, `OpenHandsAgentAdapter`, etc. should be added as a dedicated `packages/adapter-*/` workspace package with:

- a pinned host contract test;
- lifecycle cancellation coverage when startup owns resources;
- event identity/reconnect behavior documented;
- capability flags that reflect the actual host API, not product UI affordances;
- preflight/provisioning tests when the Adapter advertises those optional capabilities.


## Durable schema fence

Execution requirements are a durability invariant, not an ignorable extension. Workflow State version 2 fences execution-aware snapshots from older workers: a version 1 reader must reject the database rather than run a target after dropping its runtime or capability requirements. Dedicated Host provisioning is journaled before the Host mutation so crash recovery never starts a second Session for the same confirmed proposal without reconciliation.
