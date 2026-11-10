import { randomUUID } from 'node:crypto'
import { SessionSubmitError, type AgentSession } from './agent-session.js'
import type { SubmissionAccepted } from './types.js'

export type SessionSummary = {
  id: string
  workspaceId: string
  name: string
  createdAt: string
}

type FirstMessage = Parameters<AgentSession['submit']>[0] & { workspaceId: string }
type StartedSession = { session: SessionSummary; accepted: SubmissionAccepted }

export class Sessions<T extends { close?: () => Promise<void> }> {
  private readonly sessions = new Map<string, { summary: SessionSummary; session: T }>()
  private readonly starts = new Map<string, { input: FirstMessage; result: Promise<StartedSession> }>()
  private readonly provisional = new Set<() => Promise<void>>()
  private closing?: Promise<void>

  constructor(private readonly options: {
    resolveDirectory(workspaceId: string): Promise<string>
    createSession(resolveDirectory: () => Promise<string>): T
    closeTools?(): Promise<void>
    onStarted?(): void
  }) {}

  async create(workspaceId: string): Promise<SessionSummary> {
    const resolveDirectory = await this.validateWorkspace(workspaceId)
    this.ensureOpen()
    let id: string
    do { id = randomUUID() } while (this.sessions.has(id) || this.starts.has(id))
    return this.register(id, workspaceId, this.options.createSession(resolveDirectory))
  }

  async start(input: FirstMessage, submit: (session: T) => Promise<SubmissionAccepted>): Promise<StartedSession> {
    this.ensureOpen()
    const id = input.clientMessageId
    const previous = this.starts.get(id)
    if (previous) {
      if (previous.input.workspaceId !== input.workspaceId || previous.input.modelId !== input.modelId || previous.input.text !== input.text) {
        throw new SessionSubmitError('busy', '此临时编号已用于另一条首次发送')
      }
      return previous.result
    }
    if (this.sessions.has(id)) throw new SessionSubmitError('busy', '此会话编号已被使用')
    if (input.text.trim() === '/compact') throw new SessionSubmitError('invalid', '新会话没有可压缩的内容')
    const result = this.acceptFirst(input, submit)
    this.starts.set(id, { input, result })
    try { return await result }
    catch (error) { this.starts.delete(id); throw error }
  }

  private async acceptFirst(input: FirstMessage, submit: (session: T) => Promise<SubmissionAccepted>): Promise<StartedSession> {
    const resolveDirectory = await this.validateWorkspace(input.workspaceId)
    this.ensureOpen()
    const session = this.options.createSession(resolveDirectory)
    let closing: Promise<void> | undefined
    const close = () => closing ??= Promise.resolve().then(() => session.close?.())
    this.provisional.add(close)
    try {
      const accepted = await submit(session)
      this.ensureOpen()
      const summary = this.register(input.clientMessageId, input.workspaceId, session)
      this.options.onStarted?.()
      return { session: summary, accepted }
    } catch (error) {
      await close()
      throw error
    } finally { this.provisional.delete(close) }
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

  private register(id: string, workspaceId: string, session: T): SessionSummary {
    const number = this.list().filter(summary => summary.workspaceId === workspaceId).length + 1
    const summary = { id, workspaceId, name: `会话 ${number}`, createdAt: new Date().toISOString() }
    this.sessions.set(id, { summary, session })
    return summary
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(({ summary }) => summary)
  }

  get(sessionId: string): T | undefined {
    return this.sessions.get(sessionId)?.session
  }

  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...[...this.sessions.values()].map(async ({ session }) => session.close?.()),
        ...[...this.provisional].map(close => close()),
      ])
      await this.options.closeTools?.()
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
  }
}
