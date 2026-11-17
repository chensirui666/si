import { randomUUID } from 'node:crypto'
import { Agent } from '@agent-learning/agent'
import type { AgentEvent, AgentRunInput } from '@agent-learning/agent'
import { estimateContextTokens, findModel, omittedToolImageIndexes, sameSelection, stream } from '@agent-learning/model'
import type { AssistantMessage, ModelContext, ModelDiscovery, ModelEvent, ModelInfo, ModelSelection, ModelStreamOptions, ReasoningEffort } from '@agent-learning/model'
import { buildModelHistory, createSummaryContext, prepareCompaction } from './compaction.js'
import { loadProjectContextFiles, ProjectContextOverflow, type ProjectContextFile } from './project-context.js'
import { SessionWriteError, runSelection, submissionReceipt, type SessionPersistence, type StoredRun } from './session-store.js'
import { discoverSkills, loadSkill, skillCommand, type SkillSummary } from './skills.js'
import { withModelRetry } from './model-retry.js'
import { buildSystemPrompt } from './system-prompt.js'
import { defaultTools, type CodingTool } from './tools.js'
import { beforeStart, requestMessages, toolHooks } from './extensions/dispatch.js'
import { ExtensionRuntime, extensionMessage, object, type ExtensionContext, type ExtensionEntry, type ExtensionEvents, type ExtensionMessage } from './extensions/runtime.js'
import { isPermissionMode, type PermissionMode } from './permissions.js'
import type { CompactionRecord, ExtensionNotice, SubmissionAccepted, SubmissionHandled, SessionSubscriptionEvent, ConversationMessage, ConversationSnapshot, ConversationUpdate, ModelFrame, RunRecord, RunningState, SaveFailure } from './types.js'

type SubmissionResult = SubmissionAccepted | SubmissionHandled

type SubmissionInput = Pick<ModelSelection, 'modelId'> & Partial<ModelSelection> & { clientMessageId: string; text: string; permissionMode?: PermissionMode }

const readOnlyTools = new Set(['read', 'grep', 'find', 'ls'])

const capacityError = '当前模型容量不足，无法继续这轮，请切换模型重新压缩。'
const staleSelection = '模型设置已更新，请确认后再发送。'

export class SessionSubmitError extends Error {
  constructor(readonly code: 'invalid' | 'busy' | 'closed' | 'model_selection_changed', message: string) { super(message) }
}

function isFileOperation(detail: unknown): detail is NonNullable<ConversationMessage['fileOperation']> {
  return detail !== null && typeof detail === 'object' && 'kind' in detail && 'path' in detail
    && (detail.kind === 'read' || detail.kind === 'modified') && typeof detail.path === 'string'
}

export class AgentSession {
  private submitting?: { input: SubmissionInput; settled: Promise<SubmissionResult> }
  private preparing?: AbortController
  private initialization?: Promise<void>
  private initializing?: AbortController
  private closing?: Promise<void>
  private readonly runtime?: ExtensionRuntime
  private readonly sessionId: string
  private cwd?: string
  private readonly handled = new Map<string, { input: SubmissionInput; result: SubmissionHandled }>()
  private readonly selectionNotifications = new Set<Promise<void>>()
  private readonly omittedToolImageResults = new Set<string>()
  private readonly state: ConversationSnapshot = { seq: 0, permissionMode: 'normal', messages: [], running: null, activeContent: [], compactions: [], contextUsage: null }
  private readonly listeners = new Set<(update: ConversationUpdate) => void>()
  private controller?: AbortController
  private task?: Promise<void>
  private settling = false
  private closed = false
  private model?: ModelInfo
  private configuration: Omit<ModelContext, 'messages'> = {}
  private projectContext?: { cwd: string; files: ProjectContextFile[] }
  private sample?: { key: string; config: string; messages: string[]; input: number; estimate: number }
  private gateSample?: typeof this.sample
  private readonly storedRuns = new Map<string, StoredRun>()
  private readonly savedMessages = new Set<string>()
  private failure?: SaveFailure
  private permissionUnconfirmed = false

  constructor(private readonly options: {
    persistence?: SessionPersistence
    sessionId?: string
    extensions?: readonly ExtensionEntry[]
    reportExtensionError?: (message: string, error: unknown) => void
    permissionMode?: PermissionMode
    stream?: typeof stream
    tools?: (cwd: string) => CodingTool[]
    documentationRoot?: string
    skillHome?: string
    globalContextDirectory?: string
    resolveDirectory: () => Promise<string>
    discoverModels?: typeof import('@agent-learning/model').discoverModels
    compaction?: { triggerTokens: number; keepRecentTokens: number }
  }) {
    this.sessionId = options.persistence?.summary.id ?? options.sessionId ?? randomUUID()
    if (options.extensions?.length) this.runtime = new ExtensionRuntime(options.extensions, options.reportExtensionError)
    const history = options.persistence?.history
    this.state.permissionMode = history?.permissionMode ?? options.permissionMode ?? 'normal'
    if (history) {
      const last = history.runs.at(-1)
      this.state.modelSelection = history.modelSelection ?? (last && runSelection(last))
      this.state.messages = history.messages
      this.state.compactions = history.compactions.map(record => record.status === 'running'
        ? { ...record, status: 'interrupted', finishedAt: Date.now(), reason: '服务中断，压缩未完成。' } : record)
      for (const entry of history.messages) this.savedMessages.add(entry.id)
      for (const run of history.runs) this.storedRuns.set(run.clientMessageId, run)
      this.state.seq = history.runs.at(-1)?.acceptedSeq ?? 0
      if (history.runs.length) this.state.runs = history.runs.map(run => ({
        ...this.publicRun(run), restored: true, status: run.status === 'running' ? 'interrupted' : run.status,
      }))
    }
    const budget = options.compaction
    if (budget && (!Number.isSafeInteger(budget.triggerTokens) || !Number.isSafeInteger(budget.keepRecentTokens)
      || budget.keepRecentTokens <= 0 || budget.triggerTokens <= budget.keepRecentTokens)) {
      throw new Error('压缩预算必须为正整数，近期预算必须小于触发预算')
    }
  }

  private extensionContext(cwd: string, model?: ModelInfo, signal?: AbortSignal, notices?: ExtensionNotice[]): ExtensionContext {
    return {
      cwd, model, sessionId: this.sessionId, signal, thinkingLevel: model?.defaultReasoningEffort,
      hasUI: notices !== undefined || this.listeners.size > 0,
      ui: { notify: (message, level = 'info') => {
        if (typeof message !== 'string' || !['info', 'warning', 'error'].includes(level)) throw new Error('无效的扩展提示')
        const notice = { message, level }
        if (notices) notices.push(notice)
        else this.publishNotice(notice)
      } },
    }
  }

  private publishNotice(notice: ExtensionNotice) {
    if (this.listeners.size) this.publish({ type: 'notice', notice })
  }

  initialize(cwd?: string, model?: ModelInfo): Promise<void> | undefined {
    if (!this.runtime || this.closed) return this.initialization
    return this.initialization ??= Promise.resolve().then(async () => {
      const signal = (this.initializing = new AbortController()).signal
      if (this.closed) this.initializing.abort()
      const path = cwd ?? await this.options.resolveDirectory()
      this.cwd = path
      const selection = this.state.modelSelection
      const selected = model ?? (selection && findModel(selection.modelId, selection.provider))
      if (selected && selection && !model) selected.defaultReasoningEffort = selection.reasoningEffort
      const ctx = this.extensionContext(path, selected, signal)
      await this.runtime!.initialize(ctx, [...defaultTools, ...this.options.tools?.(path) ?? []].map(tool => tool.name))
      await this.runtime!.emit('session_start', { reason: this.options.persistence?.history ? 'resume' : 'new' }, ctx)
    }).catch(error => {
      this.initialization = undefined
      throw error
    }).finally(() => { this.initializing = undefined })
  }

  selectModel(selection: ModelSelection) {
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    const previous = this.state.modelSelection
    const storage = this.options.persistence
    storage?.store.saveModelSelection(selection, storage.summary.id)
    this.state.modelSelection = selection
    this.publish({ type: 'selection', selection })
    const initializing = this.initialize()
    if (initializing && !sameSelection(previous, selection)) {
      const model = findModel(selection.modelId, selection.provider)
      if (!model) return
      model.defaultReasoningEffort = selection.reasoningEffort
      const previousNotifications = [...this.selectionNotifications]
      const notification = initializing.then(async () => {
        await Promise.allSettled(previousNotifications)
        if (!this.cwd || this.closed) return
        const ctx = this.extensionContext(this.cwd, model)
        if (previous?.modelId !== selection.modelId || previous?.provider !== selection.provider) {
          const previousModel = previous && findModel(previous.modelId, previous.provider)
          if (previousModel) previousModel.defaultReasoningEffort = previous?.reasoningEffort
          await this.runtime!.emit('model_select', { model, previousModel, source: 'set' }, ctx)
        }
        if (previous?.reasoningEffort !== selection.reasoningEffort) {
          await this.runtime!.emit('thinking_level_select', { level: selection.reasoningEffort, previousLevel: previous?.reasoningEffort }, ctx)
        }
      })
      this.selectionNotifications.add(notification)
      return notification.finally(() => this.selectionNotifications.delete(notification))
    }
  }

  selectPermissionMode(permissionMode: PermissionMode) {
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    if (!isPermissionMode(permissionMode)) throw new SessionSubmitError('invalid', '权限模式无效')
    try {
      if (this.permissionUnconfirmed) throw new SessionWriteError('unconfirmed')
      this.save({ permissionMode })
    } catch (error) {
      if (error instanceof SessionWriteError && error.reason === 'unconfirmed') this.permissionUnconfirmed = true
      throw error
    }
    this.state.permissionMode = permissionMode
    this.publish({ type: 'permission', permissionMode })
  }

  private configure(cwd: string, tools: CodingTool[], files: ProjectContextFile[], skills: readonly SkillSummary[]) {
    const available = this.state.permissionMode === 'normal' ? tools : tools.filter(tool => readOnlyTools.has(tool.name))
    const declarations = available.map(({ name, description, parameters }) => ({ name, description, parameters }))
    this.configuration = {
      systemPrompt: buildSystemPrompt(cwd, available, this.options.documentationRoot, files, skills, this.options.skillHome),
      ...(declarations.length ? { tools: declarations } : {}),
    }
  }

  async submit(input: SubmissionInput): Promise<SubmissionResult> {
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    if (typeof input?.modelId !== 'string' || !input.provider && input.modelId !== 'deepseek-flash'
      || typeof input.text !== 'string' || !input.text.trim()
      || typeof input.clientMessageId !== 'string' || !input.clientMessageId.trim() || input.clientMessageId.length > 128) {
      throw new SessionSubmitError('invalid', '请提交有效原文、支持的模型和临时编号')
    }
    const selection = runSelection(input)
    const previous = this.replay(input, selection)
    if (previous) return previous
    const model = findModel(selection.modelId, selection.provider)
    if (!model) throw new SessionSubmitError('invalid', '当前模型不可用，请重新选择')
    if (model.reasoningEfforts
      ? !selection.reasoningEffort || !model.reasoningEfforts.includes(selection.reasoningEffort) : selection.reasoningEffort !== undefined) {
      throw new SessionSubmitError('invalid', '所选模型不支持此推理强度')
    }
    while (this.submitting?.input.clientMessageId === input.clientMessageId) {
      this.checkReplay(this.submitting.input, input, selection)
      await this.submitting.settled.catch(() => undefined)
      if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
      const accepted = this.replay(input, selection)
      if (accepted) return accepted
    }
    if (this.submitting || this.state.running) throw new SessionSubmitError('busy', '正在接收或生成，请等待本次回答结束')
    const controller = this.preparing = new AbortController()
    const promise = this.accept(input, selection, model, controller)
    this.submitting = { input, settled: promise }
    try {
      return await promise
    } finally {
      this.submitting = undefined
      this.preparing = undefined
    }
  }

  private async accept(input: SubmissionInput, selection: ModelSelection, model: ModelInfo, controller: AbortController): Promise<SubmissionResult> {
    const { signal } = controller
    const cwd = await this.options.resolveDirectory()
    const directory = await this.options.discoverModels?.()
    const manual = input.text.trim() === '/compact'
    this.checkPreparing(signal)
    this.checkModelSelection(input, selection, directory)
    model.defaultReasoningEffort = selection.reasoningEffort
    this.model = model
    if (this.options.persistence?.first && !this.storedRuns.size && input.permissionMode !== undefined) {
      if (!isPermissionMode(input.permissionMode)) throw new SessionSubmitError('invalid', '权限模式无效')
      this.state.permissionMode = input.permissionMode
    }
    const initializing = this.initialize(cwd, model)
    if (initializing) await initializing
    this.checkPreparing(signal)
    let text = input.text
    if (!manual && this.runtime?.has('input')) {
      const notices: ExtensionNotice[] = []
      const result = await this.runtime.input(text, this.extensionContext(cwd, model, signal, notices))
      this.checkPreparing(signal)
      if (result.handled) {
        const result: SubmissionHandled = { kind: 'handled', clientMessageId: input.clientMessageId, notices: [...notices] }
        this.handled.set(input.clientMessageId, { input, result })
        return structuredClone(result)
      }
      text = result.text
      for (const notice of notices) this.publishNotice(notice)
    }
    const skills = manual ? [] : (await discoverSkills(cwd, { home: this.options.skillHome, applicationRoot: this.options.documentationRoot })).skills
    const namedSkill = skillCommand.exec(text)?.[1]
    const selectedSkill = namedSkill ? skills.find(skill => skill.name === namedSkill) : undefined
    const skillInvocation = selectedSkill ? await loadSkill(selectedSkill) : undefined
    const tools = this.options.tools?.(cwd) ?? []
    let files = this.projectContext?.cwd === cwd ? this.projectContext.files : []
    if (!manual && this.runtime?.has('before_agent_start')) {
      try { files = await this.loadContextFiles(cwd, model, signal) }
      catch (error) {
        // The normal task path reports oversized project instructions after accepting the message.
        if (!(error instanceof ProjectContextOverflow)) throw error
      }
    }
    this.checkPreparing(signal)
    this.configure(cwd, [...tools, ...this.runtime?.tools() ?? []], files, skills)
    if (manual) {
      this.checkModelSelection(input, selection, directory)
      const record = this.newCompaction('manual', input.clientMessageId)
      const running = { kind: 'compaction' as const, runId: record.id, phase: 'compaction' as const }
      const run = this.saveStart(input, selection, record.id, 'compaction', { compaction: record })
      const initialSelection = this.confirmInitialSelection(selection)
      this.controller = controller
      this.state.compactions.push(record)
      this.state.running = running
      this.publish({ type: 'compaction', record, running }, run && this.publicRun(run), undefined, initialSelection)
      const acceptedSeq = this.state.seq
      this.task = Promise.resolve().then(async () => {
        let status: RunRecord['status'] = 'failed'
        try {
          await this.compact(model, selection.reasoningEffort, 'manual', running, controller.signal, record)
          status = this.storedRuns.get(input.clientMessageId)?.status ?? 'completed'
        } catch (error) {
          if (!(error instanceof SessionWriteError)) throw error
        } finally { await this.finish(controller.signal, status) }
      })
      return { kind: 'compaction', clientMessageId: input.clientMessageId, compactionId: record.id, acceptedSeq }
    }
    const user: ConversationMessage = {
      id: randomUUID(), clientMessageId: input.clientMessageId,
      message: { role: 'user', content: text, timestamp: Date.now() },
      ...(skillInvocation && { skillInvocation }),
    }
    const running = { kind: 'task' as const, runId: user.id, assistantMessageId: randomUUID(), phase: 'model' as const, activeTools: [] }
    let systemPrompt: string | undefined
    let extra: ConversationMessage[] = []
    if (this.runtime?.has('before_agent_start')) {
      const prompt = buildModelHistory([user])[0]?.content
      const start = await beforeStart(this.runtime, this.extensionContext(cwd, model, signal), this.configuration.systemPrompt ?? '',
        typeof prompt === 'string' ? prompt : text, user.id)
      this.checkPreparing(signal)
      if (start.overridden) systemPrompt = start.systemPrompt
      extra = start.extra.map(message => this.extensionEntry(message))
    }
    this.checkModelSelection(input, selection, directory)
    const run = this.saveStart(input, selection, user.id, 'task', { messages: [user, ...extra] }, text)
    const initialSelection = this.confirmInitialSelection(selection)
    this.controller = controller
    this.state.messages.push(user, ...extra)
    this.state.running = running
    this.publish({ type: 'accepted', user, running }, run && this.publicRun(run), undefined, initialSelection)
    const acceptedSeq = this.state.seq
    this.task = Promise.resolve().then(() => this.runTask(model, selection.reasoningEffort, running, cwd, tools, skills, controller.signal, user, systemPrompt))
    return { kind: 'message', clientMessageId: input.clientMessageId, userMessageId: user.id, acceptedSeq }
  }

  private checkModelSelection(input: SubmissionInput, selection: ModelSelection, directory?: ModelDiscovery) {
    const storedDefault = this.options.persistence?.store.getDefaultSelection()
    const fallback = directory?.defaultSelection
    const current = this.state.modelSelection ?? storedDefault ?? fallback
    const legacyUnconfigured = !input.provider && !current && !directory?.models.length
    if (!legacyUnconfigured && (directory || current) && !sameSelection(selection, current)) {
      throw new SessionSubmitError('model_selection_changed', staleSelection)
    }
    if (!legacyUnconfigured && directory && !directory.models.some(item => item.provider === selection.provider && item.id === selection.modelId)) {
      throw new SessionSubmitError('invalid', '当前模型不可用，请重新选择')
    }
  }

  private checkPreparing(signal: AbortSignal) {
    if (this.closed || signal.aborted) throw new SessionSubmitError('closed', '服务正在关闭')
  }

  private loadContextFiles(cwd: string, model: ModelInfo, signal: AbortSignal) {
    return loadProjectContextFiles({
      cwd, globalDirectory: this.options.globalContextDirectory, signal,
      // The estimator allows four UTF-16 units per token, each using at most three UTF-8 bytes.
      maxBytes: (model.contextWindow - model.maxTokens) * 12,
    })
  }

  private extensionEntry({ content, ...extension }: ExtensionMessage): ConversationMessage {
    return { id: randomUUID(), extension, message: { role: 'user', content, timestamp: Date.now() } }
  }

  private confirmInitialSelection(selection: ModelSelection) {
    if (this.state.modelSelection) return
    this.state.modelSelection = selection
    return selection
  }

  private replay(input: SubmissionInput, selection: ModelSelection) {
    const handled = this.handled.get(input.clientMessageId)
    if (handled) {
      this.checkReplay(handled.input, input, selection)
      return structuredClone(handled.result)
    }
    const previous = this.storedRuns.get(input.clientMessageId)
    if (!previous) return
    this.checkReplay({ ...previous, permissionMode: previous.firstPermissionMode }, input, selection)
    return submissionReceipt(previous)
  }

  private checkReplay(previous: SubmissionInput, input: SubmissionInput, selection: ModelSelection) {
    if (previous.text !== input.text || previous.permissionMode !== input.permissionMode || !sameSelection(runSelection(previous), selection)) {
      throw new SessionSubmitError('busy', '此提交编号已用于另一条消息')
    }
  }

  private publicRun({ text: _text, finalText: _finalText, acceptedSeq: _acceptedSeq, firstPermissionMode: _firstPermissionMode, ...run }: StoredRun): RunRecord {
    return run
  }

  private saveStart(input: SubmissionInput, selection: ModelSelection, id: string, kind: RunRecord['kind'],
    data: { messages?: ConversationMessage[]; compaction?: CompactionRecord }, finalText?: string) {
    const storage = this.options.persistence
    if (!storage) return
    const { permissionMode, ...message } = input
    const summary = this.storedRuns.size === 0 ? storage.first?.() : undefined
    const run: StoredRun = {
      ...message, ...(finalText !== undefined && finalText !== input.text && { finalText }), ...(summary && permissionMode !== undefined && { firstPermissionMode: permissionMode }), ...selection, id, kind, sessionId: storage.summary.id, status: 'running', startedAt: Date.now(), acceptedSeq: this.state.seq + 1,
    }
    this.save({ ...data, run, summary, ...(summary && { permissionMode: this.state.permissionMode }),
      modelSelection: this.state.modelSelection ? undefined : selection })
    return run
  }

  private save(data: Parameters<SessionPersistence['store']['save']>[1]) {
    const storage = this.options.persistence
    if (!storage) return
    storage.store.save(storage.summary.id, { runId: data.run?.id ?? this.state.running?.runId, ...data })
    if (data.run) this.storedRuns.set(data.run.clientMessageId, data.run)
    for (const message of data.messages ?? []) this.savedMessages.add(message.id)
  }

  private noteFailure(error: unknown, stage: SaveFailure['stage'], toolCall?: SaveFailure['toolCall']) {
    if (!(error instanceof SessionWriteError)) throw error
    const runId = this.state.running!.runId
    this.failure ??= { runId, stage, reason: error.reason, ...(toolCall && { toolCall }) }
    this.sample = this.gateSample = undefined
  }

  private historyMessages() {
    return this.options.persistence ? this.state.messages.filter(entry => this.savedMessages.has(entry.id)) : this.state.messages
  }

  private latestCompaction() {
    return [...this.state.compactions].reverse().find((record): record is Extract<CompactionRecord, { status: 'success' }> => record.status === 'success')
  }

  private context(compaction = this.latestCompaction()): ModelContext {
    return {
      ...this.configuration, messages: buildModelHistory(this.historyMessages(), compaction, !!this.options.persistence),
      omittedToolImageResults: this.omittedToolImageResults,
    }
  }

  private estimate(context: ModelContext, model = this.model) {
    const estimate = estimateContextTokens(context, model)
    return estimate.systemTokens + estimate.toolsTokens + estimate.messageTokens
  }

  private configKey() { return JSON.stringify(this.configuration) }
  private modelKey(model: ModelInfo) { return JSON.stringify([model.provider, model.id, model.defaultReasoningEffort]) }

  private pressure(context: ModelContext, model: ModelInfo) {
    const estimate = this.estimate(context), sample = this.gateSample
    if (sample && sample.key === this.modelKey(model) && sample.config === this.configKey()
      && sample.messages.length <= context.messages.length
      && sample.messages.every((message, index) => message === JSON.stringify(context.messages[index]))) {
      return Math.max(0, sample.input + estimate - sample.estimate)
    }
    return estimate
  }

  private refreshUsage() {
    if (!this.model) return
    const context = this.context(), estimate = this.estimate(context), sample = this.sample
    this.state.contextUsage = {
      tokens: sample?.key === this.modelKey(this.model) && sample.config === this.configKey()
        ? Math.max(0, sample.input + estimate - sample.estimate) : estimate,
      contextWindow: this.model.contextWindow, breakdown: estimateContextTokens(context, this.model),
    }
  }

  private newCompaction(trigger: CompactionRecord['trigger'], clientMessageId?: string): CompactionRecord {
    const record: CompactionRecord = { id: randomUUID(), trigger, status: 'running', startedAt: Date.now(), ...(clientMessageId && { clientMessageId }) }
    return record
  }

  private providerHooks(ctx: () => ExtensionContext, model: ModelInfo, runId: string) {
    const runtime = this.runtime
    if (!runtime) return
    const options: Pick<ModelStreamOptions, 'onProviderResponse' | 'onProviderStreamEvent'> = {}
    if (runtime.has('after_provider_response')) options.onProviderResponse = response => runtime.emit('after_provider_response', response, ctx(), runId)
    if (runtime.has('provider_stream_event')) options.onProviderStreamEvent = data => runtime.emit('provider_stream_event',
      { provider: model.provider, api: model.api, model: model.id, data }, ctx(), runId)
    return options
  }

  private async compact(model: ModelInfo, reasoningEffort: ReasoningEffort | undefined, trigger: CompactionRecord['trigger'], running: NonNullable<RunningState>, signal: AbortSignal, initial?: CompactionRecord) {
    const record = initial ?? this.newCompaction(trigger)
    const working: NonNullable<RunningState> = { ...running, phase: 'compaction' }
    this.state.running = working
    if (!initial) {
      try { this.save({ compaction: record }) }
      catch (error) { this.noteFailure(error, 'compaction'); throw error }
      this.state.compactions.push(record)
      this.publish({ type: 'compaction', record, running: working })
    }
    const runtime = this.runtime
    const ctx = () => this.extensionContext(this.cwd ?? '', model, signal)
    const boundary = { reason: trigger === 'auto' ? 'threshold' as const : trigger, fromExtension: false as const, willRetry: trigger === 'overflow' }
    let final: CompactionRecord
    let summaryUsage: AssistantMessage['usage']
    try {
      signal.throwIfAborted()
      const preparation = prepareCompaction(this.historyMessages(), this.latestCompaction(), this.options.compaction?.keepRecentTokens ?? 20_000, Boolean(this.configuration.tools?.length), !!this.options.persistence, model)
      if (preparation.status === 'skipped') {
        final = { ...record, status: 'skipped', finishedAt: Date.now(), reason: preparation.reason === 'already_compacted' ? '刚压缩完成，尚无新内容。' : '没有可压缩的较早内容。' }
      } else {
        const context = createSummaryContext(preparation)
        if (this.estimate(context) + model.maxTokens > model.contextWindow) throw new Error('摘要请求预计超出模型容量。')
        let terminal: AssistantMessage | undefined
        try {
          for await (const event of (this.options.stream ?? stream)(model, context, { signal, reasoningEffort, ...this.providerHooks(ctx, model, running.runId) })) {
            if (event.type === 'done' || event.type === 'error') { terminal = structuredClone(event.type === 'done' ? event.message : event.error); break }
          }
        } catch (error) { if (!terminal) throw error }
        summaryUsage = terminal?.usage
        signal.throwIfAborted()
        if (terminal?.errorCode === 'context_overflow') throw new Error('模型服务报告摘要请求超出容量。')
        if (!terminal || terminal.stopReason !== 'stop' || terminal.content.some(block => block.type === 'toolCall')) throw new Error('摘要生成未完整完成，保留原上下文。')
        const summary = terminal.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
        if (!summary) throw new Error('摘要为空，保留原上下文。')
        const candidate: Extract<CompactionRecord, { status: 'success' }> = {
          ...record, status: 'success', finishedAt: Date.now(), summary,
          firstKeptMessageId: preparation.firstKeptMessageId, contextLastMessageId: preparation.contextLastMessageId,
          estimatedBefore: this.estimate(this.context()), estimatedAfter: 0,
          ...(summaryUsage && { summaryUsage }),
          ...(preparation.fileOperations && { fileOperations: preparation.fileOperations }),
        }
        const next = this.context(candidate)
        candidate.estimatedAfter = this.estimate(next)
        if (candidate.estimatedAfter >= candidate.estimatedBefore) throw new Error('摘要未有效缩短输入，保留原上下文。')
        if (candidate.estimatedAfter + model.maxTokens > model.contextWindow) throw new Error('压缩后仍预计超出模型容量，保留原上下文。')
        signal.throwIfAborted()
        final = candidate
      }
    } catch (error) {
      final = { ...record, status: signal.aborted ? 'aborted' : 'failed', finishedAt: Date.now(),
        reason: signal.aborted ? '本次压缩已停止。' : error instanceof Error && ['摘要请求预计超出模型容量。', '模型服务报告摘要请求超出容量。', '摘要生成未完整完成，保留原上下文。', '摘要为空，保留原上下文。', '摘要未有效缩短输入，保留原上下文。', '压缩后仍预计超出模型容量，保留原上下文。'].includes(error.message) ? error.message : '摘要生成失败，保留原上下文。',
        ...(summaryUsage && { summaryUsage }),
      }
    }
    const index = this.state.compactions.findIndex(item => item.id === record.id)
    const manualRun = record.clientMessageId ? this.storedRuns.get(record.clientMessageId) : undefined
    const status = final.status === 'success' || final.status === 'skipped' ? 'completed' : final.status === 'aborted' ? 'aborted' : 'failed'
    const run = manualRun && this.endedRun(manualRun, status)
    try { this.save({ compaction: final, run }) }
    catch (error) {
      this.noteFailure(error, 'compaction')
      const failed: CompactionRecord = { ...record, status: 'failed', finishedAt: Date.now(), reason: '压缩记录未保存，保留上一次有效上下文。' }
      this.state.compactions[index] = failed
      this.publish({ type: 'compaction', record: failed, running: working })
      if (runtime?.has('session_compact_failed')) await runtime.emit('session_compact_failed',
        { ...boundary, aborted: signal.aborted, ...(!signal.aborted && { errorMessage: failed.reason }) }, ctx(), running.runId)
      throw error
    }
    if (final.status === 'success') this.gateSample = undefined
    this.state.compactions[index] = final
    this.publish({ type: 'compaction', record: final, running: working }, run && this.publicRun(run))
    if (final.status === 'success' && runtime?.has('session_compact')) {
      await runtime.emit('session_compact', { ...boundary, compactionEntry: final }, ctx(), running.runId)
    } else if ((final.status === 'failed' || final.status === 'aborted') && runtime?.has('session_compact_failed')) {
      await runtime.emit('session_compact_failed', { ...boundary, aborted: final.status === 'aborted',
        ...(final.status === 'failed' && { errorMessage: final.reason }) }, ctx(), running.runId)
    }
    return final.status === 'success'
  }

  private endedRun(run: StoredRun, status: RunRecord['status']): StoredRun {
    return { ...run, status, finishedAt: Date.now() }
  }

  private async finish(signal: AbortSignal, status: RunRecord['status'], entry?: ConversationMessage,
    compaction?: Extract<CompactionRecord, { status: 'success' }>) {
    if (this.controller?.signal !== signal) return
    if (this.state.running?.kind === 'task' && signal.aborted) status = 'aborted'
    const current = this.state.runs?.find(run => run.id === this.state.running?.runId)
    const stored = current && this.storedRuns.get(current.clientMessageId)
    let run = stored
    if (stored?.status === 'running') {
      run = this.endedRun(stored, this.failure ? 'failed' : status)
      const followup = entry && this.followup(compaction, entry)
      const data = { run, messages: entry && [entry], compaction: followup }
      const plainAnswer = entry?.message.role === 'assistant' && ['stop', 'length'].includes(entry.message.stopReason)
        && entry.message.content.some(block => block.type === 'text' && block.text.length > 0)
      try {
        try { this.save(data) }
        catch (error) {
          if (!plainAnswer || !(error instanceof SessionWriteError) || error.reason === 'unconfirmed') throw error
          this.save(data)
        }
        if (followup) this.applyFollowup(followup)
      } catch (error) {
        this.noteFailure(error, plainAnswer ? 'answer' : 'finish')
        run = this.endedRun(stored, 'failed')
      }
    }
    this.settling = true
    if (this.runtime?.has('agent_settled') && this.state.running?.kind === 'task') {
      await this.runtime.emit('agent_settled', { aborted: status === 'aborted' || signal.aborted },
        this.extensionContext(this.cwd ?? '', this.model, signal), this.state.running.runId)
    }
    this.controller = undefined
    this.task = undefined
    this.settling = false
    this.state.running = null
    this.publish({ type: 'task', running: null }, run && this.publicRun(run), this.failure)
    this.failure = undefined
  }

  private followup(compaction: Extract<CompactionRecord, { status: 'success' }> | undefined, entry: ConversationMessage) {
    return compaction && compaction.followupMessageId === undefined
      && entry.message.role === 'assistant' && entry.message.usage?.input !== undefined
      ? { ...compaction, followupMessageId: entry.id } : undefined
  }

  private applyFollowup(compaction: Extract<CompactionRecord, { status: 'success' }>) {
    const index = this.state.compactions.findIndex(record => record.id === compaction.id)
    this.state.compactions[index] = compaction
    this.publish({ type: 'compaction', record: compaction, running: this.state.running })
  }

  private publish(change: ConversationUpdate['change'], run?: RunRecord, saveFailure?: SaveFailure, modelSelection?: ModelSelection) {
    if (run) this.state.runs = [...(this.state.runs ?? []).filter(item => item.id !== run.id), run]
    if (saveFailure) this.state.saveFailures = [...this.state.saveFailures ?? [], saveFailure]
    const refresh = change.type !== 'notice' && (change.type !== 'model' || change.event.type === 'done' || change.event.type === 'error' || change.event.type === 'replace')
    if (refresh) this.refreshUsage()
    const update: ConversationUpdate = { seq: ++this.state.seq, change, ...(modelSelection && { modelSelection }), ...(run && { run }), ...(saveFailure && { saveFailure }), ...(refresh && { contextUsage: structuredClone(this.state.contextUsage) }) }
    for (const listener of this.listeners) listener(structuredClone(update))
  }

  private updateTask(running: RunningState, message?: ConversationMessage, messageIndex = this.state.messages.length) {
    this.state.running = running
    const visibleIndex = message ? this.state.messages.slice(0, messageIndex).filter(entry => !entry.extension).length : 0
    if (message) this.state.messages.splice(messageIndex, 0, message)
    this.publish(message ? { type: 'task', running, message, messageIndex: visibleIndex } : { type: 'task', running })
  }

  private async runTask(model: ModelInfo, reasoningEffort: ReasoningEffort | undefined, running: Extract<RunningState, { kind: 'task' }>, cwd: string, tools: CodingTool[], skills: readonly SkillSummary[], signal: AbortSignal, user: ConversationMessage, systemPrompt?: string) {
    let messageId = running.assistantMessageId
    let advanceRound = false
    let recovered = false
    let attemptedInput: string | undefined
    let usedCompaction: ReturnType<typeof this.latestCompaction>
    let activeTools: typeof running.activeTools = []
    let terminalEntry: ConversationMessage | undefined
    let savedToolResult: ConversationMessage | undefined
    let status: RunRecord['status'] = 'failed'

    const runtime = this.runtime
    if (runtime) this.cwd = cwd
    const ctx = () => this.extensionContext(cwd, model, signal)
    const runId = running.runId
    let roundTools = tools
    const configure = (files: ProjectContextFile[]) => {
      roundTools = [...tools, ...runtime?.tools() ?? []]
      if (this.state.permissionMode !== 'normal') roundTools = roundTools.filter(tool => readOnlyTools.has(tool.name))
      this.configure(cwd, roundTools, files, skills)
      if (systemPrompt !== undefined) this.configuration.systemPrompt = systemPrompt
    }
    const modelPhase = () => this.updateTask({ ...running, assistantMessageId: messageId, phase: 'model', activeTools: [] })
    const currentTask = () => ({ ...running, assistantMessageId: messageId, phase: 'tools' as const, activeTools })
    const prepareContext: AgentRunInput['prepareContext'] = async () => {
      if (advanceRound) {
        advanceRound = false
        messageId = randomUUID()
        activeTools = []
        modelPhase()
      }
      const inputBudget = model.contextWindow - model.maxTokens
      let files: ProjectContextFile[]
      try {
        files = await this.loadContextFiles(cwd, model, signal)
      } catch (error) {
        if (error instanceof ProjectContextOverflow) return { error: error.message }
        throw error
      }
      signal.throwIfAborted()
      this.projectContext = { cwd, files }
      configure(files)
      if (this.estimate({ ...this.configuration, messages: [] }) > inputBudget) {
        return { error: files.length ? new ProjectContextOverflow().message : '系统提示和工具定义超出当前模型容量，请切换模型。' }
      }
      const context = this.context()
      const fingerprint = JSON.stringify(context.messages)
      const margin = Math.min(16_384, Math.floor(inputBudget / 8))
      const trigger = Math.min(this.options.compaction?.triggerTokens ?? Infinity, inputBudget - margin)
      if (this.pressure(context, model) < trigger || attemptedInput === fingerprint) return context
      attemptedInput = fingerprint
      return this.compact(model, reasoningEffort, 'auto', { ...running, assistantMessageId: messageId }, signal).then(() => {
        signal.throwIfAborted()
        modelPhase()
        return this.context()
      })
    }

    const finalizeContext: AgentRunInput['finalizeContext'] = () => {
      configure(this.projectContext?.files ?? [])
      const candidate = this.context()
      const withinBudget = (context: ModelContext) => this.pressure(context, model) + model.maxTokens <= model.contextWindow
      const finish = (context: ModelContext) => {
        if (!withinBudget(context)) return { error: capacityError }
        usedCompaction = this.latestCompaction()
        for (const index of omittedToolImageIndexes(context)) {
          const result = context.messages[index]
          if (result.role === 'toolResult' && result.imageResultId !== undefined) this.omittedToolImageResults.add(result.imageResultId)
        }
        return context
      }
      if (!runtime?.has('context')) return finish(candidate)
      return runtime.chain('context', ctx(), candidate.messages, messages => ({ messages }), (_current, event, result) => {
        const messages = result?.messages === undefined ? event.messages : result.messages
        if (!requestMessages(messages) || !withinBudget({ ...candidate, messages })) throw new Error('无效的模型上下文改写')
        return structuredClone(messages)
      }, { runId }).then(messages => finish({ ...candidate, messages }))
    }

    const beforeToolCall: AgentRunInput['beforeToolCall'] = call => {
      if (this.permissionUnconfirmed) return { code: 'permission_denied', message: '权限保存状态未确认，工具未执行。请重启服务后核对。' }
      if (this.state.permissionMode === 'read-only' && !readOnlyTools.has(call.name)) {
        return { code: 'permission_denied', message: '只读模式下未执行此工具。' }
      }
    }

    let preview: Pick<ConversationSnapshot, 'messages' | 'activeContent'> | undefined
    const agent = new Agent({ stream: withModelRetry(this.options.stream ?? stream, retry => {
      preview = { messages: [], activeContent: [] }
      const current = this.state.messages.find(entry => entry.id === messageId)?.message
      const incomplete = current?.role === 'assistant' && current.content.some(block => block.type === 'text' && block.text.trim())
      this.updateTask({ ...running, assistantMessageId: messageId, phase: 'model', activeTools: [],
        retry: { ...retry, ...(incomplete && { incomplete: true }) } })
    }) })
    const unsubscribe = agent.subscribe(event => {
      if (event.type === 'model') {
        const frame = this.frame(event.event)
        let published: ModelFrame = frame
        const terminal = frame.type === 'done' ? frame.message : frame.type === 'error' ? frame.error : undefined
        if (frame.type === 'error' && frame.error.errorCode === 'context_overflow' && recovered) {
          frame.error.errorMessage = capacityError
          frame.error.failure = { kind: 'context-capacity' }
        }
        if (preview) {
          if (frame.type === 'error' && this.state.running?.kind === 'task' && this.state.running.retry?.incomplete) {
            const current = this.state.messages.find(entry => entry.id === messageId)?.message
            if (current?.role === 'assistant') frame.error.content = current.content
          }
          this.apply(messageId, frame, preview)
          if (!terminal && !(frame.type === 'text_delta' && frame.delta.trim())) return
          const message = preview.messages.find(entry => entry.id === messageId)!.message as AssistantMessage
          const replace: ModelFrame = { type: 'replace', runId: running.runId, message, activeContent: preview.activeContent }
          preview = undefined
          this.state.running = { ...running, assistantMessageId: messageId, phase: 'model', activeTools: [] }
          published = replace
          this.apply(messageId, replace)
        } else {
          this.apply(messageId, frame)
        }
        if (terminal?.usage?.input !== undefined) {
          const context = event.context
          this.sample = this.gateSample = {
            key: this.modelKey(model), config: this.configKey(),
            messages: context.messages.map(message => JSON.stringify(message)),
            input: terminal.usage.input, estimate: this.estimate(context),
          }
        }
        this.publish({ type: 'model', messageId, event: published })
        if (terminal) {
          terminalEntry = { id: messageId, message: terminal }
          if (!this.options.persistence) {
            const followup = this.followup(usedCompaction, terminalEntry)
            if (followup) this.applyFollowup(followup)
          }
        }
        if (frame.type === 'done') {
          recovered = false
          advanceRound = true
        }
        return
      }

      const toolCall = { assistantMessageId: messageId, contentIndex: event.contentIndex,
        ...(event.actualArguments && { actualArguments: event.actualArguments }) }
      if (event.type === 'tool_start') {
        activeTools = [...activeTools, toolCall]
        this.updateTask(currentTask())
        return
      }

      activeTools = activeTools.filter(item => item.contentIndex !== event.contentIndex)
      const assistantIndex = this.state.messages.findIndex(entry => entry.id === messageId)
      const preceding = this.state.messages.filter(entry => entry.toolCall?.assistantMessageId === messageId && entry.toolCall.contentIndex < event.contentIndex).length
      this.updateTask(currentTask(), savedToolResult ?? this.toolResult(messageId, event), assistantIndex + 1 + preceding)
      savedToolResult = undefined
    })

    const saveReply = (entry: ConversationMessage) => {
      const followup = this.followup(usedCompaction, entry)
      this.save({ messages: [entry], compaction: followup })
      if (followup) this.applyFollowup(followup)
      terminalEntry = undefined
    }
    const saveToolCheckpoint: AgentRunInput['saveToolCheckpoint'] = checkpoint => {
      if (checkpoint.type === 'assistant') {
        try { saveReply({ id: messageId, message: checkpoint.message }) }
        catch (error) { this.noteFailure(error, 'tool-call'); throw error }
      } else {
        const result = this.toolResult(messageId, checkpoint)
        try { this.save({ messages: [result] }) }
        catch (error) { this.noteFailure(error, 'tool-result', checkpoint.executed ? result.toolCall : undefined); throw error }
        savedToolResult = result
      }
    }
    try {
      const options: Omit<AgentRunInput, 'context'> = {
        model, reasoningEffort, tools, signal, prepareContext, finalizeContext, beforeToolCall,
        resolveTools: () => roundTools, saveToolCheckpoint: this.options.persistence ? saveToolCheckpoint : undefined,
        ...(runtime && {
          observe: <K extends keyof ExtensionEvents>(type: K, event: ExtensionEvents[K]) =>
            runtime.has(type) ? runtime.emit(type, event, ctx(), runId) : undefined,
          ...toolHooks(runtime, ctx, runId),
        }),
      }
      const nextInput = () => ({ ...options, context: this.context(), streamOptions: () => ({
        ...this.providerHooks(ctx, model, runId),
        snapshotPartials: runtime?.has('message_start') || runtime?.has('message_update'),
      }) })
      let result = await agent.run({ ...nextInput(), userMessage: user.message })
      for (;;) {
        while (result.type === 'response' && result.message.stopReason === 'error' && result.message.errorCode === 'context_overflow'
          && !recovered && !signal.aborted) {
          recovered = true
          if (this.options.persistence && terminalEntry) {
            try { saveReply(terminalEntry) }
            catch (error) { this.noteFailure(error, 'finish'); throw error }
          }
          if (!await this.compact(model, reasoningEffort, 'overflow', { ...running, assistantMessageId: messageId }, signal)) {
            if (signal.aborted) {
              status = 'aborted'
              terminalEntry = this.fail(model, randomUUID(), '本次生成已取消', true)
            } else terminalEntry = this.fail(model, randomUUID(), capacityError, false, 'context-capacity')
            return
          }
          signal.throwIfAborted()
          advanceRound = true
          result = await agent.continue(nextInput())
        }
        if (this.failure) { terminalEntry = undefined; return }
        if (result.type === 'failure') {
          status = result.reason === 'aborted' ? 'aborted' : 'failed'
          terminalEntry = this.fail(model, result.afterReply ? randomUUID() : messageId, result.message, status === 'aborted')
        } else {
          status = result.message.stopReason === 'aborted' ? 'aborted' : result.message.stopReason === 'error' ? 'failed' : 'completed'
        }
        if (!runtime?.has('agent_before_settle') || signal.aborted || status === 'aborted') break
        if (this.options.persistence && terminalEntry) {
          try { saveReply(terminalEntry) }
          catch (error) {
            if (status !== 'completed' || !(error instanceof SessionWriteError) || error.reason === 'unconfirmed') {
              this.noteFailure(error, status === 'completed' ? 'answer' : 'finish')
              throw error
            }
            try { saveReply(terminalEntry) }
            catch (retryError) { this.noteFailure(retryError, 'answer'); throw retryError }
          }
        }
        const outcome = status === 'completed' ? 'completed' : 'error'
        if (!await this.beforeSettle(runtime, ctx(), runId, outcome, model)) {
          if (signal.aborted) status = 'aborted'
          break
        }
        advanceRound = true
        recovered = false
        result = await agent.continue(nextInput())
      }
    } catch {
      if (this.failure) { terminalEntry = undefined; return }
      const current = this.state.messages.find(entry => entry.id === messageId)?.message
      if (current?.role === 'assistant' && current.stopReason !== 'pending') messageId = randomUUID()
      status = signal.aborted ? 'aborted' : 'failed'
      terminalEntry = this.fail(model, messageId, signal.aborted ? '本次生成已取消' : '模型调用意外中断，请重新发送', signal.aborted)
    } finally {
      unsubscribe()
      await this.finish(signal, status, terminalEntry, usedCompaction)
    }
  }

  private async beforeSettle(runtime: ExtensionRuntime, ctx: ExtensionContext, runId: string, outcome: 'completed' | 'error', model: ModelInfo) {
    const base = this.context()
    if (!base.messages.length || !requestMessages(base.messages)) return false
    type Entry = ExtensionMessage & { type: 'custom_message' }
    const state = { entries: [] as Entry[], continue: false }
    const timestamp = Date.now()
    const preview = (entries: Entry[]) => {
      const llmMessages = [...base.messages, ...entries.map(entry => ({ role: 'user' as const, content: entry.content, timestamp }))]
      const valid = this.pressure({ ...base, messages: llmMessages }, model) + model.maxTokens <= model.contextWindow
      return { valid, llmMessages, canContinue: valid && llmMessages.at(-1)?.role !== 'assistant' }
    }
    if (!preview([]).valid) return false
    const decision = await runtime.chain('agent_before_settle', ctx, state, current => {
      const { llmMessages, canContinue } = preview(current.entries)
      return { outcome, ...current, context: { llmMessages, canContinue } }
    }, (current, _event, next) => {
      if (!next) return current
      if (next.continue !== undefined && typeof next.continue !== 'boolean'
        || next.entries !== undefined && (!Array.isArray(next.entries)
          || !next.entries.every(entry => object(entry) && entry.type === 'custom_message' && extensionMessage(entry)))) {
        throw new Error('无效的任务续跑建议')
      }
      const entries = next.entries ?? current.entries
      if (!preview(entries).valid) throw new Error('扩展追加指令超出当前模型容量')
      return { entries: structuredClone(entries), continue: next.continue ?? current.continue }
    }, { runId })
    if (ctx.signal?.aborted) return false
    const extra = decision.entries.map(({ type: _type, ...entry }) => this.extensionEntry(entry))
    if (extra.length) {
      try { this.save({ messages: extra }) }
      catch (error) { this.noteFailure(error, 'finish'); throw error }
      this.state.messages.push(...extra)
    }
    return decision.continue && preview(decision.entries).canContinue
  }

  private toolResult(messageId: string, event: Extract<AgentEvent, { type: 'tool_result' }>): ConversationMessage {
    const fileOperation = event.details.find(isFileOperation)
    return {
      id: randomUUID(), toolCall: { assistantMessageId: messageId, contentIndex: event.contentIndex,
        ...(event.actualArguments && { actualArguments: event.actualArguments }) }, message: event.result,
      ...(event.result.isError && (event.errorCode === 'interrupted' || event.errorCode === 'permission_denied' || event.errorCode === 'hook_blocked') && { toolErrorCode: event.errorCode }),
      ...(fileOperation && { fileOperation }),
    }
  }

  private fail(model: ModelInfo, messageId: string, errorMessage: string, aborted = false, kind?: NonNullable<AssistantMessage['failure']>['kind']) {
    const current = this.state.messages.find(entry => entry.id === messageId)?.message
    const reason = aborted ? 'aborted' : 'error'
    const error: AssistantMessage = {
      ...(current?.role === 'assistant'
        ? current
        : { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now() }),
      stopReason: reason, errorMessage, ...(kind && { failure: { kind } }),
    }
    const event: ModelFrame = { type: 'error', reason, error }
    this.apply(messageId, event)
    this.publish({ type: 'model', messageId, event })
    return { id: messageId, message: error }
  }

  private frame(event: ModelEvent): ModelFrame {
    if (event.type === 'start') {
      const { role, api, provider, model, timestamp } = event.partial
      return { type: 'start', initial: { role, api, provider, model, timestamp } }
    }
    if (event.type === 'done' || event.type === 'error') return structuredClone(event)
    const { partial: _partial, ...frame } = event
    return structuredClone(frame)
  }

  private apply(messageId: string, event: ModelFrame, view: Pick<ConversationSnapshot, 'messages' | 'activeContent'> = this.state) {
    if (event.type === 'start') {
      view.messages.push({ id: messageId, message: { ...event.initial, content: [], stopReason: 'pending' } })
      return
    }
    if (event.type === 'done' || event.type === 'error' || event.type === 'replace') {
      const message = structuredClone(event.type === 'error' ? event.error : event.message)
      const current = view.messages.find(entry => entry.id === messageId)
      if (current) current.message = message
      else view.messages.push({ id: messageId, message })
      view.activeContent = event.type === 'replace' ? structuredClone(event.activeContent) : []
      return
    }
    const message = view.messages.find(entry => entry.id === messageId)?.message
    if (message?.role !== 'assistant') throw new Error('Missing assistant start')
    const block = message.content[event.contentIndex]
    switch (event.type) {
      case 'text_start':
        message.content[event.contentIndex] = { type: 'text', text: '' }
        view.activeContent.push({ messageId, contentIndex: event.contentIndex, type: 'text' })
        break
      case 'thinking_start':
        message.content[event.contentIndex] = { type: 'thinking', thinking: '' }
        view.activeContent.push({ messageId, contentIndex: event.contentIndex, type: 'thinking' })
        break
      case 'toolcall_start':
        message.content[event.contentIndex] = { type: 'toolCall', id: '', name: '', arguments: {} }
        view.activeContent.push({ messageId, contentIndex: event.contentIndex, type: 'toolCall', argumentsText: '' })
        break
      case 'text_delta':
        if (block?.type !== 'text') throw new Error('Missing text block')
        block.text += event.delta
        break
      case 'thinking_delta':
        if (block?.type !== 'thinking') throw new Error('Missing thinking block')
        block.thinking += event.delta
        break
      case 'toolcall_delta': {
        const active = view.activeContent.find(entry => entry.messageId === messageId && entry.contentIndex === event.contentIndex)
        if (active?.type !== 'toolCall') throw new Error('Missing tool block')
        active.argumentsText += event.delta
        break
      }
      case 'text_end': message.content[event.contentIndex] = { type: 'text', text: event.content }; break
      case 'thinking_end': message.content[event.contentIndex] = { type: 'thinking', thinking: event.content }; break
      case 'toolcall_end': message.content[event.contentIndex] = structuredClone(event.toolCall); break
    }
    if (event.type === 'text_end' || event.type === 'thinking_end' || event.type === 'toolcall_end') {
      view.activeContent = view.activeContent.filter(entry => entry.messageId !== messageId || entry.contentIndex !== event.contentIndex)
    }
  }

  subscribe(signal: AbortSignal): AsyncIterableIterator<SessionSubscriptionEvent, undefined> {
    const done: IteratorReturnResult<undefined> = { done: true, value: undefined }
    if (this.options.persistence?.history) void this.initialize()?.catch(() => undefined)
    const queue: SessionSubscriptionEvent[] = []
    const waiting: ((result: IteratorResult<SessionSubscriptionEvent, undefined>) => void)[] = []
    let closed = signal.aborted
    const receive = (update: ConversationUpdate) => {
      const event: SessionSubscriptionEvent = { type: 'update', update }
      const resolve = waiting.shift()
      if (resolve) resolve({ done: false, value: event })
      else queue.push(event)
    }
    const close = () => {
      closed = true
      this.listeners.delete(receive)
      signal.removeEventListener('abort', close)
      queue.length = 0
      for (const resolve of waiting.splice(0)) resolve(done)
    }
    if (!closed) {
      this.listeners.add(receive)
      queue.push({ type: 'snapshot', snapshot: structuredClone({ ...this.state, messages: this.state.messages.filter(message => !message.extension) }) })
      signal.addEventListener('abort', close, { once: true })
    }
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (closed) return Promise.resolve(done)
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift()! })
        return new Promise(resolve => waiting.push(resolve))
      },
      return() { close(); return Promise.resolve(done) },
    }
  }

  async abort(runId: string): Promise<boolean> {
    if (this.state.running?.runId !== runId) return false
    const controller = this.controller
    if (!controller) return false
    const task = this.task
    if (!this.settling) controller.abort()
    const aborted = controller.signal.aborted
    await task
    return aborted
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.initializing?.abort()
    this.preparing?.abort()
    if (!this.settling) this.controller?.abort()
    const task = this.task
    return this.closing = (async () => {
      await Promise.allSettled([this.initialization, this.submitting?.settled, ...this.selectionNotifications])
      await task
      if (this.cwd && this.runtime?.has('session_shutdown')) {
        await this.runtime.emit('session_shutdown', { reason: 'quit' }, this.extensionContext(this.cwd, this.model))
      }
    })()
  }
}
