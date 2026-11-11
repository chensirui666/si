import { randomUUID } from 'node:crypto'
import { Agent } from '@agent-learning/agent'
import type { AgentEvent, AgentRunInput } from '@agent-learning/agent'
import { estimateContextTokens, findModel, stream } from '@agent-learning/model'
import type { AssistantMessage, ModelContext, ModelEvent, ModelInfo } from '@agent-learning/model'
import { buildModelHistory, createSummaryContext, prepareCompaction } from './compaction.js'
import { loadProjectContextFiles, ProjectContextOverflow, type ProjectContextFile } from './project-context.js'
import { SessionWriteError, submissionReceipt, type SessionPersistence, type StoredRun } from './session-store.js'
import { buildSystemPrompt } from './system-prompt.js'
import type { CodingTool } from './tools.js'
import type { CompactionRecord, SubmissionAccepted, SessionSubscriptionEvent, ConversationMessage, ConversationSnapshot, ConversationUpdate, ModelFrame, RunRecord, RunningState, SaveFailure } from './types.js'

export class SessionSubmitError extends Error {
  constructor(readonly code: 'invalid' | 'busy' | 'closed', message: string) { super(message) }
}

function isFileOperation(detail: unknown): detail is NonNullable<ConversationMessage['fileOperation']> {
  return detail !== null && typeof detail === 'object' && 'kind' in detail && 'path' in detail
    && (detail.kind === 'read' || detail.kind === 'modified') && typeof detail.path === 'string'
}

export class AgentSession {
  private readonly agent: Agent
  private readonly state: ConversationSnapshot = { seq: 0, messages: [], running: null, activeContent: [], compactions: [], contextUsage: null }
  private readonly listeners = new Set<(update: ConversationUpdate) => void>()
  private controller?: AbortController
  private task?: Promise<void>
  private closed = false
  private model?: ModelInfo
  private configuration: Omit<ModelContext, 'messages'> = {}
  private projectContext?: { cwd: string; files: ProjectContextFile[] }
  private sample?: { modelId: string; config: string; messages: string[]; input: number; estimate: number }
  private gateSample?: typeof this.sample
  private readonly storedRuns = new Map<string, StoredRun>()
  private readonly savedMessages = new Set<string>()
  private failure?: SaveFailure

  constructor(private readonly options: {
    persistence?: SessionPersistence
    stream?: typeof stream
    tools?: (cwd: string) => CodingTool[]
    documentationRoot?: string
    globalContextDirectory?: string
    resolveDirectory: () => Promise<string>
    compaction?: { triggerTokens: number; keepRecentTokens: number }
  }) {
    this.agent = new Agent({ stream: options.stream })
    const history = options.persistence?.history
    if (history) {
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

  async submit(input: { clientMessageId: string; modelId: string; text: string }): Promise<SubmissionAccepted> {
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    const model = typeof input?.modelId === 'string' ? findModel(input.modelId) : undefined
    if (!model || typeof input.text !== 'string' || !input.text.trim()
      || typeof input.clientMessageId !== 'string' || !input.clientMessageId.trim() || input.clientMessageId.length > 128) {
      throw new SessionSubmitError('invalid', '请提交有效原文、支持的模型和临时编号')
    }
    const previous = this.replay(input)
    if (previous) return previous
    const cwd = await this.options.resolveDirectory()
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    const concurrent = this.replay(input)
    if (concurrent) return concurrent
    if (this.state.running) throw new SessionSubmitError('busy', '正在生成，请等待本次回答结束')
    this.model = model
    const tools = this.options.tools?.(cwd) ?? []
    const declarations = tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
    this.configuration = {
      systemPrompt: buildSystemPrompt(cwd, tools, this.options.documentationRoot, this.projectContext?.cwd === cwd ? this.projectContext.files : []),
      ...(declarations.length ? { tools: declarations } : {}),
    }
    const controller = new AbortController()
    if (input.text.trim() === '/compact') {
      const record = this.newCompaction('manual', input.clientMessageId)
      const running = { kind: 'compaction' as const, runId: record.id, phase: 'compaction' as const }
      const run = this.saveStart(input, record.id, 'compaction', { compaction: record })
      this.controller = controller
      this.state.compactions.push(record)
      this.state.running = running
      this.publish({ type: 'compaction', record, running }, run && this.publicRun(run))
      const acceptedSeq = this.state.seq
      this.task = Promise.resolve().then(async () => {
        let status: RunRecord['status'] = 'failed'
        try {
          await this.compact(model, 'manual', running, controller.signal, record)
          status = this.storedRuns.get(input.clientMessageId)?.status ?? 'completed'
        } catch (error) {
          if (!(error instanceof SessionWriteError)) throw error
        } finally { this.finish(controller.signal, status) }
      })
      return { kind: 'compaction', clientMessageId: input.clientMessageId, compactionId: record.id, acceptedSeq }
    }
    const user = { id: randomUUID(), clientMessageId: input.clientMessageId, message: { role: 'user' as const, content: input.text, timestamp: Date.now() } }
    const running = { kind: 'task' as const, runId: user.id, assistantMessageId: randomUUID(), phase: 'model' as const, activeTools: [] }
    const run = this.saveStart(input, user.id, 'task', { messages: [user] })
    this.controller = controller
    this.state.messages.push(user)
    this.state.running = running
    this.publish({ type: 'accepted', user, running }, run && this.publicRun(run))
    const acceptedSeq = this.state.seq
    this.task = Promise.resolve().then(() => this.runTask(model, running, cwd, tools, controller.signal))
    return { kind: 'message', clientMessageId: input.clientMessageId, userMessageId: user.id, acceptedSeq }
  }

  private replay(input: { clientMessageId: string; text: string; modelId: string }) {
    const previous = this.storedRuns.get(input.clientMessageId)
    if (!previous) return
    if (previous.text !== input.text || previous.modelId !== input.modelId) {
      throw new SessionSubmitError('busy', '此提交编号已用于另一条消息')
    }
    return submissionReceipt(previous)
  }

  private publicRun({ text: _text, acceptedSeq: _acceptedSeq, ...run }: StoredRun): RunRecord {
    return run
  }

  private saveStart(input: { clientMessageId: string; text: string; modelId: string }, id: string, kind: RunRecord['kind'],
    data: { messages?: ConversationMessage[]; compaction?: CompactionRecord }) {
    const storage = this.options.persistence
    if (!storage) return
    const run: StoredRun = {
      ...input, id, kind, sessionId: storage.summary.id, status: 'running', startedAt: Date.now(), acceptedSeq: this.state.seq + 1,
    }
    this.save({ ...data, run, summary: this.storedRuns.size === 0 ? storage.first?.() : undefined })
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

  private context(): ModelContext {
    return { ...this.configuration, messages: buildModelHistory(this.historyMessages(), this.latestCompaction(), !!this.options.persistence) }
  }

  private estimate(context: ModelContext) {
    const estimate = estimateContextTokens(context)
    return estimate.systemTokens + estimate.toolsTokens + estimate.messageTokens
  }

  private configKey() { return JSON.stringify(this.configuration) }

  private pressure(context: ModelContext, model: ModelInfo) {
    const estimate = this.estimate(context), sample = this.gateSample
    if (sample && sample.modelId === model.id && sample.config === this.configKey()
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
      tokens: sample?.modelId === this.model.id && sample.config === this.configKey()
        ? Math.max(0, sample.input + estimate - sample.estimate) : estimate,
      contextWindow: this.model.contextWindow, breakdown: estimateContextTokens(context),
    }
  }

  private newCompaction(trigger: CompactionRecord['trigger'], clientMessageId?: string): CompactionRecord {
    const record: CompactionRecord = { id: randomUUID(), trigger, status: 'running', startedAt: Date.now(), ...(clientMessageId && { clientMessageId }) }
    return record
  }

  private async compact(model: ModelInfo, trigger: CompactionRecord['trigger'], running: NonNullable<RunningState>, signal: AbortSignal, initial?: CompactionRecord) {
    const record = initial ?? this.newCompaction(trigger)
    const working: NonNullable<RunningState> = { ...running, phase: 'compaction' }
    this.state.running = working
    if (!initial) {
      try { this.save({ compaction: record }) }
      catch (error) { this.noteFailure(error, 'compaction'); throw error }
      this.state.compactions.push(record)
      this.publish({ type: 'compaction', record, running: working })
    }
    let final: CompactionRecord
    let summaryUsage: AssistantMessage['usage']
    try {
      signal.throwIfAborted()
      const preparation = prepareCompaction(this.historyMessages(), this.latestCompaction(), this.options.compaction?.keepRecentTokens ?? 20_000, Boolean(this.configuration.tools?.length), !!this.options.persistence)
      if (preparation.status === 'skipped') {
        final = { ...record, status: 'skipped', finishedAt: Date.now(), reason: preparation.reason === 'already_compacted' ? '刚压缩完成，尚无新内容。' : '没有可压缩的较早内容。' }
      } else {
        const context = createSummaryContext(preparation)
        if (this.estimate(context) + model.maxTokens > model.contextWindow) throw new Error('摘要请求预计超出模型容量。')
        let terminal: AssistantMessage | undefined
        try {
          for await (const event of (this.options.stream ?? stream)(model, context, { signal })) {
            if (event.type === 'done' || event.type === 'error') { terminal = structuredClone(event.type === 'done' ? event.message : event.error); break }
          }
        } catch (error) { if (!terminal) throw error }
        summaryUsage = terminal?.usage
        signal.throwIfAborted()
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
        const next = { ...this.configuration, messages: buildModelHistory(this.historyMessages(), candidate, !!this.options.persistence) }
        candidate.estimatedAfter = this.estimate(next)
        if (candidate.estimatedAfter >= candidate.estimatedBefore) throw new Error('摘要未有效缩短输入，保留原上下文。')
        if (candidate.estimatedAfter + model.maxTokens > model.contextWindow) throw new Error('压缩后仍预计超出模型容量，保留原上下文。')
        signal.throwIfAborted()
        final = candidate
      }
    } catch (error) {
      final = { ...record, status: signal.aborted ? 'aborted' : 'failed', finishedAt: Date.now(),
        reason: signal.aborted ? '本次压缩已停止。' : error instanceof Error && ['摘要请求预计超出模型容量。', '摘要生成未完整完成，保留原上下文。', '摘要为空，保留原上下文。', '摘要未有效缩短输入，保留原上下文。', '压缩后仍预计超出模型容量，保留原上下文。'].includes(error.message) ? error.message : '摘要生成失败，保留原上下文。',
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
      throw error
    }
    if (final.status === 'success') this.gateSample = undefined
    this.state.compactions[index] = final
    this.publish({ type: 'compaction', record: final, running: working }, run && this.publicRun(run))
    return final.status === 'success'
  }

  private endedRun(run: StoredRun, status: RunRecord['status']): StoredRun {
    return { ...run, status, finishedAt: Date.now() }
  }

  private finish(signal: AbortSignal, status: RunRecord['status'], entry?: ConversationMessage,
    compaction?: Extract<CompactionRecord, { status: 'success' }>) {
    if (this.controller?.signal !== signal) return
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
    this.controller = undefined
    this.task = undefined
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

  private publish(change: ConversationUpdate['change'], run?: RunRecord, saveFailure?: SaveFailure) {
    if (run) this.state.runs = [...(this.state.runs ?? []).filter(item => item.id !== run.id), run]
    if (saveFailure) this.state.saveFailures = [...this.state.saveFailures ?? [], saveFailure]
    const refresh = change.type !== 'model' || change.event.type === 'done' || change.event.type === 'error'
    if (refresh) this.refreshUsage()
    const update: ConversationUpdate = { seq: ++this.state.seq, change, ...(run && { run }), ...(saveFailure && { saveFailure }), ...(refresh && { contextUsage: structuredClone(this.state.contextUsage) }) }
    for (const listener of this.listeners) listener(structuredClone(update))
  }

  private updateTask(running: RunningState, message?: ConversationMessage, messageIndex = this.state.messages.length) {
    this.state.running = running
    if (message) this.state.messages.splice(messageIndex, 0, message)
    this.publish(message ? { type: 'task', running, message, messageIndex } : { type: 'task', running })
  }

  private async runTask(model: ModelInfo, running: Extract<RunningState, { kind: 'task' }>, cwd: string, tools: CodingTool[], signal: AbortSignal) {
    let messageId = running.assistantMessageId
    let advanceRound = false
    let recovered = false
    let attemptedInput: string | undefined
    let usedCompaction: ReturnType<typeof this.latestCompaction>
    let activeTools: typeof running.activeTools = []
    let terminalEntry: ConversationMessage | undefined
    let savedToolResult: ConversationMessage | undefined
    let status: RunRecord['status'] = 'failed'

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
        files = await loadProjectContextFiles({
          cwd, globalDirectory: this.options.globalContextDirectory, signal,
          // The estimator allows four UTF-16 units per token, each using at most three UTF-8 bytes.
          maxBytes: inputBudget * 12,
        })
      } catch (error) {
        if (error instanceof ProjectContextOverflow) return { error: error.message }
        throw error
      }
      signal.throwIfAborted()
      const systemPrompt = buildSystemPrompt(cwd, tools, this.options.documentationRoot, files)
      const configuration = { ...this.configuration, systemPrompt }
      if (files.length && this.estimate({ ...configuration, messages: [] }) > inputBudget) {
        return { error: new ProjectContextOverflow().message }
      }
      this.projectContext = { cwd, files }
      this.configuration = configuration
      const context = this.context()
      const ready = (candidate: ModelContext) => {
        if (this.pressure(candidate, model) + model.maxTokens > model.contextWindow) {
          return { error: '当前输入与回复预留预计超出模型容量，请缩短输入或压缩对话。' }
        }
        usedCompaction = this.latestCompaction()
        return candidate
      }
      const fingerprint = JSON.stringify(context.messages)
      const trigger = this.options.compaction?.triggerTokens ?? model.contextWindow - model.maxTokens - 16_384
      if (this.pressure(context, model) < trigger || attemptedInput === fingerprint) return ready(context)
      attemptedInput = fingerprint
      return this.compact(model, 'auto', { ...running, assistantMessageId: messageId }, signal).then(() => {
        signal.throwIfAborted()
        modelPhase()
        return ready(this.context())
      })
    }

    const unsubscribe = this.agent.subscribe(event => {
      if (event.type === 'model') {
        const frame = this.frame(event.event)
        this.apply(messageId, frame)
        const terminal = frame.type === 'done' ? frame.message : frame.type === 'error' ? frame.error : undefined
        if (terminal?.usage?.input !== undefined) {
          const context = event.context
          this.sample = this.gateSample = {
            modelId: model.id, config: this.configKey(),
            messages: context.messages.map(message => JSON.stringify(message)),
            input: terminal.usage.input, estimate: this.estimate(context),
          }
        }
        this.publish({ type: 'model', messageId, event: frame })
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

      const toolCall = { assistantMessageId: messageId, contentIndex: event.contentIndex }
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
      const options = { model, tools, signal, prepareContext, saveToolCheckpoint: this.options.persistence ? saveToolCheckpoint : undefined }
      let result = await this.agent.run({ ...options, context: this.context() })
      while (result.type === 'response' && result.message.stopReason === 'error' && result.message.errorCode === 'context_overflow'
        && !recovered && !signal.aborted) {
        recovered = true
        if (this.options.persistence && terminalEntry) {
          try { saveReply(terminalEntry) }
          catch (error) { this.noteFailure(error, 'finish'); throw error }
        }
        if (!await this.compact(model, 'overflow', { ...running, assistantMessageId: messageId }, signal)) {
          if (signal.aborted) status = 'aborted'
          return
        }
        signal.throwIfAborted()
        advanceRound = true
        result = await this.agent.continue({ ...options, context: this.context() })
      }
      if (this.failure) { terminalEntry = undefined; return }
      if (result.type === 'failure') {
        status = result.reason === 'aborted' ? 'aborted' : 'failed'
        terminalEntry = this.fail(model, result.afterReply ? randomUUID() : messageId, result.message, status === 'aborted')
      } else {
        status = result.message.stopReason === 'aborted' ? 'aborted' : result.message.stopReason === 'error' ? 'failed' : 'completed'
      }
    } catch {
      if (this.failure) { terminalEntry = undefined; return }
      const current = this.state.messages.find(entry => entry.id === messageId)?.message
      if (current?.role === 'assistant' && current.stopReason !== 'pending') messageId = randomUUID()
      status = signal.aborted ? 'aborted' : 'failed'
      terminalEntry = this.fail(model, messageId, signal.aborted ? '本次生成已取消' : '模型调用意外中断，请重新发送', signal.aborted)
    } finally {
      unsubscribe()
      this.finish(signal, status, terminalEntry, usedCompaction)
    }
  }

  private toolResult(messageId: string, event: Extract<AgentEvent, { type: 'tool_result' }>): ConversationMessage {
    const fileOperation = event.details.find(isFileOperation)
    return {
      id: randomUUID(), toolCall: { assistantMessageId: messageId, contentIndex: event.contentIndex }, message: event.result,
      ...(event.errorCode === 'interrupted' && { toolErrorCode: event.errorCode }),
      ...(fileOperation && { fileOperation }),
    }
  }

  private fail(model: ModelInfo, messageId: string, errorMessage: string, aborted = false) {
    const current = this.state.messages.find(entry => entry.id === messageId)?.message
    const reason = aborted ? 'aborted' : 'error'
    const error: AssistantMessage = {
      ...(current?.role === 'assistant'
        ? current
        : { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now() }),
      stopReason: reason, errorMessage,
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

  private apply(messageId: string, event: ModelFrame) {
    if (event.type === 'start') {
      this.state.messages.push({ id: messageId, message: { ...event.initial, content: [], stopReason: 'pending' } })
      return
    }
    if (event.type === 'done' || event.type === 'error') {
      const message = structuredClone(event.type === 'done' ? event.message : event.error)
      const current = this.state.messages.find(entry => entry.id === messageId)
      if (current) current.message = message
      else this.state.messages.push({ id: messageId, message })
      this.state.activeContent = []
      return
    }
    const message = this.state.messages.find(entry => entry.id === messageId)?.message
    if (message?.role !== 'assistant') throw new Error('Missing assistant start')
    const block = message.content[event.contentIndex]
    switch (event.type) {
      case 'text_start':
        message.content[event.contentIndex] = { type: 'text', text: '' }
        this.state.activeContent.push({ messageId, contentIndex: event.contentIndex, type: 'text' })
        break
      case 'thinking_start':
        message.content[event.contentIndex] = { type: 'thinking', thinking: '' }
        this.state.activeContent.push({ messageId, contentIndex: event.contentIndex, type: 'thinking' })
        break
      case 'toolcall_start':
        message.content[event.contentIndex] = { type: 'toolCall', id: '', name: '', arguments: {} }
        this.state.activeContent.push({ messageId, contentIndex: event.contentIndex, type: 'toolCall', argumentsText: '' })
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
        const active = this.state.activeContent.find(entry => entry.messageId === messageId && entry.contentIndex === event.contentIndex)
        if (active?.type !== 'toolCall') throw new Error('Missing tool block')
        active.argumentsText += event.delta
        break
      }
      case 'text_end': message.content[event.contentIndex] = { type: 'text', text: event.content }; break
      case 'thinking_end': message.content[event.contentIndex] = { type: 'thinking', thinking: event.content }; break
      case 'toolcall_end': message.content[event.contentIndex] = structuredClone(event.toolCall); break
    }
    if (event.type === 'text_end' || event.type === 'thinking_end' || event.type === 'toolcall_end') {
      this.state.activeContent = this.state.activeContent.filter(entry => entry.messageId !== messageId || entry.contentIndex !== event.contentIndex)
    }
  }

  subscribe(signal: AbortSignal): AsyncIterableIterator<SessionSubscriptionEvent, undefined> {
    const done: IteratorReturnResult<undefined> = { done: true, value: undefined }
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
      queue.push({ type: 'snapshot', snapshot: structuredClone(this.state) })
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
    const task = this.task
    controller?.abort()
    await task
    return true
  }

  async close(): Promise<void> {
    this.closed = true
    this.controller?.abort()
    await this.task
  }
}
