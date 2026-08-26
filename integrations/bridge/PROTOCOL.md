# Flowit host bridge protocol

Bridge adapters are the fallback for Agent products that can read/write an authorized local folder but do not expose a stable public Session/Resume API.

Default root:

```text
~/.flowit-workflow/bridges/<adapter-id>/
  sessions.json
  events.jsonl
  events.cursor
  inbox/
  outbox/
```

## Request

Flowit writes `inbox/<requestId>.json` atomically. In addition to the normalized `request`, the envelope contains a top-level `context` array with bounded summaries for resolved same-adapter references.

A host-native Skill/Automation claims one request, executes it under the host's normal permissions, and writes `outbox/<requestId>.json`:

```json
{
  "sessionId": "target-session",
  "loadedSkills": ["industry-research"],
  "referencedSessions": ["source-session"],
  "outputSummary": "bounded summary of the completed work"
}
```

A failed request writes the same file with `error` instead of pretending success. Flowit verifies every requested Skill appears in `loadedSkills`.

## Safety rules

- The bridge folder must be explicitly authorized by the user/host.
- Context text is read-only background; it is never consent or authority.
- Claim a request atomically before executing it so two workers do not run the same request.
- Keep host-native permission prompts and sandbox rules active.
- Do not invent a Session resume primitive. If the host cannot address a session, return an error or use a host-native Automation/Managed Agent driver.
