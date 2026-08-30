import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import type {
  AgentAdapter,
  AgentDispatchRequest,
  AgentDispatchResult,
  AgentEvent,
  AgentSessionDescriptor,
} from '@coaseedgeltd/flowit-core'

export const DSH_ADAPTER_ID = 'deepseek-harness'

interface PreparedSkill {
  name: string
  message: UserMessage
}

interface OwnedTurnTracker {
  markQueued(): void
  rollback(): void
  wait(): Promise<void>
  dispose(): void
}

export class DshAgentAdapter implements AgentAdapter {
  readonly id = DSH_ADAPTER_ID
  readonly capabilities = {
    coldResume: true,
    liveDispatch: false,
    skillBinding: true,
    contextReference: 'native' as const,
    eventSubscription: true,
  }

  constructor(private readonly ctx: Context) {}

  async listSessions(query = ''): Promise<AgentSessionDescriptor[]> {
    const needle = query.trim().toLocaleLowerCase()
    return this.ctx.agents
      .roots()
      .map(agent => ({
        adapterId: this.id,
        sessionId: String(agent.id),
        ...(agent.session.header.cwd ? { cwd: agent.session.header.cwd } : {}),
        status: agent.status === 'running' ? ('live' as const) : ('idle' as const),
      }))
      .filter(
        session =>
          !needle ||
          session.sessionId.toLocaleLowerCase().includes(needle) ||
          session.cwd?.toLocaleLowerCase().includes(needle) === true,
      )
  }

  async dispatch(
    request: AgentDispatchRequest,
    signal?: AbortSignal,
  ): Promise<AgentDispatchResult> {
    signal?.throwIfAborted()
    for (const ref of request.contextRefs) {
      if (ref.adapterId !== this.id)
        throw new Error(`DSH adapter cannot natively reference context from adapter ${ref.adapterId}`)
    }

    const acquired = await this.acquire(request.sessionId, signal)
    const agent = acquired.agent
    try {
      if (agent.status === 'running') throw alreadyRunning(request.sessionId)

      // Skill loading may await providers. It must not mutate the Agent before
      // the final host-native idle reservation has been acquired.
      const preparedSkills = await this.prepareSkills(agent, request.skills, signal)
      const mentionText = request.contextRefs
        .map(ref =>
          formatSessionReferenceMention({
            sessionId: SessionId(ref.sessionId),
            label: ref.label ?? ref.sessionId,
          }),
        )
        .join('\n')
      const prompt =
        mentionText.length > 0
          ? `${request.prompt}\n\nUse these referenced sessions as read-only background context:\n${mentionText}`
          : request.prompt
      const promptMessage = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: prompt }],
      })
      const tracker = this.trackOwnedTurn(
        agent,
        promptMessage,
        preparedSkills.map(skill => skill.message),
        request.sessionId,
        signal,
      )

      try {
        let admission: Promise<void>
        try {
          admission = agent.runMaintenance(maintenanceSignal => {
            const workSignal = signal
              ? AbortSignal.any([maintenanceSignal, signal])
              : maintenanceSignal
            workSignal.throwIfAborted()
            if (agent.inbox.hasPending) {
              throw new Error(
                `DSH session ${request.sessionId} has pending host work; Flowit refuses dispatch because it cannot claim an exclusive turn boundary`,
              )
            }

            try {
              // This callback performs no await. runMaintenance owns the true
              // idle phase while the identified prompt and Skill context are
              // admitted as one turn boundary.
              agent.followup(promptMessage)
              for (const skill of preparedSkills) agent.inject(skill.message)
              assertOwnedAdmission(
                agent,
                promptMessage,
                preparedSkills.map(skill => skill.message),
                request.sessionId,
              )
              tracker.markQueued()
              workSignal.throwIfAborted()
              return Promise.resolve()
            } catch (error: unknown) {
              tracker.rollback()
              throw error
            }
          })
        } catch (error: unknown) {
          throw alreadyRunning(request.sessionId, error)
        }

        await admission
        await tracker.wait()
        signal?.throwIfAborted()
        return {
          sessionId: request.sessionId,
          loadedSkills: preparedSkills.map(skill => skill.name),
          referencedSessions: request.contextRefs.map(ref => ref.sessionId),
        }
      } finally {
        tracker.dispose()
      }
    } finally {
      if (acquired.handle) {
        try {
          // A resumed handle is an ownership capability. Do not dispose it
          // while later host work is active, because disposal would cancel
          // work that Flowit does not own.
          await agent.whenIdle()
        } finally {
          await acquired.handle.dispose()
        }
      }
    }
  }

  subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
    return this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const kind = event.data.reason.kind === 'completed' ? 'turn_completed' : 'turn_failed'
      void Promise.resolve(
        listener({
          adapterId: this.id,
          sessionId: String(session.header.id),
          kind,
          eventId: `${String(session.header.id)}:turn:${event.data.turn}:${kind}`,
          at: new Date().toISOString(),
        }),
      ).catch(() => undefined)
    })
  }

  private async prepareSkills(
    agent: Agent,
    skillNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<PreparedSkill[]> {
    const prepared: PreparedSkill[] = []
    for (const name of skillNames) {
      signal?.throwIfAborted()
      const skill = await this.ctx.skills.get(name, {
        cwd: agent.session.header.cwd,
        scope: agent,
        signal,
      })
      if (!skill) throw new Error(`skill ${JSON.stringify(name)} is unavailable in session ${agent.id}`)
      if (!isModelInvocable(skill))
        throw new Error(`skill ${JSON.stringify(name)} is not model-invocable`)
      prepared.push({
        name,
        message: createUserMessage({
          source: { kind: 'plugin', plugin: 'flowit-workflow' },
          content: [{ type: 'text', text: renderSkillContent(skill) }],
        }),
      })
    }
    return prepared
  }

  private trackOwnedTurn(
    agent: Agent,
    promptMessage: UserMessage,
    relatedMessages: readonly UserMessage[],
    sessionId: string,
    signal?: AbortSignal,
  ): OwnedTurnTracker {
    const ownedMessageIds = new Set([promptMessage.id, ...relatedMessages.map(message => message.id)])
    let queued = false
    let ownedTurn: number | undefined
    let ended = false
    let settled = false
    let removingOwned = false
    let ownershipViolation: Error | undefined
    const completion = deferred<void>()

    const resolveOnce = (): void => {
      if (settled) return
      settled = true
      completion.resolve()
    }
    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      completion.reject(error)
    }
    const abortError = (): Error =>
      signal?.reason instanceof Error ? signal.reason : new Error('DSH dispatch aborted')
    const removeOwnedPending = (): number => {
      removingOwned = true
      let removed = 0
      try {
        for (const messageId of ownedMessageIds) {
          try {
            if (agent.inbox.remove(messageId)) removed += 1
          } catch {}
        }
      } finally {
        removingOwned = false
      }
      return removed
    }
    const recordViolation = (message: string): void => {
      ownershipViolation ??= new Error(message)
      if (ownedTurn === undefined) {
        removeOwnedPending()
        rejectOnce(ownershipViolation)
      }
    }
    const settleEndedTurn = (): void => {
      ended = true
      if (ownershipViolation) rejectOnce(ownershipViolation)
      else resolveOnce()
    }
    const cancelOwnedTurn = (): void => {
      if (ownedTurn === undefined || ended || settled || ownershipViolation) return
      if (turnHasEnded(agent, ownedTurn)) {
        settleEndedTurn()
        return
      }
      try {
        agent.cancel({ kind: 'parent' }, { keepInbox: true })
      } catch (error: unknown) {
        rejectOnce(error)
      }
    }
    const abort = (): void => {
      if (!queued || ended || settled) return
      if (ownedTurn === undefined) {
        removeOwnedPending()
        rejectOnce(abortError())
        return
      }
      cancelOwnedTurn()
    }

    const stopClaim = this.ctx.on('agent/inbox/claimed', payload => {
      if (payload.agent !== agent || payload.message.id !== promptMessage.id) return
      ownedTurn = payload.turn
      if (signal?.aborted) abort()
    })
    const stopInserted = this.ctx.on('agent/inbox/inserted', payload => {
      if (payload.agent !== agent || ownedMessageIds.has(payload.message.id) || !queued || ended)
        return
      const insertedIntoNextStep = agent.inbox.nextStep.some(
        message => message.id === payload.message.id,
      )
      if (ownedTurn !== undefined) {
        if (insertedIntoNextStep) {
          recordViolation(
            `DSH session ${sessionId} received unrelated host steering inside the Flowit-owned turn; Flowit will not cancel the mixed-ownership turn`,
          )
        }
        return
      }
      if (insertedIntoNextStep || agent.inbox.nextTurn[0]?.id !== promptMessage.id) {
        recordViolation(
          `DSH session ${sessionId} changed before the Flowit prompt claimed its turn; dispatch was not started`,
        )
      }
    })
    const stopDiscarded = this.ctx.on('agent/inbox/discarded', payload => {
      if (
        payload.agent !== agent ||
        !queued ||
        ended ||
        ownedTurn !== undefined ||
        removingOwned ||
        !ownedMessageIds.has(payload.message.id)
      ) {
        return
      }
      recordViolation(
        `DSH session ${sessionId} discarded Flowit-owned input before its turn was claimed`,
      )
    })
    const stopEvent = this.ctx.on('session/event', (session, event) => {
      if (
        session !== agent.session ||
        event.type !== 'turn/end' ||
        event.data.turn !== ownedTurn
      ) {
        return
      }
      settleEndedTurn()
    })
    const stopDisposed = this.ctx.on('agent/disposed', payload => {
      if (payload.agent !== agent || ended) return
      rejectOnce(new Error(`DSH session ${agent.id} was disposed before the Flowit turn ended`))
    })

    if (signal) {
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    }

    return {
      markQueued(): void {
        queued = true
        if (signal?.aborted) abort()
      },
      rollback(): void {
        removeOwnedPending()
      },
      wait(): Promise<void> {
        return completion.promise
      },
      dispose(): void {
        stopClaim()
        stopInserted()
        stopDiscarded()
        stopEvent()
        stopDisposed()
        if (signal) signal.removeEventListener('abort', abort)
      },
    }
  }

  private async acquire(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ agent: Agent; handle?: AgentHandle }> {
    const id = SessionId(sessionId)
    const live = this.ctx.agents.get(id)
    if (live) return { agent: live }
    const handle = await this.ctx.agents.resume({
      resumeSessionId: id,
      ...(signal ? { signal } : {}),
    })
    return { agent: handle.agent, handle }
  }
}

function assertOwnedAdmission(
  agent: Agent,
  promptMessage: UserMessage,
  relatedMessages: readonly UserMessage[],
  sessionId: string,
): void {
  const relatedIds = new Set(relatedMessages.map(message => message.id))
  if (
    agent.inbox.nextTurn.length !== 1 ||
    agent.inbox.nextTurn[0]?.id !== promptMessage.id ||
    agent.inbox.nextStep.length !== relatedIds.size ||
    agent.inbox.nextStep.some(message => !relatedIds.has(message.id))
  ) {
    throw new Error(
      `DSH session ${sessionId} changed while Flowit held the admission reservation; dispatch was not started`,
    )
  }
}

function alreadyRunning(sessionId: string, cause?: unknown): Error {
  const message = `DSH session ${sessionId} is already running; Flowit refuses concurrent dispatch so cancellation cannot interrupt unrelated host work`
  return cause === undefined ? new Error(message) : new Error(message, { cause })
}

function turnHasEnded(agent: Agent, turn: number): boolean {
  return agent.session.events.some(
    event => event.type === 'turn/end' && event.data.turn === turn,
  )
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value?: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise as (value?: T | PromiseLike<T>) => void
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
