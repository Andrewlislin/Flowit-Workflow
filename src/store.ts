import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AutomationRunRecord, PipelineDefinition, ScheduledTask, WorkflowState } from './types.js'

const EMPTY_STATE: WorkflowState = { version: 1, schedules: [], pipelines: [], runs: [] }

export class JsonWorkflowStore {
  private state: WorkflowState = structuredClone(EMPTY_STATE)
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly maxRunHistory = 500,
  ) {}

  async snapshot(): Promise<WorkflowState> {
    await this.ensureLoaded()
    await this.mutationTail
    return structuredClone(this.state)
  }

  async putSchedule(task: ScheduledTask): Promise<void> {
    await this.mutate(state => {
      const index = state.schedules.findIndex(candidate => candidate.id === task.id)
      if (index >= 0) state.schedules[index] = task
      else state.schedules.push(task)
    })
  }

  async putPipeline(pipeline: PipelineDefinition): Promise<void> {
    await this.mutate(state => {
      const index = state.pipelines.findIndex(candidate => candidate.id === pipeline.id)
      if (index >= 0) state.pipelines[index] = pipeline
      else state.pipelines.push(pipeline)
    })
  }

  async putRun(run: AutomationRunRecord): Promise<void> {
    await this.mutate(state => {
      const index = state.runs.findIndex(candidate => candidate.id === run.id)
      if (index >= 0) state.runs[index] = run
      else state.runs.push(run)
      if (state.runs.length > this.maxRunHistory) {
        state.runs.splice(0, state.runs.length - this.maxRunHistory)
      }
    })
  }

  private async mutate(operation: (state: WorkflowState) => void): Promise<void> {
    await this.ensureLoaded()
    const next = this.mutationTail.then(async () => {
      const draft = structuredClone(this.state)
      operation(draft)
      await this.persist(draft)
      this.state = draft
    })
    this.mutationTail = next.catch(() => undefined)
    return next
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.load().finally(() => { this.loadPromise = undefined })
    return this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as WorkflowState
      if (parsed.version !== 1 || !Array.isArray(parsed.schedules) || !Array.isArray(parsed.pipelines) || !Array.isArray(parsed.runs)) {
        throw new Error('unsupported Flowit Workflow state')
      }
      this.state = parsed
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.persist(this.state)
    }
    this.loaded = true
  }

  private async persist(state: WorkflowState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, this.filePath)
  }
}
