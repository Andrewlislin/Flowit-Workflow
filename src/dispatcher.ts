import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { AutomationTarget, SessionContextRef } from './types.js'

export interface DispatchResult {
  sessionId: string
  loadedSkills: string[]
  referencedSessions: string[]
}

export class DshTargetDispatcher {
  private readonly sessionTails = new Map<string, Promise<void>>()

  constructor(private readonly ctx: Context) {}

  dispatch(target: AutomationTarget, extraRefs: readonly SessionContextRef[] = [], signal?: AbortSignal): Promise<DispatchResult> {
    return this.serializeTarget(target.sessionId, () => this.dispatchOne(target, extraRefs, signal))
  }

  private async dispatchOne(target: AutomationTarget, extraRefs: readonly SessionContextRef[], signal?: AbortSignal): Promise<DispatchResult> {
    signal?.throwIfAborted()
    const acquired = await this.acquire(target.sessionId, signal)
    const agent = acquired.agent
    try {
      const loadedSkills = await this.injectSkills(agent, target.skills, signal)
      const refs = uniqueRefs([...target.contextRefs, ...extraRefs]).filter(ref => ref.sessionId !== target.sessionId)
      const mentionText = refs.map(ref => formatSessionReferenceMention({
        sessionId: SessionId(ref.sessionId),
        label: ref.label ?? ref.sessionId,
      })).join('\n')
      const prompt = mentionText.length > 0
        ? `${target.prompt}\n\nUse these referenced sessions as read-only background context:\n${mentionText}`
        : target.prompt
      agent.followup(createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: prompt }],
      }))
      await agent.whenIdle()
      signal?.throwIfAborted()
      return {
        sessionId: target.sessionId,
        loadedSkills,
        referencedSessions: refs.map(ref => ref.sessionId),
      }
    } finally {
      if (acquired.handle) await acquired.handle.dispose()
    }
  }

  private async serializeTarget<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.then(() => undefined, () => undefined)
    this.sessionTails.set(sessionId, tail)
    try {
      return await current
    } finally {
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId)
    }
  }

  private async injectSkills(agent: Agent, skillNames: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const loaded: string[] = []
    for (const name of [...new Set(skillNames)]) {
      signal?.throwIfAborted()
      const skill = await this.ctx.skills.get(name, {
        cwd: agent.session.header.cwd,
        scope: agent,
        signal,
      })
      if (!skill) throw new Error(`skill ${JSON.stringify(name)} is unavailable in session ${agent.id}`)
      if (!isModelInvocable(skill)) throw new Error(`skill ${JSON.stringify(name)} is not model-invocable`)
      agent.inject(createUserMessage({
        source: { kind: 'plugin', plugin: 'flowit-workflow' },
        content: [{ type: 'text', text: renderSkillContent(skill) }],
      }))
      loaded.push(name)
    }
    return loaded
  }

  private async acquire(sessionId: string, signal?: AbortSignal): Promise<{ agent: Agent; handle?: AgentHandle }> {
    const id = SessionId(sessionId)
    const live = this.ctx.agents.get(id)
    if (live) return { agent: live }
    const handle = await this.ctx.agents.resume({ resumeSessionId: id, signal })
    return { agent: handle.agent, handle }
  }
}

function uniqueRefs(refs: readonly SessionContextRef[]): SessionContextRef[] {
  const seen = new Set<string>()
  return refs.filter(ref => {
    if (seen.has(ref.sessionId)) return false
    seen.add(ref.sessionId)
    return true
  })
}
