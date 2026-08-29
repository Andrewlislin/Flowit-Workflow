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
    role('radar', 'Radar', 'Scan current signals and produce evidence-linked candidate topics.'),
    role('strategist', 'Topic Strategist', 'Score candidates and select one differentiated editorial angle.'),
    role('researcher', 'Researcher', 'Build an evidence pack with primary sources, counter-evidence, and uncertainty.'),
    role('writer', 'Writer', 'Turn the selected angle and evidence into a structured article draft.'),
    role('fact-checker', 'Fact Checker', 'Verify factual claims and correct unsupported or overstated language.'),
    role('editor', 'Chief Editor', 'Produce the final article and title options without publishing it.'),
  ]
  return {
    version: 1,
    id: 'content-studio',
    displayName: 'Content Studio',
    description: 'Hotspot discovery → topic selection → research → writing → fact-check → editorial review.',
    roles,
    inputRequired: false,
    inputLabel: 'Editorial theme / audience brief',
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
    role('planner', 'Research Planner', 'Define the question, scope, evidence standard, and research plan.'),
    role('researcher', 'Researcher', 'Collect primary evidence and structured secondary evidence.'),
    role('skeptic', 'Skeptic', 'Search for counter-evidence, alternative explanations, and weak assumptions.'),
    role('synthesizer', 'Synthesizer', 'Integrate evidence into conclusions with calibrated confidence.'),
    role('reviewer', 'Research Reviewer', 'Audit traceability, uncertainty, and report quality.'),
  ]
  return {
    version: 1,
    id: 'research-lab',
    displayName: 'Research Lab',
    description: 'Question framing → evidence collection → counter-evidence → synthesis → research review.',
    roles,
    inputRequired: true,
    inputLabel: 'Research question',
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
    role('planner', 'Planner', 'Decompose the goal into a bounded execution plan and acceptance criteria.'),
    role('researcher', 'Researcher', 'Collect the information needed to execute the plan safely.'),
    role('executor', 'Executor', 'Perform the main work while respecting the plan and evidence.'),
    role('reviewer', 'Reviewer', 'Check the result against acceptance criteria and identify residual risks.'),
  ]
  return {
    version: 1,
    id: 'agent-team',
    displayName: 'Agent Team',
    description: 'General-purpose Planner → Researcher → Executor → Reviewer work graph.',
    roles,
    inputRequired: true,
    inputLabel: 'Team goal / task brief',
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
