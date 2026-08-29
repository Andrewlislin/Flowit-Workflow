import type {
  ResolvedTaskAssessmentSignals,
  RoutingQuestion,
  SideEffectRisk,
  SignalLevel,
  TaskAssessmentResult,
  TaskKind,
  TrustedTaskAssessmentInput,
} from './types.js'

export const ADAPTIVE_ROUTING_POLICY_VERSION = 'adaptive-routing-mvp-v2' as const

const TASK_KIND_VALUES = new Set<TaskKind>(['general', 'research', 'coding', 'content'])
const SIDE_EFFECT_VALUES = new Set<SideEffectRisk>(['none', 'reversible', 'irreversible'])
const RISK_RANK: Readonly<Record<SideEffectRisk, number>> = {
  none: 0,
  reversible: 1,
  irreversible: 2,
}

export function assessTask(input: TrustedTaskAssessmentInput): TaskAssessmentResult {
  const task = requiredString(input.task, 'task')
  const mode = routingMode(input.mode)
  const explicitIntent = routingExplicitIntent(input.explicitIntent)
  if (typeof input.trustedAuthority !== 'boolean') {
    throw new Error('trustedAuthority must be a boolean')
  }
  const inferred = inferSignals(task)
  const signals = resolveSignals(input.signals ?? {}, inferred)
  const confidence = inferConfidence(task, signals)
  const reasons: string[] = []
  let score = 0

  if (signals.repeatable) {
    score += 3
    reasons.push('The task appears recurring or trigger-driven, so durable orchestration has material value.')
  }
  if (signals.distinctStages >= 3) {
    score += 2
    reasons.push(`The task has about ${signals.distinctStages} distinct stages.`)
  }
  if (signals.distinctStages >= 5) score += 1
  if (signals.decomposability >= 2) {
    score += signals.decomposability === 3 ? 2 : 1
    reasons.push('The task can be separated into stages with useful intermediate outputs.')
  }
  if (signals.durabilityNeed > 0) {
    score += Math.min(2, signals.durabilityNeed)
    reasons.push('Checkpointing or recovery would reduce the cost of interruption.')
  }
  if (signals.reviewNeed > 0) {
    score += Math.min(2, signals.reviewNeed)
    reasons.push('The task benefits from an independent verification stage.')
  }
  if (signals.requiresResearch && signals.distinctStages >= 2) {
    score += 1
    reasons.push('Research evidence must feed a downstream deliverable.')
  }
  if (signals.crossSessionNeed || signals.crossAdapterNeed) {
    score += 2
    reasons.push('The task requests work across more than one Session or Host.')
  }
  if (signals.coupling >= 2) {
    const penalty = signals.coupling === 3 ? 3 : 2
    score -= penalty
    reasons.push('The stages are tightly coupled, which reduces the benefit of a Pipeline boundary.')
  }
  score = Math.max(0, score)

  const hardChoiceRequired =
    signals.sideEffectRisk === 'irreversible' ||
    signals.ambiguity >= 2 ||
    signals.crossSessionNeed ||
    signals.crossAdapterNeed

  let decision: TaskAssessmentResult['decision']
  if (explicitIntent === 'force-direct') {
    decision = 'direct'
    reasons.unshift('Trusted top-level routing authority explicitly disables Flowit orchestration.')
  } else if (hardChoiceRequired) {
    decision = 'ask'
  } else if (explicitIntent === 'force-flowit' || explicitIntent === 'preview') {
    decision = 'pipeline'
    reasons.unshift(
      explicitIntent === 'preview'
        ? 'Trusted top-level routing authority requests a Flowit proposal preview.'
        : 'Trusted top-level routing authority explicitly requests Flowit orchestration.',
    )
  } else if (mode === 'manual') {
    decision = 'direct'
    reasons.unshift('Routing mode is manual and no trusted top-level authority requested Flowit.')
  } else if (score <= 2) {
    decision = 'direct'
  } else if (score <= 5 || confidence < 0.75) {
    decision = 'ask'
  } else {
    decision = 'pipeline'
  }

  if (signals.sideEffectRisk === 'irreversible') {
    reasons.push('Irreversible external side effects cannot be auto-routed by the MVP.')
  }
  if (signals.ambiguity >= 2) {
    reasons.push('The desired deliverable or constraints are too ambiguous for automatic decomposition.')
  }
  if (signals.crossSessionNeed || signals.crossAdapterNeed) {
    reasons.push('The MVP supports one confirmed Session on one Adapter only.')
  }
  if (confidence < 0.75 && score >= 3) {
    reasons.push('Assessment confidence is below the automatic routing threshold.')
  }
  if (mode === 'auto-safe' && !input.trustedAuthority) {
    reasons.push('Auto-safe execution is disabled without host-issued top-level routing authority.')
  }
  if (reasons.length === 0) {
    reasons.push(
      decision === 'direct'
        ? 'The task is bounded enough for the current Agent to complete directly.'
        : 'The task has enough independent stages to justify a Flowit Pipeline.',
    )
  }

  const autoExecuteAllowed =
    decision === 'pipeline' &&
    mode === 'auto-safe' &&
    input.trustedAuthority &&
    explicitIntent !== 'preview' &&
    confidence >= 0.8 &&
    signals.sideEffectRisk === 'none' &&
    signals.ambiguity <= 1 &&
    !signals.crossSessionNeed &&
    !signals.crossAdapterNeed

  return {
    kind: 'task-assessment',
    version: 1,
    policyVersion: ADAPTIVE_ROUTING_POLICY_VERSION,
    task,
    mode,
    explicitIntent,
    authorityTrusted: input.trustedAuthority,
    decision,
    score,
    confidence,
    signals,
    reasons,
    autoExecuteAllowed,
    ...(decision === 'ask' ? { question: routingQuestion(score) } : {}),
  }
}

function resolveSignals(
  supplied: TrustedTaskAssessmentInput['signals'],
  inferred: ResolvedTaskAssessmentSignals,
): ResolvedTaskAssessmentSignals {
  const input = supplied ?? {}
  const suppliedRisk = optionalEnum(
    input.sideEffectRisk,
    SIDE_EFFECT_VALUES,
    'signals.sideEffectRisk',
  )
  return {
    taskKind: optionalEnum(input.taskKind, TASK_KIND_VALUES, 'signals.taskKind') ?? inferred.taskKind,
    distinctStages: Math.max(
      optionalPositiveInteger(input.distinctStages, 'signals.distinctStages') ?? 1,
      inferred.distinctStages,
    ),
    decomposability: maximumSignal(
      optionalSignal(input.decomposability, 'signals.decomposability'),
      inferred.decomposability,
    ),
    coupling: maximumSignal(
      optionalSignal(input.coupling, 'signals.coupling'),
      inferred.coupling,
    ),
    durabilityNeed: maximumSignal(
      optionalSignal(input.durabilityNeed, 'signals.durabilityNeed'),
      inferred.durabilityNeed,
    ),
    reviewNeed: maximumSignal(
      optionalSignal(input.reviewNeed, 'signals.reviewNeed'),
      inferred.reviewNeed,
    ),
    requiresResearch:
      (optionalBoolean(input.requiresResearch, 'signals.requiresResearch') ?? false) ||
      inferred.requiresResearch,
    repeatable:
      (optionalBoolean(input.repeatable, 'signals.repeatable') ?? false) || inferred.repeatable,
    crossSessionNeed:
      (optionalBoolean(input.crossSessionNeed, 'signals.crossSessionNeed') ?? false) ||
      inferred.crossSessionNeed,
    crossAdapterNeed:
      (optionalBoolean(input.crossAdapterNeed, 'signals.crossAdapterNeed') ?? false) ||
      inferred.crossAdapterNeed,
    sideEffectRisk: maximumRisk(suppliedRisk, inferred.sideEffectRisk),
    ambiguity: maximumSignal(
      optionalSignal(input.ambiguity, 'signals.ambiguity'),
      inferred.ambiguity,
    ),
  }
}

function inferSignals(task: string): ResolvedTaskAssessmentSignals {
  const taskKind = inferTaskKind(task)
  const repeatable = /(?:每天|每周|每月|定时|周期|持续监控|重复执行|daily|weekly|monthly|recurr|schedule|monitor)/i.test(task)
  const crossSessionNeed = /(?:多个\s*(?:Agent|会话|Session)|跨\s*(?:Agent|会话|Session)|multi[- ]?agent|cross[- ]?session)/i.test(task)
  const crossAdapterNeed = /(?:跨\s*(?:Host|宿主|平台)|WorkBuddy.*(?:Claude|Codex|OpenCode)|Claude.*(?:Codex|WorkBuddy|OpenCode)|cross[- ]?host|cross[- ]?adapter)/i.test(task)
  const sideEffectRisk = inferSideEffectRisk(task)
  const distinctStages = inferStageCount(task)
  const requiresResearch =
    taskKind === 'research' ||
    /(?:调研|研究|搜集证据|比较|竞品|查资料|检索|最新|research|investigate|compare|evidence|sources?)/i.test(task)
  const reviewNeed = signalFromKeywords(task, [
    /(?:审查|审核|复核|验证|测试|事实检查|安全检查|review|audit|verify|test|fact[- ]?check|security review)/i,
    /(?:独立审查|独立审核|红队|反例|严格验证|independent review|red team|counter[- ]?evidence)/i,
  ])
  const durabilityNeed = signalFromKeywords(task, [
    /(?:耗时|长时间|中断恢复|失败重试|断点|长期|resume|recover|retry|checkpoint|long[- ]?running)/i,
    /(?:必须恢复|不能重来|持久化|durable|must resume)/i,
  ])
  return {
    taskKind,
    distinctStages,
    decomposability: levelForCount(distinctStages),
    coupling: inferCoupling(task, distinctStages),
    durabilityNeed,
    reviewNeed,
    requiresResearch,
    repeatable,
    crossSessionNeed,
    crossAdapterNeed,
    sideEffectRisk,
    ambiguity: inferAmbiguity(task),
  }
}

function inferTaskKind(task: string): TaskKind {
  if (/(?:代码|仓库|PR|bug|修复|重构|实现|测试|API|数据库|code|repository|refactor|implement|compile|deploy)/i.test(task)) return 'coding'
  if (/(?:文章|稿件|写作|编辑|标题|内容|公众号|newsletter|article|draft|editorial|copywriting)/i.test(task)) return 'content'
  if (/(?:研究|调研|证据|竞品|市场|政策|论文|research|investigate|evidence|market analysis|literature)/i.test(task)) return 'research'
  return 'general'
}

function inferStageCount(task: string): number {
  const numbered = task.match(/(?:^|\n)\s*(?:\d+[.)、]|[-*])\s+/g)?.length ?? 0
  const arrows = task.match(/(?:→|->|=>)/g)?.length ?? 0
  const transitions = task.match(/(?:然后|接着|之后|最后|再由|并最终|then|after that|finally|followed by)/gi)?.length ?? 0
  const clauses = task.split(/[；;\n]/).map(row => row.trim()).filter(Boolean).length
  let count = Math.max(1, numbered, arrows + 1, transitions + 1, Math.min(clauses, 6))
  if (task.length >= 260) count = Math.max(count, 3)
  else if (task.length >= 140) count = Math.max(count, 2)
  return Math.min(12, count)
}

function inferCoupling(task: string, stages: number): SignalLevel {
  if (/(?:同一个函数|同一段代码|一个很小的|小修复|两分钟|single function|same file|tiny fix|small bug)/i.test(task)) return 3
  if (/(?:强耦合|必须连续|不可分割|tightly coupled|atomic change)/i.test(task)) return 2
  return stages <= 1 ? 1 : 0
}

function inferAmbiguity(task: string): SignalLevel {
  if (task.length < 8) return 3
  if (/(?:随便|看着办|想办法|适当处理|whatever|somehow|do something)/i.test(task)) return 2
  if (task.length < 24 && !/[。.!?？]/.test(task)) return 1
  return 0
}

function inferSideEffectRisk(task: string): SideEffectRisk {
  if (/(?:删除生产|清空|付款|转账|购买|发布到外部|发送给客户|部署到生产|drop database|delete production|pay|purchase|publish externally|send to customers|deploy to production)/i.test(task)) return 'irreversible'
  if (/(?:创建文件|修改代码|写入|提交\s*(?:commit|PR)|create files?|modify code|write|commit changes?)/i.test(task)) return 'reversible'
  return 'none'
}

function inferConfidence(task: string, signals: ResolvedTaskAssessmentSignals): number {
  if (signals.ambiguity >= 2) return 0.6
  if (task.length >= 80) return 0.82
  if (task.length >= 40) return 0.78
  return 0.72
}

function signalFromKeywords(task: string, levels: readonly RegExp[]): SignalLevel {
  if (levels[1]?.test(task)) return 3
  if (levels[0]?.test(task)) return 2
  return 0
}

function levelForCount(count: number): SignalLevel {
  if (count >= 5) return 3
  if (count >= 3) return 2
  if (count >= 2) return 1
  return 0
}

function maximumSignal(supplied: SignalLevel | undefined, inferred: SignalLevel): SignalLevel {
  return Math.max(supplied ?? 0, inferred) as SignalLevel
}

function maximumRisk(
  supplied: SideEffectRisk | undefined,
  inferred: SideEffectRisk,
): SideEffectRisk {
  if (!supplied || RISK_RANK[inferred] >= RISK_RANK[supplied]) return inferred
  return supplied
}

function routingQuestion(score: number): RoutingQuestion {
  return {
    prompt: `This task is near or beyond a protected Flowit routing boundary (score ${score}). Choose how to continue.`,
    options: [
      {
        id: 'direct',
        label: '当前 Agent 直接完成',
        consequence: 'Lower orchestration overhead; no staged Pipeline checkpoints.',
      },
      {
        id: 'pipeline',
        label: '使用浮域拆解并执行',
        consequence: 'Prepare a bounded, recoverable, single-Session run-once Pipeline.',
      },
      {
        id: 'preview',
        label: '只查看 Pipeline 草案',
        consequence: 'Prepare and validate the graph without creating Workflow state.',
      },
    ],
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`)
  return Number(value)
}

function optionalSignal(value: unknown, name: string): SignalLevel | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 3) {
    throw new Error(`${name} must be an integer from 0 through 3`)
  }
  return Number(value) as SignalLevel
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  name: string,
): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${name} must be one of: ${[...allowed].join(', ')}`)
  }
  return value as T
}

function routingMode(value: unknown): TrustedTaskAssessmentInput['mode'] {
  if (value !== 'manual' && value !== 'suggest' && value !== 'auto-safe') {
    throw new Error('mode must be manual, suggest, or auto-safe')
  }
  return value
}

function routingExplicitIntent(value: unknown): TrustedTaskAssessmentInput['explicitIntent'] {
  if (
    value !== 'unspecified' &&
    value !== 'force-flowit' &&
    value !== 'force-direct' &&
    value !== 'preview'
  ) {
    throw new Error('explicitIntent is invalid')
  }
  return value
}
