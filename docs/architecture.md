# Architecture notes

## Design rule

Flowit Workflow stores orchestration references, not copied context. DSH remains authoritative for Sessions, Skills, permission policy, and model execution.

## Capability mapping

| Flowit semantic | DSH seam | This plugin |
| --- | --- | --- |
| Scheduled Task | Agent resume/followup + persistence | DurableScheduler |
| Listener/Pipeline | `session/event` + Agent resume/followup | PipelineRuntime |
| Skill binding | `ctx.skills.get()` + `renderSkillContent()` | DshTargetDispatcher |
| Drag/load context | `dsh-session:` canonical mention + session-reference | DshTargetDispatcher / future client UI |

## Why not copy Flowit Runtime

The original Flowit implementation includes Desktop-specific Runtime identity, SQLite tables, local server routes, and product UI contracts. DSH already owns equivalent lower-level primitives. Copying the Runtime would create two authorities for sessions, tools, skills, and execution.

This repository therefore preserves the higher-level semantics only: durable definition → resolve references at execution → dispatch through native Harness primitives.
