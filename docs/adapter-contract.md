# AgentAdapter contract

`src/core/types.ts` is the stable host boundary.

An adapter is responsible for translating four host-specific operations into the Core model:

1. **Session discovery** — return stable session ids plus optional name/cwd/status.
2. **Dispatch** — accept a task, requested Skills, and Context Graph references; preserve the host's own permission model.
3. **Context projection** — translate context refs using a native reference mechanism when possible, otherwise use an explicitly bounded summary.
4. **Events** — map host lifecycle facts into normalized events. Replay-capable adapters should acknowledge events only after the listener settles.

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

## Adapter rules

- Do not copy host credentials into Flowit state.
- Do not treat cross-session text as permission/consent.
- Do not claim Skill binding succeeded unless the adapter can establish an execution boundary that fails closed when binding fails.
- Serialize concurrent dispatches to the same `(adapterId, sessionId)` in the Core dispatcher.
- A replayable event source should use stable event ids and durable acknowledgment/cursor semantics.
- Cross-adapter context must fail closed until an explicit Context Bridge exists; do not silently flatten foreign transcripts into prompts.

## Adding the next adapter

A future `GeminiCliAgentAdapter`, `OpenHandsAgentAdapter`, etc. should be added under `src/adapters/` and tested with a fake/Core integration test before adding host-specific UI or commands.
