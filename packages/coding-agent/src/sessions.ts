import { sameSelection, type ModelSelection } from '@agent-learning/model'
import { randomUUID } from 'node:crypto'
import { SessionSubmitError, type AgentSession } from './agent-session.js'
import { runSelection, submissionReceipt, type SessionPersistence, type SessionStore } from './session-store.js'
import type { PermissionMode } from './permissions.js'
import type { SubmissionAccepted, SubmissionHandled } from './types.js'

export type SessionSummary = {
  id: string
  workspaceId: string
  name: string
  createdAt: string
}

type FirstMessage = Parameters<AgentSession['submit']>[0] & { workspaceId: string; draftSessionId?: string }
type StartedSession = { session: SessionSummary; accepted: SubmissionAccepted } | (SubmissionHandled & { draftSessionId: string })
type Draft<T> = { summary: SessionSummary; session: T; close(): Promise<void>; submitting?: boolean }

export class Sessions<T extends { close?: () => Promise<void>; selectModel?: (selection: ModelSelection) => void | Promise<void>; initialize?: () => Promise<void> | undefined }> {
  private readonly sessions = new Map<string, { summary: SessionSummary; session: T }>()
  private readonly starts = new Map<string, { input: FirstMessage; result: Promise<StartedSession> }>()
  private readonly drafts = new Map<string, { workspaceId: string; pending: Promise<Draft<T>> }>()
  private closing?: Promise<void>

  constructor(private readonly options: {
    resolveDirectory(workspaceId: string): Promise<string>
    createSession(resolveDirectory: () => Promise<string>, persistence?: SessionPersistence, permissionMode?: PermissionMode, sessionId?: string): T
    getDefaultPermissionMode?(): Promise<PermissionMode>
    store?: SessionStore
    closeTools?(): Promise<void>
    onStarted?(): void
  }) {}

  selectModel(selection: ModelSelection, sessionId?: string) {
    this.ensureOpen()
    if (sessionId) {
      const session = this.get(sessionId)
      if (!session) return false
      if (!session.selectModel) throw new SessionSubmitError('invalid', '当前会话不支持模型选择')
      const notification = session.selectModel(selection)
      if (notification) return notification.then(() => true)
    } else this.options.store?.saveModelSelection(selection)
    return true
  }

  async create(workspaceId: string): Promise<SessionSummary> {
    const resolveDirectory = await this.validateWorkspace(workspaceId)
    const permissionMode = await this.options.getDefaultPermissionMode?.() ?? 'normal'
    this.ensureOpen()
    let id: string
    do { id = randomUUID() } while (this.sessions.has(id) || this.starts.has(id) || this.drafts.has(id))
    const summary = this.newSummary(id, workspaceId)
    const store = this.options.store
    const session = this.options.createSession(resolveDirectory, store && { summary, store }, permissionMode, id)
    store?.save(id, { summary, permissionMode })
    this.sessions.set(id, { summary, session })
    void session.initialize?.()?.catch(() => undefined)
    return summary
  }

  async start(input: FirstMessage, submit: (session: T) => Promise<SubmissionAccepted | SubmissionHandled>): Promise<StartedSession> {
    this.ensureOpen()
    const id = input.clientMessageId
    const draftId = input.draftSessionId ?? id
    const previous = this.starts.get(id)
    if (previous) {
      if (previous.input.workspaceId !== input.workspaceId || previous.input.draftSessionId !== input.draftSessionId || !sameSelection(runSelection(previous.input), runSelection(input)) || previous.input.text !== input.text || previous.input.permissionMode !== input.permissionMode) {
        throw new SessionSubmitError('busy', '此临时编号已用于另一条首次发送')
      }
      return previous.result
    }
    const history = this.options.store?.loadSession(draftId)
    if (history) {
      const run = history.runs[0]
      if (run?.kind !== 'task' || run.clientMessageId !== id || history.summary.workspaceId !== input.workspaceId
        || run.text !== input.text || run.firstPermissionMode !== input.permissionMode || !sameSelection(runSelection(run), runSelection(input))) {
        throw new SessionSubmitError('busy', '此临时编号已用于另一条首次发送')
      }
      return { session: history.summary, accepted: submissionReceipt(run) }
    }
    if (this.sessions.has(draftId)) throw new SessionSubmitError('busy', '此会话编号已被使用')
    if (input.text.trim() === '/compact') throw new SessionSubmitError('invalid', '新会话没有可压缩的内容')
    const result = this.acceptFirst(input, submit)
    this.starts.set(id, { input, result })
    try {
      const accepted = await result
      if (this.options.store && 'session' in accepted) this.starts.delete(id)
      return accepted
    } catch (error) { this.starts.delete(id); throw error }
  }

  private async acceptFirst(input: FirstMessage, submit: (session: T) => Promise<SubmissionAccepted | SubmissionHandled>): Promise<StartedSession> {
    const id = input.draftSessionId ?? input.clientMessageId
    const previous = this.drafts.get(id)
    if (previous && previous.workspaceId !== input.workspaceId) throw new SessionSubmitError('busy', '草稿属于另一个工作区')
    const pending = previous?.pending ?? this.createDraft(id, input)
    if (!previous) this.drafts.set(id, { workspaceId: input.workspaceId, pending })
    let draft: Draft<T> | undefined
    let submitting = false
    try {
      draft = await pending
      this.ensureOpen()
      if (draft.submitting || this.sessions.has(id)) throw new SessionSubmitError('busy', '草稿正在发送首条消息')
      submitting = draft.submitting = true
      const { session, summary } = draft
      const accepted = await submit(session)
      if (accepted.kind === 'handled') return { ...accepted, draftSessionId: id }
      if (!this.sessions.has(id)) {
        this.sessions.set(id, { summary, session })
        this.drafts.delete(id)
        this.options.onStarted?.()
      }
      return { session: summary, accepted }
    } catch (error) {
      if (!previous && !this.sessions.has(id)) {
        this.drafts.delete(id)
        if (draft) await draft.close()
      }
      throw error
    } finally {
      if (submitting && draft) draft.submitting = false
    }
  }

  private async createDraft(id: string, input: FirstMessage): Promise<Draft<T>> {
    const resolveDirectory = await this.validateWorkspace(input.workspaceId)
    const permissionMode = input.permissionMode ?? await this.options.getDefaultPermissionMode?.() ?? 'normal'
    this.ensureOpen()
    const summary = this.newSummary(id, input.workspaceId)
    const store = this.options.store
    const session = this.options.createSession(resolveDirectory, store && {
      summary, store, first: () => Object.assign(summary, this.newSummary(summary.id, summary.workspaceId)),
    }, permissionMode, id)
    let closing: Promise<void> | undefined
    return { summary, session,
      close: () => closing ??= Promise.resolve().then(() => session.close?.()) }
  }

  private ensureOpen() {
    if (this.closing) throw new SessionSubmitError('closed', '服务正在关闭')
  }

  private async validateWorkspace(workspaceId: string): Promise<() => Promise<string>> {
    this.ensureOpen()
    const resolveDirectory = () => this.options.resolveDirectory(workspaceId)
    await resolveDirectory()
    return resolveDirectory
  }

  private newSummary(id: string, workspaceId: string): SessionSummary {
    const number = this.list().filter(summary => summary.workspaceId === workspaceId).length + 1
    return { id, workspaceId, name: `会话 ${number}`, createdAt: new Date().toISOString() }
  }

  list(): SessionSummary[] {
    return this.options.store?.listSessions() ?? [...this.sessions.values()].map(({ summary }) => summary)
  }

  get(sessionId: string): T | undefined {
    const cached = this.sessions.get(sessionId)
    if (cached) return cached.session
    const store = this.options.store
    const history = store?.loadSession(sessionId)
    if (!store || !history) return undefined
    const { summary } = history
    const session = this.options.createSession(() => this.options.resolveDirectory(summary.workspaceId), { store, summary, history })
    this.sessions.set(sessionId, { summary, session })
    void session.initialize?.()?.catch(() => undefined)
    return session
  }

  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...[...this.sessions.values()].map(async ({ session }) => session.close?.()),
        ...[...this.drafts.values()].map(async ({ pending }) => {
          const draft = await pending.catch(() => undefined)
          await draft?.close()
        }),
      ])
      await this.options.closeTools?.()
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
  }
}
