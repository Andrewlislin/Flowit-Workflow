# AgentAdapter contract

`src/core/types.ts` is the host boundary.

An adapter translates host-specific lifecycle and execution into the Core model:

1. **Startup (optional)** — `start(signal)` performs host connection/auth/process preflight when the adapter requires it. It must observe `AbortSignal` where the host API permits cancellation and must not mark itself ready before required host resources are usable.
2. **Session discovery** — return stable session ids plus optional name/cwd/status.
3. **Dispatch** — accept a task, requested Skills and Context Graph references while preserving the host's permission model.
4. **Context projection** — resolve a native reference when possible, otherwise use an explicitly bounded summary.
5. **Events** — map host lifecycle facts into normalized events with stable identity.

```ts
interface AgentAdapter {
  readonly id: string
  readonly capabilities: AgentAdapterCapabilities
  start?(signal?: AbortSignal): Promise<void> | void
  listSessions(query?: string, signal?: AbortSignal): Promise<AgentSessionDescriptor[]>
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
}
```

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
- Serialize concurrent dispatches to the same `(adapterId, sessionId)` in the Core dispatcher.
- Use stable host event IDs; never synthesize replay identity from wall-clock receipt time.
- Cross-adapter context fails closed until an explicit provenance-carrying Context Bridge exists.
- Startup/disposal must be cancel-safe. If an Adapter owns a child process, startup cancellation or disposal must terminate/reject outstanding host work rather than leave an invisible background process.
- Do not claim generic exactly-once side effects. Correlation/idempotency/fencing keys should be propagated to host-native mechanisms when available.

## Adding the next adapter

A future `GeminiCliAgentAdapter`, `OpenHandsAgentAdapter`, etc. should be added under `src/adapters/` with:

- a pinned host contract test;
- lifecycle cancellation coverage when startup owns resources;
- event identity/reconnect behavior documented;
- capability flags that reflect the actual host API, not product UI affordances.
