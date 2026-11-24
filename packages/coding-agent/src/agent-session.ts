import { randomUUID } from 'node:crypto'
import { Agent } from '@agent-learning/agent'
import type { AgentEvent, AgentRunInput } from '@agent-learning/agent'
import { IMAGE_BUDGET_BYTES, estimateContextTokens, findModel, omittedToolImageIndexes, sameSelection, stream } from '@agent-learning/model'
import type { AssistantMessage, JsonObject, ModelContext, ModelDiscovery, ModelEvent, ModelInfo, ModelSelection, ModelStreamOptions, ReasoningEffort } from '@agent-learning/model'
import { buildModelHistory, createSummaryContext, prepareCompaction } from './compaction.js'
import { loadProjectContextFiles, ProjectContextOverflow, type ProjectContextFile } from './project-context.js'
import { SessionWriteError, runSelection, submissionReceipt, type SessionPersistence, type StoredRun } from './session-store.js'
import { discoverSkills, loadSkill, skillCommand, type SkillSummary } from './skills.js'
import { withModelRetry } from './model-retry.js'
import { extractPlan, planCommandArgument, planGitArgs, planInstruction, planReadTools } from './plan-mode.js'
import { buildSystemPrompt } from './system-prompt.js'
import { defaultTools, protectMemoryRead, type CodingTool } from './tools.js'
import { createMemoryTool, MEMORY_TOOL_NAME } from './memory-tool.js'
import { createMemorySourceTool, MEMORY_SOURCE_TOOL_NAME } from './memory-source-tool.js'
import { formatMemoryInstructions, formatProjectMemory, formatUserMemory, formatUserMemoryTargets } from './memory-prompt.js'
import { projectMemoryLines, type MemoryProject, type MemoryStore, type ProjectMemory, type UserMemory } from './memory-store.js'
import { beforeStart, requestMessages, toolHooks } from './extensions/dispatch.js'
import { ExtensionRuntime, extensionMessage, object, type ExtensionContext, type ExtensionEntry, type ExtensionEvents, type ExtensionMessage } from './extensions/runtime.js'
import { isPermissionMode, type PermissionMode } from './permissions.js'
import { access } from 'node:fs/promises'
import { ATTACHMENT_TTL_MS, type AttachmentScope, type SessionAttachments } from './session-attachments.js'
import { ReferenceInputError, prepareSessionReferences, removeReferenceSnapshots } from './session-references.js'
import { generateSessionTitle, temporarySessionTitle } from './session-title.js'
import type { McpToolIdentity } from './mcp/manager.js'
import { createMcpToolSearch, isMcpToolSearchDetails, MCP_TOOL_SEARCH_NAME } from './mcp/tool-search.js'
import { createMcpTools, mcpToolIdentity, mcpToolKey, type McpToolSource } from './mcp/tools.js'
import { createCronjobTool, CRONJOB_TOOL_NAME, type ManageSchedule } from './cronjob-tool.js'
import type { InteractionState, PendingSubmission, QuestionAnswer, QuestionReply, QuestionWaitSettings, QueueAction, QueueResult, SubmissionPending, UserQuestion, UserQuestionBatch } from './collaboration.js'
import { ASK_USER_QUESTION_TOOL_NAME, createUserQuestionTool, validateQuestionAnswers } from './user-question-tool.js'
import { sameSubmissionSources, type SubmissionInput } from './types.js'
import type { CompactionRecord, ExtensionNotice, SubmissionAccepted, SubmissionHandled, SessionSubscriptionEvent, ConversationMessage, ConversationSnapshot, ConversationUpdate, ModelFrame, PlanState, RunRecord, RunningState, SaveFailure } from './types.js'

type SubmissionResult = SubmissionAccepted | SubmissionHandled
type AvailableTools = { local: CodingTool[]; remote?: CodingTool[]; servers?: ReturnType<McpToolSource['listDiscoveryServers']> }
type MemorySettings = { enabled: boolean; generation: number }

type QuestionWaiter = {
  batch: UserQuestionBatch
  outcome?: UserQuestionBatch
  settle(status: 'answered' | 'timed-out' | 'aborted', answers?: QuestionAnswer[], replyId?: string): void
  persisted: Promise<boolean>
  confirm(saved: boolean): void
}

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
  private submitting?: { input: SubmissionInput; scheduled: boolean; settled: Promise<SubmissionResult> }
  private preparing?: AbortController
  private readonly pending = new Map<string, PendingSubmission>()
  private readonly questions = new Map<string, UserQuestionBatch>()
  private readonly questionWaiters = new Map<string, QuestionWaiter>()
  private queueFrozen = false
  private queuePaused: string | null = null
  private startingPendingId?: string
  private resumeAfterAbort = false
  private steeringBoundaryClosed = false
  private initialization?: Promise<void>
  private initializing?: AbortController
  private closing?: Promise<void>
  private readonly runtime?: ExtensionRuntime
  private readonly sessionId: string
  private cwd?: string
  private readonly handled = new Map<string, { input: SubmissionInput; result: SubmissionHandled }>()
  private readonly approvedPlans = new Map<string, SubmissionAccepted>()
  private readonly selectionNotifications = new Set<Promise<void>>()
  private titleRequest?: { controller: AbortController; pending: Promise<void> }
  private readonly omittedToolImageResults = new Set<string>()
  private readonly state: ConversationSnapshot = { seq: 0, permissionMode: 'normal', messages: [], running: null, activeContent: [], compactions: [], contextUsage: null }
  private readonly listeners = new Set<(update: ConversationUpdate) => void>()
  private controller?: AbortController
  private task?: Promise<void>
  private settling = false
  private closed = false
  private model?: ModelInfo
  private configuration: Omit<ModelContext, 'messages'> = {}
  private configurationKeyBeforeMemory?: string
  private projectContext?: { cwd: string; files: ProjectContextFile[] }
  private memoryEnabled = false
  private memoryUser?: { generation: number; document: UserMemory }
  private sample?: { key: string; config: string; messages: string[]; input: number; estimate: number }
  private gateSample?: typeof this.sample
  private readonly storedRuns = new Map<string, StoredRun>()
  private readonly savedMessages = new Set<string>()
  private readonly loadedMcpTools = new Map<string, McpToolIdentity>()
  private readonly unsubscribeMcpCatalog?: () => void
  private failure?: SaveFailure
  private permissionUnconfirmed = false

  constructor(private readonly options: {
    persistence?: SessionPersistence
    sessionId?: string
    extensions?: readonly ExtensionEntry[]
    reportExtensionError?: (message: string, error: unknown) => void
    permissionMode?: PermissionMode
    stream?: typeof stream
    titleStream?: typeof stream
    onTitleChanged?: () => void
    onScheduledRunFinished?: (id: string) => void
    manageSchedule?: ManageSchedule
    questionWait?: () => Promise<QuestionWaitSettings>
    attachments?: SessionAttachments
    referenceDirectory?: string
    isWorkspaceRegistered?: (id: string) => Promise<boolean>
    resolveWorkspaceDirectory?: (id: string) => Promise<string>
    tools?: (cwd: string) => CodingTool[]
    mcp?: McpToolSource
    documentationRoot?: string
    skillHome?: string
    globalContextDirectory?: string
    resolveDirectory: () => Promise<string>
    discoverModels?: typeof import('@agent-learning/model').discoverModels
    compaction?: { triggerTokens: number; keepRecentTokens: number }
    memory?: { store: MemoryStore; settings: () => Promise<MemorySettings> }
  }) {
    this.sessionId = options.persistence?.summary.id ?? options.sessionId ?? randomUUID()
    if (options.extensions?.length) this.runtime = new ExtensionRuntime(options.extensions, options.reportExtensionError)
    const history = options.persistence?.history
    this.state.permissionMode = history?.permissionMode ?? options.permissionMode ?? 'normal'
    if (history) {
      const last = history.runs.at(-1)
      if (history.plan) this.state.plan = history.plan
      this.state.modelSelection = history.modelSelection ?? (last && runSelection(last))
      this.state.messages = history.messages
      this.state.compactions = history.compactions.map(record => record.status === 'running'
        ? { ...record, status: 'interrupted', finishedAt: Date.now(), reason: '服务中断，压缩未完成。' } : record)
      for (const entry of history.messages) this.savedMessages.add(entry.id)
      for (const input of history.planCommands ?? []) {
        this.handled.set(input.clientMessageId, { input, result: { kind: 'handled', clientMessageId: input.clientMessageId, notices: [] } })
      }
      for (const run of history.runs) {
        this.storedRuns.set(run.clientMessageId, run)
        if (run.approvedPlanId) this.approvedPlans.set(run.approvedPlanId, submissionReceipt(run))
      }
      this.state.seq = history.runs.at(-1)?.acceptedSeq ?? 0
      for (const item of history.pending ?? []) {
        this.pending.set(item.input.clientMessageId, item)
        this.state.seq = Math.max(this.state.seq, item.acceptedSeq, item.steeringSeq ?? 0, item.receipt && 'acceptedSeq' in item.receipt ? item.receipt.acceptedSeq : 0)
      }
      for (const batch of history.questions ?? []) this.questions.set(batch.id, batch.status === 'waiting' ? { ...batch, status: 'aborted' } : batch)
      if (this.queued().length || this.pendingSteering().length) this.queuePaused = '服务已恢复。发送新消息后继续待发消息。'
      if (this.pending.size || this.questions.size) this.state.interaction = this.interactionView()
      if (history.runs.length) this.state.runs = history.runs.map(run => ({
        ...this.publicRun(run), restored: true, status: run.status === 'running' ? 'interrupted' : run.status,
      }))
    }
    const budget = options.compaction
    if (budget && (!Number.isSafeInteger(budget.triggerTokens) || !Number.isSafeInteger(budget.keepRecentTokens)
      || budget.keepRecentTokens <= 0 || budget.triggerTokens <= budget.keepRecentTokens)) {
      throw new Error('压缩预算必须为正整数，近期预算必须小于触发预算')
    }
    if (!options.persistence) this.unsubscribeMcpCatalog = options.mcp?.subscribeToolCatalog(({ serverId, credentialRef, remoteToolNames }) => {
      const available = new Set(remoteToolNames)
      for (const [key, tool] of this.loadedMcpTools) {
        if (tool.serverId === serverId && (tool.credentialRef !== credentialRef || !available.has(tool.remoteToolName))) {
          this.loadedMcpTools.delete(key)
        }
      }
    })
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
      const reserved = [...defaultTools, ...this.options.tools?.(path) ?? []].map(tool => tool.name)
      if (this.options.mcp) reserved.push(MCP_TOOL_SEARCH_NAME)
      if (this.options.manageSchedule) reserved.push(CRONJOB_TOOL_NAME)
      if (this.options.memory) reserved.push(MEMORY_TOOL_NAME, MEMORY_SOURCE_TOOL_NAME)
      await this.runtime!.initialize(ctx, reserved)
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

  private availableTools(tools: CodingTool[], planning: boolean, scheduled: boolean): AvailableTools {
    const local = [...tools, ...(this.runtime?.tools() ?? []).filter(tool => tool.name !== ASK_USER_QUESTION_TOOL_NAME)].filter(tool => !scheduled || tool.name !== CRONJOB_TOOL_NAME)
    if (this.state.permissionMode !== 'normal') return { local: local.filter(tool => readOnlyTools.has(tool.name) || tool.name === ASK_USER_QUESTION_TOOL_NAME || this.isMemorySourceTool(tool.name)) }
    if (planning) return { local: local.flatMap(tool => planReadTools.has(tool.name) || tool.name === ASK_USER_QUESTION_TOOL_NAME || this.isMemorySourceTool(tool.name)
      ? [tool] : tool.name === 'bash' && tool.planVersion ? [tool.planVersion] : []) }
    const mcp = this.options.mcp
    const servers = mcp?.listDiscoveryServers()
    if (!mcp || !servers?.length || local.some(tool => tool.name === MCP_TOOL_SEARCH_NAME)) return { local }

    const saved = this.options.persistence?.store.listMcpToolLoads(this.sessionId)
    const loaded = saved ? new Set(saved.map(mcpToolKey)) : this.loadedMcpTools
    const bindings = loaded.size ? mcp.listToolsForAgent().filter(binding => loaded.has(mcpToolKey(mcpToolIdentity(binding)))) : []
    const checkPermission = (name: string, args: JsonObject) => {
      const denial = this.toolDenial(name, args, Boolean(this.state.plan), false)
      if (denial) throw Object.assign(new Error(denial.message), { code: denial.code })
    }
    const remote = createMcpTools(local, bindings, mcp, checkPermission).filter(tool => !scheduled || tool.name !== CRONJOB_TOOL_NAME)
    const declared = new Set([...local, ...remote].map(tool => tool.name))
    const search = createMcpToolSearch(async signal => {
      await mcp.waitForToolDiscovery(signal)
      checkPermission(MCP_TOOL_SEARCH_NAME, {})
      const namespaces = new Map(mcp.listDiscoveryServers().map(server => [server.id, server]))
      return mcp.listToolsForAgent().filter(binding => !declared.has(binding.name))
        .map(binding => ({ binding, namespace: namespaces.get(binding.serverId) }))
    })
    return { local: [...local, search], remote, servers }
  }

  private isMemorySourceTool(name: string) {
    return this.memoryEnabled && name === MEMORY_SOURCE_TOOL_NAME
  }

  private toolDenial(name: string, args: JsonObject, planning: boolean, planBash: boolean) {
    if (this.permissionUnconfirmed) return { code: 'permission_denied', message: '权限保存状态未确认，工具未执行。请重启服务后核对。' }
    if (name === ASK_USER_QUESTION_TOOL_NAME || this.isMemorySourceTool(name)) return
    if (this.state.permissionMode === 'read-only' && !readOnlyTools.has(name)) {
      return { code: 'permission_denied', message: '只读模式下未执行此工具。' }
    }
    if (planning && !planReadTools.has(name) && (name !== 'bash' || !planBash || !planGitArgs(args.command))) {
      return { code: 'permission_denied', message: '计划模式仅允许只读调查工具及获准的 Git 命令。' }
    }
  }

  private configure(cwd: string, { local, remote, servers }: AvailableTools, files: ProjectContextFile[], skills: readonly SkillSummary[]) {
    const tools = remote ? [...local, ...remote] : local
    const declarations = tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
    this.configurationKeyBeforeMemory = undefined
    this.configuration = {
      systemPrompt: buildSystemPrompt(cwd, local, this.options.documentationRoot, files, skills, this.options.skillHome, servers),
      ...(declarations.length ? { tools: declarations } : {}),
    }
    return tools
  }

  private changePlan(plan: PlanState | null, planCommand?: SubmissionInput) {
    const changed = plan !== (this.state.plan ?? null)
    this.save({ plan: changed ? plan : undefined, planCommand })
    if (!changed) return
    this.state.plan = plan
    this.publish({ type: 'plan', plan })
  }

  async reviewPlan(planId: string, action: 'approve' | 'discuss'): Promise<SubmissionAccepted | { plan: PlanState }> {
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    if (action !== 'approve' && action !== 'discuss') throw new SessionSubmitError('invalid', '评审动作无效')
    const previous = action === 'approve' && this.approvedPlans.get(planId)
    if (previous) return { ...previous }
    const plan = this.state.plan
    if (plan?.state !== 'review' || plan.assistantMessageId !== planId) {
      throw new SessionSubmitError('invalid', '此方案已不是当前待审方案，请重新同步会话。')
    }
    if (action === 'discuss') {
      if (this.submitting || this.state.running) throw new SessionSubmitError('busy', '正在接收或生成，请等待本次回答结束')
      const planning = { state: 'planning' } as const
      this.changePlan(planning)
      return { plan: planning }
    }
    const selection = this.state.modelSelection
    if (!selection) throw new SessionSubmitError('invalid', '请先选择执行方案使用的模型。')
    const text = ['请执行已确认的方案。', '', 'Plan:', ...plan.steps.map((step, index) => `${index + 1}. ${step}`)].join('\n')
    const result = await this.submitMessage({ ...selection, clientMessageId: `plan:${planId}`, text }, planId)
    if (result.kind !== 'message') throw new Error('未接收计划执行轮')
    return result
  }

  async submit(input: SubmissionInput): Promise<SubmissionResult | SubmissionPending> {
    if (this.closed || this.queueFrozen) throw new SessionSubmitError('closed', '服务正在关闭')
    if (typeof input?.clientMessageId === 'string' && (input.clientMessageId.startsWith('plan:') || input.clientMessageId.startsWith('question:'))) {
      throw new SessionSubmitError('invalid', '提交编号无效')
    }
    return this.submitUserInput(input)
  }

  private submitUserInput(input: SubmissionInput, question?: UserQuestionBatch): Promise<SubmissionResult | SubmissionPending> {
    const id = input?.clientMessageId
    const previous = this.pending.get(id)
    if (previous) {
      this.checkReplay(previous.input, input, runSelection(input))
      return Promise.resolve(this.pendingReceipt(previous))
    }
    const command = typeof input?.text === 'string' && (planCommandArgument(input.text) !== undefined || input.text.trim() === '/compact')
    if (input?.mode === 'steer' && command) throw new SessionSubmitError('invalid', '控制命令不能作为插话发送')
    if (!this.options.persistence || this.options.persistence.first && !this.storedRuns.size || command
      || this.submitting && this.submitting.input.clientMessageId === id) return this.submitMessage(input)
    const duplicate = this.replay(input, runSelection(input), false)
    if (duplicate) return Promise.resolve(duplicate)
    const running = this.state.running
    const queued = this.queued().length > 0
    if (!question && !this.submitting && !running && !queued && this.state.plan?.state !== 'review') {
      return this.submitMessage(input)
    }
    const canSteer = this.canSteer()
    const steer = input.mode === 'steer' && (canSteer || !running && queued || question && this.state.plan?.state === 'review')
    const item = this.enqueue(input, steer ? 'steering' : 'queued', question)
    if (!steer && input.mode === 'steer' && this.controller?.signal.aborted) this.resumeAfterAbort = true
    if (!running && !this.submitting) void this.drainQueue(true)
    return Promise.resolve(this.pendingReceipt(item))
  }

  private enqueue(input: SubmissionInput, status: 'queued' | 'steering', question?: UserQuestionBatch) {
    if (!input || typeof input.clientMessageId !== 'string' || !input.clientMessageId.trim() || input.clientMessageId.length > 128
      || typeof input.text !== 'string' || !input.text.trim() && !input.attachmentIds?.length
      || typeof input.modelId !== 'string' || !input.provider && input.modelId !== 'deepseek-flash') {
      throw new SessionSubmitError('invalid', '请提交有效原文、支持的模型和临时编号')
    }
    this.submissionModel(runSelection(input))
    const attachments = [...new Set(input.attachmentIds)].map(id => {
      const attachment = this.options.persistence!.store.pendingAttachment(id, { sessionId: this.sessionId }, Date.now() - ATTACHMENT_TTL_MS)
      if (!attachment) throw new SessionSubmitError('invalid', '附件不可用或已经用于另一条消息。')
      return attachment
    })
    if (status === 'steering' && this.canSteer()) this.checkSteeringAttachments(attachments)
    const item: PendingSubmission = {
      input: structuredClone(input), text: input.text, status, acceptedSeq: this.state.seq + 1,
      ...(attachments.length && { attachments }),
    }
    this.save({ pending: [item], ...(question && { questions: [question] }) })
    this.pending.set(input.clientMessageId, item)
    if (question) this.questions.set(question.id, question)
    if (!this.controller?.signal.aborted) this.queuePaused = null
    this.publishInteraction()
    return item
  }

  private pendingReceipt(item: PendingSubmission): SubmissionResult | SubmissionPending {
    return item.receipt ?? {
      kind: item.input.mode === 'steer' && item.status === 'steering' ? 'steering' : 'queued',
      clientMessageId: item.input.clientMessageId, acceptedSeq: item.acceptedSeq,
    }
  }

  private queued() {
    return [...this.pending.values()].filter(item => item.status === 'queued')
  }

  private pendingSteering() {
    return [...this.pending.values()].filter(item => item.status === 'steering')
      .sort((a, b) => (a.steeringSeq ?? a.acceptedSeq) - (b.steeringSeq ?? b.acceptedSeq))
  }

  private interactionView(): InteractionState {
    const visible = ({ input, text, attachments }: PendingSubmission) => ({
      clientMessageId: input.clientMessageId, text, ...(attachments && { attachments }),
    })
    return {
      queue: { items: this.queued().map(visible), paused: this.queuePaused },
      steering: this.pendingSteering().map(visible), questions: [...this.questions.values()],
    }
  }

  private publishInteraction() {
    const interaction = this.state.interaction = this.interactionView()
    this.publish({ type: 'interaction', interaction })
  }

  private canSteer() {
    return this.state.running?.kind === 'task' && !this.state.runs?.at(-1)?.scheduledRunId && !this.steeringBoundaryClosed && !this.settling && !this.controller?.signal.aborted
  }

  private checkSteeringAttachments(attachments?: PendingSubmission['attachments']) {
    if (!this.model?.supportsImages && attachments?.some(attachment => attachment.mediaType !== 'text/plain')) {
      throw new SessionSubmitError('invalid', '当前任务使用的模型不支持图片，图片消息可在下一轮发送。')
    }
  }

  updateQueue(id: string, change: QueueAction): QueueResult {
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    const item = this.pending.get(id)
    if (!item) return { status: this.storedRuns.has(id) ? 'started' : 'missing' }
    if (item.status !== 'queued') return { status: item.status }
    if (this.startingPendingId === id) return { status: 'unavailable' }
    let updated: PendingSubmission
    if (change.action === 'edit') {
      if (item.attachments?.length) throw new SessionSubmitError('invalid', '带附件的待发消息不能编辑')
      if (typeof change.text !== 'string' || !change.text.trim() || planCommandArgument(change.text) !== undefined || change.text.trim() === '/compact') {
        throw new SessionSubmitError('invalid', '请填写待发消息正文')
      }
      updated = { ...item, text: change.text }
    } else if (change.action === 'steer') {
      if (!this.canSteer()) return { status: 'queued' }
      this.checkSteeringAttachments(item.attachments)
      updated = { ...item, status: 'steering', steeringSeq: this.state.seq + 1 }
    } else updated = { ...item, status: 'deleted' }
    this.save({ pending: [updated] })
    this.pending.set(id, updated)
    if (!this.queued().length && !this.pendingSteering().length) this.queuePaused = null
    this.publishInteraction()
    return { status: updated.status }
  }

  private async drainQueue(resume = false) {
    if (this.closed || this.queueFrozen || this.startingPendingId || this.submitting || this.state.running || this.state.plan?.state === 'review'
      || this.queuePaused && !resume) return
    const item = this.queued()[0]
    if (!item) return
    this.startingPendingId = item.input.clientMessageId
    if (this.queuePaused) {
      this.queuePaused = null
      this.publishInteraction()
    }
    try {
      const { provider, modelId, reasoningEffort } = this.state.modelSelection ?? runSelection(item.input)
      const result = await this.submitMessage({ ...item.input, provider, modelId, reasoningEffort, text: item.text }, undefined, false, undefined, item)
      if (result.kind === 'handled') {
        const handled = { ...item, status: 'deleted' as const, receipt: result }
        this.save({ pending: [handled] })
        this.pending.set(item.input.clientMessageId, handled)
        this.publishInteraction()
      }
    } catch (error) {
      if (!this.closed) {
        this.queuePaused = error instanceof Error ? error.message : '待发消息启动失败。'
        this.publishInteraction()
      }
    } finally {
      this.startingPendingId = undefined
    }
    if (!this.queuePaused && !this.state.running) void this.drainQueue()
  }

  private async waitForQuestion(
    { questions, timeout }: { questions: UserQuestion[]; timeout?: number },
    runId: string, assistantMessageId: string, toolCallId: string, signal: AbortSignal,
  ) {
    const seconds = timeout ?? (await this.options.questionWait?.())?.timeout ?? 120
    signal.throwIfAborted()
    const deadlineAt = seconds === -1 ? undefined : Date.now() + seconds * 1000
    const batch: UserQuestionBatch = {
      id: randomUUID(), runId, assistantMessageId, toolCallId, questions, status: 'waiting',
      ...(deadlineAt !== undefined && { deadlineAt }),
    }
    this.save({ questions: [batch] })
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let confirm!: QuestionWaiter['confirm']
      const persisted = new Promise<boolean>(resolve => { confirm = resolve })
      const abort = () => waiter.settle('aborted')
      const waiter: QuestionWaiter = { batch, persisted, confirm, settle: (status, answers, replyId) => {
        if (waiter.outcome) return
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        waiter.outcome = { ...batch, status, ...(answers && { answers }), ...(replyId && { replyId, replyKind: 'answered' }) }
        if (status === 'aborted') reject(Object.assign(new Error('任务已中止，问答已关闭。'), { code: 'interrupted' }))
        else if (status === 'timed-out') resolve(JSON.stringify({
          pending: true, callId: toolCallId, message: '等待已超时，用户仍可补答。请继续不依赖答案的工作。',
        }))
        else resolve(JSON.stringify({
          answers, ...(answers?.every(answer => !answer.selected.length && !answer.custom)
            && { message: '用户跳过了问题。请继续不依赖答案的工作。' }),
        }))
      } }
      this.questionWaiters.set(batch.id, waiter)
      this.questions.set(batch.id, batch)
      signal.addEventListener('abort', abort, { once: true })
      if (deadlineAt !== undefined) timer = setTimeout(() => waiter.settle('timed-out'), Math.max(0, deadlineAt - Date.now()))
      this.publishInteraction()
    })
  }

  async replyToQuestion(id: string, replyId: string, rawAnswers: unknown): Promise<QuestionReply> {
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    if (typeof replyId !== 'string' || !replyId.trim() || replyId.length > 128) throw new SessionSubmitError('invalid', '回答编号无效')
    let batch = this.questions.get(id)
    if (!batch) throw new SessionSubmitError('invalid', '找不到问题组')
    let answers: QuestionAnswer[]
    try { answers = validateQuestionAnswers(batch.questions, rawAnswers) }
    catch (error) { throw new SessionSubmitError('invalid', error instanceof Error ? error.message : '回答无效') }
    if (batch.status === 'waiting') {
      const waiter = this.questionWaiters.get(id)
      if (!waiter) throw new SessionSubmitError('busy', '问题已关闭')
      if (!waiter.outcome) {
        if (batch.deadlineAt !== undefined && Date.now() >= batch.deadlineAt) waiter.settle('timed-out')
        else waiter.settle('answered', answers, replyId)
      }
      if (!await waiter.persisted) throw new SessionSubmitError('busy', '未能确认回答，请重新同步会话')
      batch = this.questions.get(id)!
    }
    if (batch.replyId === replyId && batch.replyKind) {
      if (JSON.stringify(batch.answers) !== JSON.stringify(answers)) throw new SessionSubmitError('busy', '此回答编号已提交其他答案')
      return { kind: batch.replyKind, replyId }
    }
    if (batch.status !== 'timed-out' || batch.replyId) throw new SessionSubmitError('busy', '问题已关闭')
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    if (answers.every(answer => !answer.selected.length && !answer.custom)) {
      const closed = { ...batch, status: 'closed' as const, answers, replyId, replyKind: 'closed' as const }
      this.save({ questions: [closed] })
      this.questions.set(id, closed)
      this.publishInteraction()
      return { kind: 'closed', replyId }
    }
    const selection = this.state.modelSelection
    if (!selection) throw new SessionSubmitError('invalid', '当前模型不可用，请重新选择')
    const late = { ...batch, status: 'answered' as const, answers, replyId, replyKind: 'late' as const }
    await this.submitUserInput({
      ...selection, clientMessageId: 'question:' + id, mode: 'steer',
      text: JSON.stringify({ kind: 'answer_to_pending_question', tool: ASK_USER_QUESTION_TOOL_NAME,
        callId: batch.toolCallId, questions: batch.questions, answers }),
    }, late)
    return { kind: 'late', replyId }
  }

  getScheduledSettings() {
    const selection = this.state.modelSelection
    return { modelSelection: selection && { ...selection }, permissionMode: this.state.permissionMode }
  }

  async submitScheduled(input: SubmissionInput, signal?: AbortSignal): Promise<SubmissionResult> {
    if (!this.options.persistence) throw new SessionSubmitError('invalid', '当前会话不支持定时任务')
    return this.submitMessage(input, undefined, true, signal)
  }

  private async submitMessage(input: SubmissionInput, approvedPlanId?: string, scheduled = false, admissionSignal?: AbortSignal, queued?: PendingSubmission): Promise<SubmissionResult> {
    if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    if (typeof input?.modelId !== 'string' || !input.provider && input.modelId !== 'deepseek-flash'
      || typeof input.text !== 'string' || (!input.text.trim() && !input.attachmentIds?.length)
      || typeof input.clientMessageId !== 'string' || !input.clientMessageId.trim() || input.clientMessageId.length > 128) {
      throw new SessionSubmitError('invalid', '请提交有效原文、支持的模型和临时编号')
    }
    const planArgument = scheduled ? undefined : planCommandArgument(input.text)
    const manualCompaction = !scheduled && input.text.trim() === '/compact'
    const planControl = planArgument === '' || planArgument === 'off'
    if ((planControl || manualCompaction) && (input.attachmentIds?.length || input.referenceSessionIds?.length)) {
      throw new SessionSubmitError('invalid', '控制命令不能同时发送附件或会话引用')
    }
    const selection = runSelection(input)
    if (planArgument === 'off' && this.submitting) {
      if (this.submitting.input.clientMessageId === input.clientMessageId) this.checkReplay(this.submitting.input, input, selection)
      await this.submitting.settled.catch(() => undefined)
      if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
    }
    const previous = !queued && this.replay(input, selection, scheduled)
    if (previous) return previous
    if (planControl) {
      if (this.options.persistence?.first && !this.storedRuns.size) {
        throw new SessionSubmitError('invalid', '请先创建会话，再开启计划模式。')
      }
      if (planArgument !== 'off' && (this.submitting || this.state.running)) {
        throw new SessionSubmitError('busy', '正在接收或生成，请等待本次回答结束')
      }
      this.changePlan(planArgument === 'off' ? null : this.state.plan ?? { state: 'planning' }, input)
      const result: SubmissionHandled = { kind: 'handled', clientMessageId: input.clientMessageId, notices: [] }
      this.handled.set(input.clientMessageId, { input, result })
      return structuredClone(result)
    }
    const model = this.submissionModel(selection)
    while (this.submitting?.input.clientMessageId === input.clientMessageId) {
      if (this.submitting.scheduled !== scheduled) throw new SessionSubmitError('busy', '此提交编号已用于另一条消息')
      this.checkReplay(this.submitting.input, input, selection)
      await this.submitting.settled.catch(() => undefined)
      if (this.closed) throw new SessionSubmitError('closed', '服务正在关闭')
      const approved = approvedPlanId && this.approvedPlans.get(approvedPlanId)
      if (approved) return { ...approved }
      const accepted = this.replay(input, selection, scheduled)
      if (accepted) return accepted
    }
    if (this.submitting || this.state.running) throw new SessionSubmitError('busy', '正在接收或生成，请等待本次回答结束')
    if (this.state.plan?.state === 'review' && !approvedPlanId && !manualCompaction) {
      throw new SessionSubmitError('busy', '请先确认当前方案，或选择去聊天里说。')
    }
    if (admissionSignal) this.checkPreparing(admissionSignal)
    const controller = this.preparing = new AbortController()
    const stopPreparing = () => {
      if (this.controller === controller) return
      controller.abort()
      this.initializing?.abort()
    }
    admissionSignal?.addEventListener('abort', stopPreparing, { once: true })
    const promise = this.accept(input, selection, model, controller, { approvedPlanId, planArgument, scheduled, manualCompaction, queued })
    this.submitting = { input, scheduled, settled: promise }
    try {
      return await promise
    } finally {
      admissionSignal?.removeEventListener('abort', stopPreparing)
      this.submitting = undefined
      this.preparing = undefined
      if (!this.state.running) void this.drainQueue()
    }
  }

  private async accept(input: SubmissionInput, selection: ModelSelection, model: ModelInfo, controller: AbortController,
    { approvedPlanId, planArgument, scheduled, manualCompaction: manual, queued }: { approvedPlanId?: string; planArgument?: string; scheduled: boolean; manualCompaction: boolean; queued?: PendingSubmission },
  ): Promise<SubmissionResult> {
    const { signal } = controller
    const cwd = await this.options.resolveDirectory()
    const directory = await this.options.discoverModels?.()
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
    const submittedText = planArgument ?? input.text
    let text = submittedText
    if (!manual && !scheduled && !approvedPlanId && this.runtime?.has('input')) {
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
    const userId = randomUUID()
    const tools = (this.options.tools?.(cwd) ?? []).filter(tool => tool.name !== ASK_USER_QUESTION_TOOL_NAME)
    const storage = this.options.persistence
    const manageSchedule = this.options.manageSchedule
    if (!manual && !scheduled && storage && manageSchedule) {
      const { id: sessionId, workspaceId } = storage.summary
      tools.push(createCronjobTool(args => manageSchedule({ sessionId, workspaceId, runId: userId }, args)))
    }
    let files = this.projectContext?.cwd === cwd ? this.projectContext.files : []
    if (!manual && this.runtime?.has('before_agent_start')) {
      try { files = await this.loadContextFiles(cwd, model, signal) }
      catch (error) {
        // The normal task path reports oversized project instructions after accepting the message.
        if (!(error instanceof ProjectContextOverflow)) throw error
      }
    }
    this.checkPreparing(signal)
    this.configure(cwd, this.availableTools(tools, !approvedPlanId && (planArgument !== undefined || Boolean(this.state.plan)), scheduled), files, skills)
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
          await this.loadMemorySettings()
          await this.compact(model, selection.reasoningEffort, 'manual', running, controller.signal, record)
          status = this.storedRuns.get(input.clientMessageId)?.status ?? 'completed'
        } catch (error) {
          if (!(error instanceof SessionWriteError)) throw error
        } finally { await this.finish(controller.signal, status) }
      })
      return { kind: 'compaction', clientMessageId: input.clientMessageId, compactionId: record.id, acceptedSeq }
    }
    const prepared = await this.prepareSources(input, model, queued?.input.clientMessageId)
    const user: ConversationMessage = {
      id: userId, clientMessageId: input.clientMessageId,
      message: { role: 'user', content: text, timestamp: Date.now() },
      ...(skillInvocation && { skillInvocation }),
      ...(prepared.attachments.length && { attachments: prepared.attachments }),
      ...(prepared.references.length && { references: prepared.references }),
    }
    const running = { kind: 'task' as const, runId: user.id, assistantMessageId: randomUUID(), phase: 'model' as const, activeTools: [] }
    let systemPrompt: string | undefined
    let extra: ConversationMessage[] = []
    const first = !this.state.messages.some(entry => entry.message.role === 'user' && !entry.extension)
    const title = first ? temporarySessionTitle(submittedText.trim() ? submittedText : prepared.attachments[0]?.name ?? '') : ''
    const planChange = approvedPlanId ? null : planArgument !== undefined && !this.state.plan ? { state: 'planning' } as const : undefined
    let run: StoredRun | undefined
    let carried: Awaited<ReturnType<AgentSession['prepareSteering']>> = []
    try {
      if (this.runtime?.has('before_agent_start')) {
        const prompt = buildModelHistory([user], undefined, false, this.options.attachments && { path: id => this.options.attachments!.path(id) })[0]?.content
        const start = await beforeStart(this.runtime, this.extensionContext(cwd, model, signal), this.configuration.systemPrompt ?? '',
          typeof prompt === 'string' ? prompt : text, user.id)
        if (start.overridden) systemPrompt = start.systemPrompt
        extra = start.extra.map(message => this.extensionEntry(message))
      }
      if (!scheduled) carried = await this.prepareSteering(model, user.id, signal)
      this.checkPreparing(signal)
      this.checkModelSelection(input, selection, directory)
      const acceptedSeq = this.state.seq + 1
      const claimed = [
        ...carried.map(({ item, entry }) => this.delivered(item, entry, acceptedSeq)),
        ...(queued ? [{ ...queued, status: 'started' as const,
          receipt: { kind: 'message' as const, clientMessageId: input.clientMessageId, userMessageId: user.id, acceptedSeq } }] : []),
      ]
      const attachments = carried.flatMap(({ binding }) => binding ? [binding] : [])
      if (prepared.scope) attachments.push({
        ids: prepared.attachments.map(attachment => attachment.id), scope: prepared.scope,
        cutoff: Date.now() - ATTACHMENT_TTL_MS, messageId: user.id, pendingId: queued?.input.clientMessageId,
      })
      run = this.saveStart(input, selection, user.id, 'task', {
        messages: [...carried.map(({ entry }) => entry), user, ...extra], plan: planChange,
        ...(attachments.length && { attachments }), ...(claimed.length && { pending: claimed }),
      }, text, approvedPlanId, title, scheduled)
      for (const item of claimed) this.pending.set(item.input.clientMessageId, item)
    } catch (error) {
      if (!(error instanceof SessionWriteError && error.reason === 'unconfirmed')) {
        await removeReferenceSnapshots([...prepared.references, ...carried.flatMap(({ entry }) => entry.references ?? [])])
      }
      throw error
    }
    const initialSelection = this.confirmInitialSelection(selection)
    this.steeringBoundaryClosed = false
    this.controller = controller
    const steering = carried.map(({ entry }) => entry)
    this.state.messages.push(...steering, user, ...extra)
    this.state.running = running
    if (planChange !== undefined) this.state.plan = planChange
    this.publish({ type: 'accepted', user, running, ...(steering.length && { steering }) }, run && this.publicRun(run), undefined, initialSelection)
    const receipt: SubmissionAccepted = { kind: 'message', clientMessageId: input.clientMessageId, userMessageId: user.id, acceptedSeq: this.state.seq }
    if (carried.length || queued || !scheduled && this.queuePaused) {
      this.queuePaused = null
      this.publishInteraction()
    }
    if (approvedPlanId) this.approvedPlans.set(approvedPlanId, { ...receipt })
    if (planChange !== undefined) this.publish({ type: 'plan', plan: planChange })
    this.task = Promise.resolve().then(() => this.runTask(model, selection.reasoningEffort, running, cwd, tools, skills, controller.signal, user, systemPrompt, scheduled))
    if (run && title) this.startTitle(model, submittedText, title)
    return receipt
  }

  private delivered(item: PendingSubmission, entry: ConversationMessage, acceptedSeq: number): PendingSubmission {
    const clientMessageId = item.input.clientMessageId
    return { ...item, status: 'delivered', receipt: { kind: 'message', clientMessageId, userMessageId: entry.id, acceptedSeq } }
  }

  private async prepareSteering(model: ModelInfo, runId: string, signal: AbortSignal) {
    const entries: Array<{ item: PendingSubmission; entry: ConversationMessage; binding?: {
      ids: string[]; scope: AttachmentScope; cutoff: number; messageId: string; pendingId?: string
    } }> = []
    try {
      const preparedIds = new Set<string>()
      for (;;) {
        const remaining = this.pendingSteering().filter(item => !preparedIds.has(item.input.clientMessageId))
        if (!remaining.length) return entries
        for (const item of remaining) {
          const clientMessageId = item.input.clientMessageId
          preparedIds.add(clientMessageId)
          const { attachments, references, scope } = await this.prepareSources(item.input, model, clientMessageId)
          const id = randomUUID()
          const entry: ConversationMessage = {
            id, clientMessageId, steering: true, runId,
            message: { role: 'user', content: item.text, timestamp: Date.now() },
            ...(attachments.length && { attachments }), ...(references.length && { references }),
          }
          entries.push({ item, entry, ...(scope && { binding: {
            ids: attachments.map(attachment => attachment.id), scope, cutoff: Date.now() - ATTACHMENT_TTL_MS,
            messageId: id, pendingId: clientMessageId,
          } }) })
          signal.throwIfAborted()
        }
      }
    } catch (error) {
      await removeReferenceSnapshots(entries.flatMap(({ entry }) => entry.references ?? []))
      throw error
    }
  }

  private async prepareSources(input: SubmissionInput, model: ModelInfo, pendingId?: string) {
    const storage = this.options.persistence
    const files = this.options.attachments
    const attachments: NonNullable<ConversationMessage['attachments']> = []
    let scope: AttachmentScope | undefined
    if (input.attachmentIds?.length) {
      if (!storage || !files) throw new SessionSubmitError('invalid', '当前会话不支持附件')
      scope = storage.first && !this.storedRuns.size
        ? { workspaceId: storage.summary.workspaceId, draftSessionId: this.sessionId } : { sessionId: this.sessionId }
      let bytes = 0
      for (const id of new Set(input.attachmentIds)) {
        const attachment = storage.store.pendingAttachment(id, scope, Date.now() - ATTACHMENT_TTL_MS, pendingId)
        if (!attachment) throw new SessionSubmitError('invalid', '附件不存在、已过期，或不属于此会话草稿。请重新上传。')
        try { await access(files.path(id)) }
        catch { throw new SessionSubmitError('invalid', '附件文件不可读取，请重新上传。') }
        if (attachment.mediaType !== 'text/plain') {
          if (!model.supportsImages) throw new SessionSubmitError('invalid', '当前模型不支持图片。请更换模型或移除图片。')
          try { bytes += files.image(attachment.id).data.length }
          catch { throw new SessionSubmitError('invalid', '附件图片不可读取，请重新上传。') }
          if (bytes > IMAGE_BUDGET_BYTES) throw new SessionSubmitError('invalid', '本轮图片总量超过模型请求上限，请减少图片。')
        }
        attachments.push(attachment)
      }
    }
    let references: NonNullable<ConversationMessage['references']> = []
    if (input.referenceSessionIds?.length) {
      if (!storage) throw new SessionSubmitError('invalid', '当前会话不支持引用')
      try {
        ({ references } = await prepareSessionReferences({
          sessionId: this.sessionId, sourceIds: input.referenceSessionIds, contextWindow: model.contextWindow,
          directory: this.options.referenceDirectory, read: id => storage.store.readReferenceSource(id),
          canReference: this.options.isWorkspaceRegistered,
        }))
      } catch (error) {
        if (error instanceof ReferenceInputError) throw new SessionSubmitError('invalid', error.message)
        throw error
      }
    }
    return { attachments, scope, references }
  }

  private startTitle(model: ModelInfo, text: string, fallback: string) {
    const storage = this.options.persistence!
    if (!storage.first) this.options.onTitleChanged?.()
    if (!this.options.titleStream || !text.trim()) return
    const controller = new AbortController()
    const pending = generateSessionTitle(this.options.titleStream, model, text, controller.signal).then(title => {
      if (!title || title === fallback || controller.signal.aborted) return
      if (storage.store.save(storage.summary.id, { name: { value: title, expected: fallback } })) {
        this.options.onTitleChanged?.()
      }
    }).catch(() => undefined)
    this.titleRequest = { controller, pending }
  }

  private submissionModel(selection: ModelSelection): ModelInfo {
    const model = findModel(selection.modelId, selection.provider)
    if (!model) throw new SessionSubmitError('invalid', '当前模型不可用，请重新选择')
    if (model.reasoningEfforts
      ? !selection.reasoningEffort || !model.reasoningEfforts.includes(selection.reasoningEffort) : selection.reasoningEffort !== undefined) {
      throw new SessionSubmitError('invalid', '所选模型不支持此推理强度')
    }
    return model
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

  private replay(input: SubmissionInput, selection: ModelSelection, scheduled: boolean) {
    const handled = this.handled.get(input.clientMessageId)
    if (handled) {
      if (scheduled) throw new SessionSubmitError('busy', '此提交编号已用于另一条消息')
      this.checkReplay(handled.input, input, selection)
      return structuredClone(handled.result)
    }
    const previous = this.storedRuns.get(input.clientMessageId)
    if (!previous) return
    if (Boolean(previous.scheduledRunId) !== scheduled) throw new SessionSubmitError('busy', '此提交编号已用于另一条消息')
    this.checkReplay({ ...previous, permissionMode: previous.firstPermissionMode }, input, selection)
    return submissionReceipt(previous)
  }

  private checkReplay(previous: SubmissionInput, input: SubmissionInput, selection: ModelSelection) {
    if (previous.text !== input.text || previous.mode !== input.mode || previous.permissionMode !== input.permissionMode || !sameSelection(runSelection(previous), selection)
      || !sameSubmissionSources(previous, input)) {
      throw new SessionSubmitError('busy', '此提交编号已用于另一条消息')
    }
  }

  private publicRun({ text: _text, finalText: _finalText, acceptedSeq: _acceptedSeq, firstPermissionMode: _firstPermissionMode,
    approvedPlanId: _approvedPlanId, attachmentIds: _attachmentIds, referenceSessionIds: _referenceSessionIds, mode: _mode, firstTitle: _firstTitle, ...run }: StoredRun): RunRecord {
    return run
  }

  private saveStart(input: SubmissionInput, selection: ModelSelection, id: string, kind: RunRecord['kind'],
    data: Pick<Parameters<SessionPersistence['store']['save']>[1], 'messages' | 'compaction' | 'plan' | 'attachments' | 'pending'>,
    finalText?: string, approvedPlanId?: string, title?: string, scheduled = false) {
    const storage = this.options.persistence
    if (!storage) return
    const { permissionMode, ...message } = input
    const summary = this.storedRuns.size === 0 ? storage.first?.() : undefined
    if (summary && title) summary.name = title
    const run: StoredRun = {
      ...message, ...(finalText !== undefined && finalText !== input.text && { finalText }), ...(summary && permissionMode !== undefined && { firstPermissionMode: permissionMode }),
      ...(summary && title && { firstTitle: title }),
      ...(scheduled && { scheduledRunId: input.clientMessageId }),
      ...(approvedPlanId && { approvedPlanId }), ...selection, id, kind, sessionId: storage.summary.id, status: 'running', startedAt: Date.now(), acceptedSeq: this.state.seq + 1,
    }
    this.save({ ...data, run, summary, ...(summary && { permissionMode: this.state.permissionMode }),
      ...(!summary && title && { name: { value: title, expected: storage.summary.name } }),
      ...(scheduled && { scheduledSubmission: { sessionId: run.sessionId, workspaceId: storage.summary.workspaceId,
        text: input.text, modelSelection: selection, permissionMode: this.state.permissionMode } }),
      modelSelection: this.state.modelSelection ? undefined : selection })
    if (summary) Object.assign(storage.summary, summary)
    else if (title) storage.summary.name = title
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

  private async loadMemorySettings() {
    const current = await this.options.memory?.settings().catch(() => undefined)
    this.memoryEnabled = current?.enabled ?? false
    if (!this.memoryEnabled || this.memoryUser?.generation !== current?.generation) this.memoryUser = undefined
    return current
  }

  private hiddenMemoryPath() {
    const store = this.options.memory?.store
    return store && !this.memoryEnabled ? (path: string) => store.isManagedPath(path) : undefined
  }

  private async readMemorySession(memory: MemoryStore, project: MemoryProject, id: string) {
    const persistence = this.options.persistence
    const summary = persistence?.store.readSessionSummary(id)
    if (!persistence || !summary) return
    if (summary.workspaceId !== persistence.summary.workspaceId) {
      const directory = await this.options.resolveWorkspaceDirectory?.(summary.workspaceId).catch(() => undefined)
      if (!directory) return
      const sourceProject = await memory.resolveProject(directory).catch(() => undefined)
      if (sourceProject?.projectId !== project.projectId) return
    }
    return persistence.store.loadSession(id)?.messages
  }

  private context(compaction = this.latestCompaction()): ModelContext {
    return {
      ...this.configuration, messages: buildModelHistory(this.historyMessages(), compaction, !!this.options.persistence, this.options.attachments, this.hiddenMemoryPath()),
      ...(this.state.running?.kind === 'task' && { currentUserMessageId: this.state.running.runId }),
      omittedToolImageResults: this.omittedToolImageResults,
    }
  }

  private estimate(context: ModelContext, model = this.model) {
    const estimate = estimateContextTokens(context, model)
    return estimate.systemTokens + estimate.toolsTokens + estimate.messageTokens
  }

  private configKey() { return this.configurationKeyBeforeMemory ?? JSON.stringify([this.memoryEnabled, this.configuration]) }
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
      const preparation = prepareCompaction(this.historyMessages(), this.latestCompaction(), this.options.compaction?.keepRecentTokens ?? 20_000,
        Boolean(this.configuration.tools?.length), !!this.options.persistence, model, this.options.attachments, this.hiddenMemoryPath())
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
    if (final.status === 'success') {
      this.gateSample = undefined
      this.memoryUser = undefined
    }
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
    compaction?: Extract<CompactionRecord, { status: 'success' }>, assistantMessageId?: string) {
    if (this.controller?.signal !== signal) return
    if (this.state.running?.kind === 'task' && signal.aborted) status = 'aborted'
    const savedReply = !entry && assistantMessageId && this.savedMessages.has(assistantMessageId)
      ? this.state.messages.find(message => message.id === assistantMessageId) : undefined
    let plan = status === 'completed' && !this.failure && this.state.plan?.state === 'planning'
      ? extractPlan(entry ?? savedReply) : undefined
    const current = this.state.runs?.find(run => run.id === this.state.running?.runId)
    const stored = current && this.storedRuns.get(current.clientMessageId)
    let run = stored
    if (stored?.status === 'running') {
      run = this.endedRun(stored, this.failure ? 'failed' : status)
      const followup = entry && this.followup(compaction, entry)
      const data = { run, messages: entry && [entry], compaction: followup, plan }
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
        if (stored.scheduledRunId && error instanceof SessionWriteError && error.reason !== 'unconfirmed') {
          // Preserve the terminal result even if the answer and its checkpoint could not be saved together.
          try { this.save({ run }) } catch { /* The existing save failure remains visible in the session. */ }
        }
        plan = undefined
      }
    }
    this.settling = true
    if (this.runtime?.has('agent_settled') && this.state.running?.kind === 'task') {
      await this.runtime.emit('agent_settled', { aborted: status === 'aborted' || signal.aborted },
        this.extensionContext(this.cwd ?? '', this.model, signal), this.state.running.runId)
    }
    for (const [id, waiter] of this.questionWaiters) {
      waiter.settle('aborted')
      waiter.confirm(false)
      this.questions.set(id, { ...waiter.batch, status: 'aborted' })
      this.questionWaiters.delete(id)
      this.publishInteraction()
    }
    this.controller = undefined
    this.task = undefined
    this.settling = false
    this.state.running = null
    // An explicit exit may have arrived while the settled extension ran.
    if (this.state.plan?.state !== 'planning') plan = undefined
    if (plan) this.state.plan = plan
    this.publish({ type: 'task', running: null }, run && this.publicRun(run), this.failure)
    if (plan) this.publish({ type: 'plan', plan })
    this.failure = undefined
    const scheduledRunId = run?.scheduledRunId
    const pending = this.queued().length || this.pendingSteering().length
    const resume = this.resumeAfterAbort && status === 'aborted'
    this.resumeAfterAbort = false
    if (pending && !this.closed) {
      if ((run?.status ?? status) !== 'completed') {
        this.queuePaused = status === 'aborted' ? '任务已中止。发送新消息后继续。' : '任务未完成。发送新消息后继续。'
        this.publishInteraction()
      }
      if (!plan) void this.drainQueue(resume)
    }
    if (scheduledRunId && this.options.onScheduledRunFinished) {
      void Promise.resolve().then(() => this.options.onScheduledRunFinished?.(scheduledRunId)).catch(() => undefined)
    }
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

  private async runTask(model: ModelInfo, reasoningEffort: ReasoningEffort | undefined, running: Extract<RunningState, { kind: 'task' }>, cwd: string, tools: CodingTool[], skills: readonly SkillSummary[], signal: AbortSignal, user: ConversationMessage, systemPrompt: string | undefined, scheduled: boolean) {
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
    if (!scheduled && this.options.persistence && this.options.questionWait) tools = [...tools, createUserQuestionTool((input, context) =>
      this.waitForQuestion(input, runId, messageId, context.toolCallId, context.signal))]
    const memoryStore = this.options.memory?.store
    let memorySettings: MemorySettings | undefined
    let memoryProject: MemoryProject | undefined
    let projectMemory: ProjectMemory | undefined
    let memoryTool: CodingTool | undefined
    let memorySourceTool: CodingTool | undefined
    const canWriteMemory = () => this.memoryEnabled && !this.permissionUnconfirmed && this.state.permissionMode === 'normal' && !this.state.plan
    const turnTools = memoryStore ? tools.map(tool => tool.name === 'read' ? protectMemoryRead(tool, cwd, memoryStore,
      () => ({ enabled: this.memoryEnabled, project: memoryProject })) : tool) : tools
    let roundTools = tools
    let roundPlanning = Boolean(this.state.plan)
    let leftPlan = false
    const configure = (files: ProjectContextFile[], memoryTools: CodingTool[] = []) => {
      if (roundPlanning && !this.state.plan) leftPlan = true
      roundPlanning = Boolean(this.state.plan)
      roundTools = this.configure(cwd, this.availableTools([...turnTools, ...memoryTools], roundPlanning, scheduled), files, skills)
      if (systemPrompt !== undefined) this.configuration.systemPrompt = systemPrompt
      if (roundPlanning) this.configuration.systemPrompt += '\n\n' + planInstruction
      else if (leftPlan) this.configuration.systemPrompt += '\n\n用户已退出计划模式，当前采用普通模式。退出模式本身不表示用户已批准方案。'
    }
    const modelPhase = () => {
      this.steeringBoundaryClosed = false
      this.updateTask({ ...running, assistantMessageId: messageId, phase: 'model', activeTools: [] })
    }
    const currentTask = () => ({ ...running, assistantMessageId: messageId, phase: 'tools' as const, activeTools })
    const withinBudget = (context: ModelContext) => this.pressure(context, model) + model.maxTokens <= model.contextWindow
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
      if (!scheduled && this.pendingSteering().length) await claimSteering()
      let context = this.context()
      const fingerprint = JSON.stringify(context.messages)
      const margin = Math.min(16_384, Math.floor(inputBudget / 8))
      const trigger = Math.min(this.options.compaction?.triggerTokens ?? Infinity, inputBudget - margin)
      if (this.pressure(context, model) >= trigger && attemptedInput !== fingerprint) {
        attemptedInput = fingerprint
        await this.compact(model, reasoningEffort, 'auto', { ...running, assistantMessageId: messageId }, signal)
        signal.throwIfAborted()
        modelPhase()
        context = this.context()
      }
      if (memoryStore && memorySettings?.enabled && !this.memoryUser) {
        const document = await memoryStore.readUser().catch(() => undefined)
        signal.throwIfAborted()
        if (document) this.memoryUser = { document, generation: memorySettings.generation }
      }
      if (!runtime?.has('context')) return context
      const messages = await runtime.chain('context', ctx(), context.messages, messages => ({ messages }), (_current, event, result) => {
        const messages = result?.messages === undefined ? event.messages : result.messages
        if (!requestMessages(messages) || !withinBudget({ ...context, messages })) throw new Error('无效的模型上下文改写')
        return structuredClone(messages)
      }, { runId })
      return { ...context, messages }
    }

    // Snapshot mode and executable tools together after all asynchronous preparation.
    const finalizeContext: AgentRunInput['finalizeContext'] = prepared => {
      const files = this.projectContext?.files ?? []
      configure(files)
      const base = () => ({ ...prepared, ...this.configuration, tools: this.configuration.tools })
      let context: ModelContext = base()
      if (!withinBudget(context)) return { error: capacityError }
      if (this.memoryEnabled) {
        const baseKey = this.configKey()
        const candidate = (context: ModelContext, block: string) => ({ ...context, systemPrompt: `${context.systemPrompt ?? ''}\n\n${block}` })
        const append = (block: string) => {
          const next = candidate(context, block)
          if (!block || !withinBudget(next)) return false
          context = next
          return true
        }
        const personal = this.memoryUser?.document
        const memoryTools: CodingTool[] = []
        if (memoryTool && canWriteMemory()) memoryTools.push(memoryTool)
        if (memorySourceTool && (personal?.entries.length || projectMemory?.entries.length)) memoryTools.push(memorySourceTool)
        const declared = (name: string) => roundTools.some(tool => tool.name === name)
        if (memoryTools.length) {
          configure(files, memoryTools)
          this.configurationKeyBeforeMemory = baseKey
          const withMemory = candidate(base(), formatMemoryInstructions(declared(MEMORY_TOOL_NAME), declared(MEMORY_SOURCE_TOOL_NAME)))
          if (withinBudget(withMemory)) context = withMemory
          else configure(files)
        }
        const hasMemoryTool = declared(MEMORY_TOOL_NAME) || declared(MEMORY_SOURCE_TOOL_NAME)
        if (!hasMemoryTool) append(formatMemoryInstructions(false))
        if (personal && append(formatUserMemory(personal)) && hasMemoryTool) append(formatUserMemoryTargets(personal))
        if (projectMemory?.entries.length) {
          const lines = projectMemoryLines(projectMemory)
          let low = 0, high = lines.length
          while (low < high) {
            const middle = Math.ceil((low + high) / 2)
            if (withinBudget(candidate(context, formatProjectMemory(projectMemory, lines.slice(0, middle))))) low = middle
            else high = middle - 1
          }
          if (low) append(formatProjectMemory(projectMemory, lines.slice(0, low)))
        }
        // Memory data can change each round, so calibrate against the underlying task configuration.
        this.configurationKeyBeforeMemory = baseKey
        this.configuration.systemPrompt = context.systemPrompt
      }
      usedCompaction = this.latestCompaction()
      for (const index of omittedToolImageIndexes(context)) {
        const result = context.messages[index]
        if (result.role === 'toolResult' && result.imageResultId !== undefined) this.omittedToolImageResults.add(result.imageResultId)
      }
      return context
    }

    const beforeToolCall: AgentRunInput['beforeToolCall'] = call => {
      if (scheduled && call.name === CRONJOB_TOOL_NAME) return { code: 'permission_denied', message: '定时执行不能管理定时任务。' }
      if (memoryStore && (call.name === MEMORY_TOOL_NAME || call.name === MEMORY_SOURCE_TOOL_NAME) && !this.memoryEnabled) {
        return { code: 'permission_denied', message: '已关闭长期记忆，工具未执行。' }
      }
      return this.toolDenial(call.name, call.arguments, roundPlanning, call.name === 'bash' && roundTools.some(tool => tool.name === 'bash'))
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
      if (!this.options.persistence) {
        for (const tool of this.mcpSearchLoads(event, signal) ?? []) this.loadedMcpTools.set(mcpToolKey(tool), tool)
      }
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
        const waiter = [...this.questionWaiters.values()].find(({ batch }) => batch.assistantMessageId === messageId
          && batch.toolCallId === checkpoint.result.toolCallId)
        try {
          this.save({ messages: [result], mcpToolLoads: this.mcpSearchLoads(checkpoint, signal),
            ...(waiter?.outcome && { questions: [waiter.outcome] }) })
          if (waiter?.outcome) {
            this.questions.set(waiter.batch.id, waiter.outcome)
            this.questionWaiters.delete(waiter.batch.id)
            this.publishInteraction()
            waiter.confirm(true)
          }
        } catch (error) {
          waiter?.confirm(false)
          this.noteFailure(error, 'tool-result', checkpoint.executed ? result.toolCall : undefined)
          throw error
        }
        savedToolResult = result
      }
    }
    const claimSteering = async (answer?: ConversationMessage) => {
      const carried = await this.prepareSteering(model, runId, signal)
      const entries = carried.map(({ entry }) => entry)
      const claimed = carried.map(({ item, entry }, index) => this.delivered(item, entry, this.state.seq + index + 1))
      const bindings = carried.flatMap(({ binding }) => binding ? [binding] : [])
      const followup = answer && this.followup(usedCompaction, answer)
      try {
        this.save({ messages: answer ? [answer, ...entries] : entries, pending: claimed, attachments: bindings, compaction: followup })
      } catch (error) {
        if (!(error instanceof SessionWriteError && error.reason === 'unconfirmed')) {
          await removeReferenceSnapshots(entries.flatMap(entry => entry.references ?? []))
        }
        this.noteFailure(error, 'finish')
        throw error
      }
      if (followup) this.applyFollowup(followup)
      terminalEntry = undefined
      for (const item of claimed) this.pending.set(item.input.clientMessageId, item)
      for (const entry of entries) this.updateTask(this.state.running, entry)
      this.publishInteraction()
    }
    const afterStep: AgentRunInput['afterStep'] = async (reply, hasTools) => {
      if (signal.aborted) return false
      if (!this.pendingSteering().length) {
        if (!hasTools) this.steeringBoundaryClosed = true
        return false
      }
      await claimSteering(hasTools ? undefined : terminalEntry ?? { id: messageId, message: reply })
      return true
    }
    try {
      memorySettings = await this.loadMemorySettings()
      signal.throwIfAborted()
      if (memoryStore && memorySettings?.enabled) {
        memoryProject = await memoryStore.resolveProject(cwd).catch(() => undefined)
        signal.throwIfAborted()
        if (memoryProject) projectMemory = await memoryStore.prepareProject(memoryProject, { prune: canWriteMemory(), signal, canCommit: canWriteMemory }).catch(() => undefined)
        signal.throwIfAborted()
        memoryTool = createMemoryTool({ store: memoryStore, project: memoryProject, sessionId: this.sessionId, canWrite: canWriteMemory })
        const project = memoryProject
        if (this.options.persistence && project) memorySourceTool = createMemorySourceTool({ store: memoryStore, project,
          readSession: id => this.readMemorySession(memoryStore, project, id) })
      }
      const options: Omit<AgentRunInput, 'context'> = {
        model, reasoningEffort, tools, signal, prepareContext, finalizeContext, afterStep: scheduled || !this.options.persistence ? undefined : afterStep, beforeToolCall,
        resolveTools: () => roundTools, saveToolCheckpoint: this.options.persistence ? saveToolCheckpoint : undefined,
        ...(runtime && {
          observe: <K extends keyof ExtensionEvents>(type: K, event: ExtensionEvents[K]) =>
            runtime.has(type) ? runtime.emit(type, event, ctx(), runId) : undefined,
          ...toolHooks(runtime, ctx, runId, call => roundTools.some(tool => tool.name === call.name && tool.preserveFailure)),
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
      await this.finish(signal, status, terminalEntry, usedCompaction, messageId)
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

  private mcpSearchLoads(event: Extract<AgentEvent, { type: 'tool_result' }>, signal: AbortSignal): McpToolIdentity[] | undefined {
    const mcp = this.options.mcp
    if (!mcp || signal.aborted || event.result.isError || event.result.toolName !== MCP_TOOL_SEARCH_NAME
      || this.toolDenial(MCP_TOOL_SEARCH_NAME, {}, Boolean(this.state.plan), false)) return
    const details = event.details.find(isMcpToolSearchDetails)
    return details?.bindings.filter(binding => mcp.isCurrentTool(binding)).map(mcpToolIdentity)
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

  freezeQueue(): void {
    this.queueFrozen = true
    if (this.startingPendingId) this.preparing?.abort()
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.freezeQueue()
    this.unsubscribeMcpCatalog?.()
    this.initializing?.abort()
    this.preparing?.abort()
    this.titleRequest?.controller.abort()
    if (!this.settling) this.controller?.abort()
    const task = this.task
    return this.closing = (async () => {
      await Promise.allSettled([this.initialization, this.submitting?.settled, this.titleRequest?.pending, ...this.selectionNotifications])
      await task
      const cleared = [...this.queued(), ...this.pendingSteering()].map(item => ({ ...item, status: 'deleted' as const }))
      if (cleared.length) {
        this.save({ pending: cleared })
        for (const item of cleared) this.pending.set(item.input.clientMessageId, item)
      }
      if (this.cwd && this.runtime?.has('session_shutdown')) {
        await this.runtime.emit('session_shutdown', { reason: 'quit' }, this.extensionContext(this.cwd, this.model))
      }
    })()
  }
}
