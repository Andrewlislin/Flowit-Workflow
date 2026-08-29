import type { AutomationTarget, CreatePipelineInput, PipelineNode } from '../core/types.js'
import { runtimeAdapterIdForSetupHost } from '../setup/catalog.js'
import type { PresetDefinition, PresetRenderRequest, PresetRoleBinding } from './types.js'

export const BUILT_IN_PRESETS = [
  contentStudioPreset(),
  researchLabPreset(),
  agentTeamPreset(),
] as const satisfies readonly PresetDefinition[]

export function builtInPreset(id: string): PresetDefinition | undefined {
  return BUILT_IN_PRESETS.find(preset => preset.id === id)
}

function contentStudioPreset(): PresetDefinition {
  const roles = [
    role('radar', '发现热点', '扫描当前信号并形成带来源的候选选题。'),
    role('strategist', '选择题目', '按统一标准评估候选选题并确定差异化角度。'),
    role('researcher', '研究资料', '建立证据包，包含一手来源、反方证据与不确定性。'),
    role('writer', '写作', '把选定角度和证据整理成结构化文章草稿。'),
    role('fact-checker', '查事实', '核查事实性陈述并纠正缺乏依据或过度表达的内容。'),
    role('editor', '主编审核', '形成最终稿和标题选项，但不自动发布。'),
  ]
  return {
    version: 1,
    id: 'content-studio',
    displayName: '内容工作室',
    aliases: ['Content Studio'],
    description: '发现热点 → 选择题目 → 研究资料 → 写作 → 查事实 → 主编审核。',
    roles,
    inputRequired: false,
    inputLabel: '内容主题 / 目标受众说明',
    render(request) {
      const brief = request.input?.trim() || 'Choose the strongest current topic for a general professional audience.'
      return linearPipeline(request, roles.map(item => item.id), {
        radar: `Act as the Radar for a content studio. Editorial brief: ${brief}\n\nScan current, relevant signals using the host's available search/browsing capabilities. Produce 10-20 candidate topics. For each candidate include: what happened, why it matters now, target audience relevance, at least one source/reference, and freshness/date. Prefer verifiable information over vague trend impressions. Save the durable candidate list under ${request.workspace}/candidates.md when filesystem tools are available. Return a compact structured summary for the next role. Do not publish anything.`,
        strategist: `Act as the Topic Strategist. Use upstream Radar evidence. Score viable candidates on a 100-point rubric: audience relevance 25, information value 20, timeliness 15, differentiation 15, reliable evidence 15, likely engagement 10. Select one topic only when it has a defensible angle and enough evidence. State the chosen topic, score, audience, thesis, differentiation, risks, and research questions. Save to ${request.workspace}/topic.md when possible.`,
        researcher: `Act as the Researcher. Deep-research the selected topic from upstream context. Prioritize primary/official sources, then reputable secondary sources. Separate confirmed facts, reasonable inference, analysis, and uncertainty. Include dates, source identifiers/URLs when available, contrary evidence, missing evidence, and claims that must not be overstated. Save an evidence pack to ${request.workspace}/research.md and source list to ${request.workspace}/sources.md when possible. Return a bounded evidence summary for the writer.`,
        writer: `Act as the Writer. Using only the selected angle and upstream evidence, create a clear article with a strong opening, explicit thesis, logical sections, concrete evidence, and a useful conclusion. Do not invent facts or citations. Mark unresolved factual gaps instead of guessing. Save outline and draft to ${request.workspace}/outline.md and ${request.workspace}/draft.md when possible. Return the complete draft or a sufficiently detailed bounded draft summary for fact-checking.`,
        'fact-checker': `Act as the Fact Checker. Audit every material factual claim in the upstream draft against the evidence pack and source context. Identify unsupported, stale, ambiguous, or overconfident claims; distinguish factual errors from editorial disagreement. Produce corrections and a corrected draft. Save the audit to ${request.workspace}/fact-check.md and corrected draft to ${request.workspace}/draft-checked.md when possible. Do not approve unsupported claims merely to preserve prose.`,
        editor: `Act as the Chief Editor. Produce the final publish-ready article from the corrected upstream draft. Improve structure, clarity, pacing, and titles without reintroducing unsupported claims. Provide 3-5 title options, a short abstract, final article, and a short residual-risk note. Save to ${request.workspace}/final.md when possible. Do not publish or perform irreversible external side effects; final output remains human-reviewable.`,
      })
    },
  }
}

function researchLabPreset(): PresetDefinition {
  const roles = [
    role('planner', '规划问题', '明确研究问题、范围、证据标准与研究计划。'),
    role('researcher', '搜证据', '收集一手证据和结构化的二手资料。'),
    role('skeptic', '找反例', '主动寻找反方证据、替代解释与薄弱假设。'),
    role('synthesizer', '综合', '综合证据并按可信度形成结论。'),
    role('reviewer', '审核', '检查来源可追溯性、不确定性和报告质量。'),
  ]
  return {
    version: 1,
    id: 'research-lab',
    displayName: '深度研究',
    aliases: ['Research Lab'],
    description: '规划问题 → 搜证据 → 找反例 → 综合 → 审核。',
    roles,
    inputRequired: true,
    inputLabel: '研究问题',
    render(request) {
      const question = requireInput(request, 'research-lab')
      return linearPipeline(request, roles.map(item => item.id), {
        planner: `Act as the Research Planner. Research question: ${question}\n\nTurn the question into a precise research brief: definitions, scope, timeframe, decision/use case, hypotheses, evidence requirements, primary-source priorities, exclusion criteria, and key uncertainties. Save to ${request.workspace}/brief.md when possible. Return the research plan for the next role.`,
        researcher: `Act as the Researcher. Execute the upstream research plan. Prefer primary/official sources and direct data. Capture source dates, provenance, relevant data points, and exact uncertainty. Separate confirmed facts from inference. Save structured evidence to ${request.workspace}/evidence.md and a source registry to ${request.workspace}/sources.md when possible. Do not fill evidence gaps with unsupported assumptions.`,
        skeptic: `Act as the Skeptic. Challenge the upstream evidence and emerging conclusions. Search for counter-evidence, contradictory data, selection bias, alternative causal explanations, stale sources, missing base rates, and claims that depend on weak assumptions. Save to ${request.workspace}/counter-evidence.md when possible. Return the strongest objections and what evidence would resolve them.`,
        synthesizer: `Act as the Synthesizer. Answer the research question using upstream evidence and counter-evidence. Organize conclusions by confidence, explicitly distinguish fact/inference/analysis/uncertainty, and show where sources disagree. Include implications, risks, and unresolved questions. Save the report to ${request.workspace}/report.md when possible. Do not hide contradictory evidence.`,
        reviewer: `Act as the Research Reviewer. Audit the report for source traceability, unsupported claims, missing counter-evidence, causal overreach, uncertainty calibration, and internal consistency. Produce a final revised report plus a concise limitations section and evidence-quality assessment. Save to ${request.workspace}/report-final.md when possible.`,
      })
    },
  }
}

function agentTeamPreset(): PresetDefinition {
  const roles = [
    role('planner', '规划', '把目标拆成有边界的执行计划和验收标准。'),
    role('researcher', '调研', '收集安全执行计划所需要的信息、约束和依据。'),
    role('executor', '执行', '按照计划和证据完成主要工作。'),
    role('reviewer', 'Review', '按验收标准检查结果并指出剩余风险。'),
  ]
  return {
    version: 1,
    id: 'agent-team',
    displayName: 'AI 项目小组',
    aliases: ['Agent Team', 'AI Project Team'],
    description: '规划 → 调研 → 执行 → Review。',
    roles,
    inputRequired: true,
    inputLabel: '项目目标 / 任务说明',
    render(request) {
      const goal = requireInput(request, 'agent-team')
      return linearPipeline(request, roles.map(item => item.id), {
        planner: `Act as the Planner. Goal: ${goal}\n\nDefine the deliverable, constraints, non-goals, dependencies, risk controls, acceptance criteria, and an ordered execution plan. Keep the plan bounded enough for downstream roles to execute without inventing missing authority. Save to ${request.workspace}/plan.md when possible.`,
        researcher: `Act as the Researcher. Use the upstream plan to gather the facts, references, examples, constraints, and failure modes required for execution. Flag unresolved questions rather than guessing. Save to ${request.workspace}/research.md when possible and return a bounded evidence/context summary.`,
        executor: `Act as the Executor. Complete the requested goal using the upstream plan and evidence. Respect stated constraints and do not perform irreversible external side effects unless they were explicitly authorized in the original goal and supported by the host. Save durable working output under ${request.workspace}/ when possible. Return the completed deliverable and any assumptions made.`,
        reviewer: `Act as the Reviewer. Compare the upstream deliverable against every acceptance criterion from the plan. Identify correctness gaps, missing evidence, unsafe assumptions, and residual risks. Produce a corrected final deliverable when feasible plus a concise review verdict. Save to ${request.workspace}/review.md when possible.`,
      })
    },
  }
}

function role(id: string, displayName: string, description: string) {
  return { id, displayName, description }
}

function requireInput(request: PresetRenderRequest, presetId: string): string {
  const value = request.input?.trim()
  if (!value) throw new Error(`preset ${presetId} requires --input`)
  return value
}

function linearPipeline(
  request: PresetRenderRequest,
  roleIds: readonly string[],
  prompts: Readonly<Record<string, string>>,
): CreatePipelineInput {
  const nodes: PipelineNode[] = roleIds.map((roleId, index) => {
    const binding = requireBinding(request, roleId)
    return {
      id: roleId,
      target: target(binding, prompts[roleId] ?? `Act as ${roleId}.`),
      inheritUpstreamContext: index > 0,
    }
  })
  return {
    name: request.pipelineName,
    trigger: { kind: 'manual' },
    nodes,
    edges: roleIds.slice(1).map((roleId, index) => ({ from: roleIds[index]!, to: roleId })),
  }
}

function requireBinding(request: PresetRenderRequest, roleId: string): PresetRoleBinding {
  const binding = request.bindings[roleId]
  if (!binding) throw new Error(`preset role ${roleId} has no session binding`)
  return binding
}

function target(binding: PresetRoleBinding, prompt: string): AutomationTarget {
  return {
    adapterId: runtimeAdapterIdForSetupHost(binding.adapterId),
    sessionId: binding.sessionId,
    prompt,
    skills: [...binding.skills],
    contextRefs: [],
  }
}
