import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defaultSelection, type ModelDiscovery, type ModelSelection } from '@agent-learning/model'
import type { AgentSession } from './agent-session.js'
import type { AgentInputSource } from './collaboration.js'
import type { PermissionMode } from './permissions.js'
import type { SessionStore } from './session-store.js'
import type { SessionSummary } from './sessions.js'
import { discoverSubagentRoles, resolveSubagentRole } from './subagent-roles.js'
import type { SubagentArgs, SubagentTask } from './subagent-tools.js'
import type { Delegation, DelegationItem } from './subagent-types.js'
import type { FinishedBashJob } from './tool-runtime.js'
import type { SubagentView } from './types.js'

export async function resolveSubagentDirectory(path: string) {
  try {
    const cwd = await realpath(path)
    if (!(await stat(cwd)).isDirectory()) throw new Error()
    await access(cwd, constants.X_OK)
    return cwd
  } catch { throw new Error(`子任务工作目录不可用：${path}`) }
}

type RunningBatch = { root: string; controller: AbortController; done: Promise<Delegation> }
type RunArgs = Extract<SubagentArgs, { task?: string }>
type BatchTask = { target: AgentSession; input: Omit<Parameters<AgentSession['runDelegatedTask']>[0], 'text'>; text: string; source: AgentInputSource; discard?: () => Promise<void> }

const stateText: Record<string, string> = {
  idle: '目标会话空闲。', running: '目标会话正在运行或接收任务。', stopping: '目标会话正在停止。',
  review: '目标会话有方案待审核。', queued: '目标会话已有待发任务。', closed: '会话正在关闭。',
}

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }

function resultFor({ id, mode, items }: Delegation) {
  return {
    delegationId: id, status: items.every(item => item.status === 'completed') ? 'completed' : 'incomplete',
    items, ...(mode === 'chain' && { output: items.at(-1)?.output }),
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

export class Subagents {
  private readonly batches = new Map<string, RunningBatch>()
  private readonly slots = new Map<string, number>()
  private readonly capacityListeners = new Set<(root: string) => void>()
  private readonly pendingNames = new Map<string, Set<string>>()
  private readonly stopping = new Map<string, Promise<{ stopped: number; completed: number; unconfirmed: number }>>()
  private closing = false

  constructor(private readonly options: {
    store: SessionStore
    get(id: string): AgentSession | undefined
    activeRun(id: string): string | undefined
    members(root: string): string[]
    create(summary: SessionSummary, permission: PermissionMode): AgentSession
    discard(id: string): Promise<void>
    workspace(id: string): Promise<string>
    projectEnabled(id: string): Promise<boolean>
    models(): Promise<ModelDiscovery>
    stopBash(ids: ReadonlySet<string>): Promise<FinishedBashJob[]>
    home?: string
  }) {}

  private get store() { return this.options.store }

  toolPolicy(id: string) { return this.options.get(id)?.toolPolicy }

  async roleCatalog(workspaceId: string) {
    const workspace = await this.options.workspace(workspaceId)
    const projectEnabled = await this.options.projectEnabled(workspaceId)
    return discoverSubagentRoles({ home: this.options.home, workspace, projectEnabled,
      onWarning: ({ path, reason }) => console.warn('子 Agent 角色无法读取', path, reason) })
  }

  view(sessionId: string): SubagentView {
    const subagents = this.store.listSubagents(sessionId).flatMap(summary => {
      const run = this.store.readSubagentRun(summary.id)
      if (!run) return []
      return [{ sessionId: summary.id, runId: run.id, name: summary.name, status: this.runStatus(summary.id, run) }]
    })
    const delegationOutputs = this.store.listDelegations(sessionId).filter(item => item.background && item.finished).map(item => ({
      assistantMessageId: item.call.assistantMessageId, contentIndex: item.call.contentIndex, output: JSON.stringify(resultFor(item), null, 2),
    }))
    return { subagents, delegationOutputs }
  }

  private runStatus(id: string, run: NonNullable<ReturnType<SessionStore['readSubagentRun']>>) {
    if (this.options.activeRun(id) === run.id) return 'running' as const
    return run.status === 'running' ? 'interrupted' as const : run.status
  }

  private publish(delegation: Delegation) {
    for (const id of new Set([delegation.rootSessionId, delegation.callerSessionId])) {
      this.options.get(id)?.publishSubagentView(this.view(id))
    }
  }

  async stopChild(root: string, id: string, runId?: string) {
    const summary = this.store.readSessionSummary(id)
    if (summary?.subagent?.parentSessionId !== root) return
    const result = this.store.readSubagentRun(id, runId)
    if (!result) return
    if (this.options.activeRun(id) === result.id) await this.options.get(id)?.abort(result.id)
    const settled = this.store.readSubagentRun(id, result.id) ?? result
    this.options.get(root)?.publishSubagentView(this.view(root))
    return { sessionId: id, runId: settled.id, name: summary.name, status: this.runStatus(id, settled) }
  }

  stopAll(root: string) {
    const previous = this.stopping.get(root)
    if (previous) return previous
    const pending = Promise.resolve().then(async () => {
      let stopped = 0, completed = 0, unconfirmed = 0
      const members = new Set([root, ...this.options.members(root)])
      try { for (const child of this.store.listSubagents(root)) members.add(child.id) }
      catch { unconfirmed++ }
      const sessions: AgentSession[] = []
      for (const id of members) {
        try {
          const session = this.options.get(id)
          if (session) sessions.push(session)
        } catch { unconfirmed++ }
      }
      try {
        try { this.store.suppressDelegationReports(root) }
        catch { unconfirmed++ }
        const batches = [...this.batches.values()].filter(batch => batch.root === root)
        for (const batch of batches) batch.controller.abort()
        const agentStops = sessions.map(async session => {
          const active = ['running', 'stopping'].includes(session.agentAdmissionStatus)
          return { active, stopped: await session.stopSessionWork() }
        })
        const bash = this.options.stopBash(members)
        const [agents, jobs, delegations] = await Promise.all([
          Promise.allSettled(agentStops), Promise.allSettled([bash]), Promise.allSettled(batches.map(batch => batch.done)),
        ])
        for (const result of agents) {
          if (result.status === 'rejected') unconfirmed++
          else if (result.value.stopped) stopped++
          else if (result.value.active) completed++
        }
        for (const result of jobs) {
          if (result.status === 'rejected') { unconfirmed++; continue }
          for (const job of result.value) {
            if (job.status === 'stopped') stopped++
            else if (job.status === 'exited') completed++
            else unconfirmed++
          }
        }
        unconfirmed += delegations.filter(result => result.status === 'rejected').length
        try { this.options.get(root)?.publishSubagentView(this.view(root)) }
        catch { unconfirmed++ }
        return { stopped, completed, unconfirmed }
      } finally {
        for (const session of sessions) session.finishSessionStop()
        this.stopping.delete(root)
      }
    })
    this.stopping.set(root, pending)
    return pending
  }

  recover() {
    for (const item of this.store.recoverDelegations()) {
      try { this.deliverReport(item) }
      catch (error) { console.error('子 Agent 报告补送失败', error) }
    }
  }

  async close() {
    this.closing = true
    for (const batch of this.batches.values()) batch.controller.abort()
    await Promise.allSettled([...this.batches.values()].map(batch => batch.done))
  }

  private deliverReport(delegation: Delegation) {
    if (delegation.report !== 'pending' || this.closing) return
    if (this.stopping.has(delegation.rootSessionId)) {
      this.store.setDelegationReport(delegation.id, 'suppressed')
      return
    }
    const target = this.options.get(delegation.callerSessionId)
    const members = delegation.items.map(item => item.name ?? item.sessionId).filter(Boolean)
    const source = { kind: 'report' as const, sessionId: delegation.items.length === 1
      ? delegation.items[0]?.sessionId ?? delegation.id : delegation.id, name: members.join('、') || '子 Agent' }
    const receipt = target?.receiveAgentInput(`report:${delegation.id}`, source,
      `[后台完成报告 · ${source.name}]\n${JSON.stringify(resultFor(delegation))}`)
    if (receipt?.status === 'accepted') this.store.setDelegationReport(delegation.id, 'delivered')
  }

  private async reserveSlot(root: string, signal: AbortSignal, wait: boolean) {
    signal.throwIfAborted()
    while ((this.slots.get(root) ?? 0) >= 8) {
      if (!wait) throw new Error('已达到当前会话的 8 个子任务并发上限。')
      await new Promise<void>((resolve, reject) => {
        const clear = () => {
          this.capacityListeners.delete(available)
          signal.removeEventListener('abort', cancel)
        }
        const available = (id: string) => { if (id === root) { clear(); resolve() } }
        const cancel = () => { clear(); reject(signal.reason) }
        this.capacityListeners.add(available)
        signal.addEventListener('abort', cancel, { once: true })
      })
      signal.throwIfAborted()
    }
    this.slots.set(root, (this.slots.get(root) ?? 0) + 1)
    return () => {
      const count = this.slots.get(root) ?? 1
      if (count === 1) this.slots.delete(root)
      else this.slots.set(root, count - 1)
      for (const available of this.capacityListeners) available(root)
    }
  }

  private async prepareNew(parent: AgentSession, task: SubagentTask, scope: RunArgs['agentScope'], signal: AbortSignal): Promise<BatchTask> {
    const { id, workspaceId, name: parentName } = parent.delegationSession!
    const context = parent.delegationContext
    const { selection, permissionMode } = context
    if (!selection || !context.cwd) throw new Error('当前会话缺少模型或工作目录。')
    const taskText = task.task.trim()
    if (!taskText) throw new Error('请填写子任务。')
    const nameHint = task.name?.trim()
    if (task.name !== undefined && (!nameHint || nameHint === 'parent')) throw new Error('子 Agent 名称无效。')
    const role = task.agent && await resolveSubagentRole(task.agent, {
      home: this.options.home, workspace: await this.options.workspace(workspaceId),
      projectEnabled: await this.options.projectEnabled(workspaceId), scope,
      selected: context.roleCatalog.find(item => item.name === task.agent),
    })
    const model = role && role.model ? await this.roleModel(role.model) : selection
    const cwd = await resolveSubagentDirectory(resolve(context.cwd, task.cwd ?? ''))
    signal.throwIfAborted()
    const occupied = new Set(this.store.listSubagents(id).map(item => item.name))
    const names = this.pendingNames.get(id) ?? new Set<string>()
    const base = nameHint ?? (role ? role.name === 'parent' ? 'parent-2' : role.name : 'worker')
    let name = base
    for (let suffix = 2; occupied.has(name) || names.has(name); suffix++) {
      if (nameHint) throw new Error(`子 Agent 名称已使用：${nameHint}`)
      name = `${base}-${suffix}`
    }
    names.add(name)
    this.pendingNames.set(id, names)
    const childId = randomUUID()
    const child = this.options.create({
      id: childId, workspaceId, name, createdAt: new Date().toISOString(),
      subagent: {
        parentSessionId: id, cwd,
        ...(role && { role: { name: role.name, source: role.source, systemPrompt: role.systemPrompt, tools: role.tools,
          ...(role.source === 'project' && { workspaceId }) } }),
        allowedTools: context.tools.filter(tool => !role || role.tools === undefined || role.tools.includes(tool)),
        ...(context.mcpToolKeys.length && { mcpToolKeys: context.mcpToolKeys }),
      },
    }, permissionMode)
    return {
      target: child, input: { ...model, permissionMode }, source: { kind: 'task', sessionId: id, name: parentName },
      text: 'Task: ' + taskText,
      discard: async () => {
        names.delete(name)
        if (!names.size) this.pendingNames.delete(id)
        if (!this.store.readSessionSummary(childId)) await this.options.discard(childId)
      },
    }
  }

  async authorizeRole(summary: SessionSummary) {
    if (summary.subagent?.role?.source === 'project' && !await this.options.projectEnabled(summary.workspaceId)) {
      throw new Error('该工作区未启用项目子 Agent 角色。')
    }
  }

  private async roleModel(id: string): Promise<ModelSelection> {
    const { models } = await this.options.models()
    const matches = models.filter(model => id === model.id || id === `${model.provider}/${model.id}`)
    if (matches.length !== 1) throw new Error(`子 Agent 角色模型不可用或不唯一：${id}`)
    return defaultSelection(matches[0]!)
  }

  async execute(caller: AgentSession, args: SubagentArgs, call: Delegation['call'], signal: AbortSignal) {
    signal.throwIfAborted()
    const summary = caller.delegationSession!
    const parent = summary.subagent?.parentSessionId
    const root = parent ?? summary.id
    if (this.closing) throw new Error(stateText.closed)
    if (this.stopping.has(root)) throw new Error(stateText.stopping)
    const members = this.store.listSubagents(root).filter(child => child.id !== summary.id)
    if (args.action === 'list' || args.action === 'status' && !args.sessionId && !args.name) {
      return { agents: this.view(root).subagents.filter(child => child.sessionId !== summary.id) }
    }
    if (args.action === 'run') {
      if (parent) throw new Error('子 Agent 只能使用 team 协作。')
      return this.run(caller, args, call, signal)
    }
    if (args.sessionId && args.name) throw new Error('请只提供 sessionId 或 name。')
    const match = members.find(item => args.sessionId === item.id || args.name === item.name)
    const targetsParent = parent && args.action !== 'answer' && (args.name === 'parent' || args.sessionId === parent)
    const targetId = targetsParent ? parent : match?.id
    if (!targetId) throw new Error('找不到该会话范围内的目标子 Agent。')
    if (args.action === 'status') return this.view(root).subagents.find(item => item.sessionId === targetId)
    if (args.action === 'stop') return this.stopChild(root, targetId)
    if (args.action === 'answer') {
      const output = this.latestAnswer(targetId)
      return { sessionId: targetId, output, ...(output === null && { message: '同伴尚无已完成答复。' }) }
    }
    const target = this.options.get(targetId)
    if (!target) throw new Error('目标会话不可用。')
    const message = args.message?.trim()
    if (!message) throw new Error('请填写要传递的消息。')
    const text = `[来自 ${summary.subagent ? '子 Agent' : '主 Agent'}「${summary.name}」]\n${message}`
    if (args.action === 'steer') {
      const targetReceipt = target.receiveAgentInput(`steer:${summary.id}:${call.assistantMessageId}:${call.contentIndex}`,
        { kind: 'steer', sessionId: summary.id, name: summary.name }, text)
      return { ...targetReceipt, message: targetReceipt.status === 'accepted' ? '当前轮已接收插话。' : stateText[targetReceipt.status] }
    }
    if (args.background === undefined) throw new Error('请明确提供 background。')
    const status = target.agentAdmissionStatus
    if (status !== 'idle') return { status, message: stateText[status] }
    const selection = target.delegationSelection
    if (!selection) throw new Error('目标会话没有可用模型。')
    const delegation: Delegation = {
      id: randomUUID(), callerSessionId: summary.id, rootSessionId: root, call, mode: 'continue', background: args.background,
      items: [{ status: 'not-started', sessionId: targetId, name: target.delegationSession?.name }],
    }
    const source: AgentInputSource = { kind: 'continue', sessionId: summary.id, name: summary.name }
    return this.start(delegation, [async () => ({ target, input: selection, text, source })], signal, !parent)
  }

  private latestAnswer(id: string) {
    const history = this.store.loadSession(id)
    if (!history) return null
    const completed = new Set(history.runs.filter(run => run.status === 'completed').map(run => run.id))
    let runId = '', output: string | null = null
    for (const { id: messageId, message, steering, extension } of history.messages) {
      if (message.role === 'user' && !steering && !extension) runId = messageId
      if (message.role !== 'assistant' || !completed.has(runId) || !['stop', 'length'].includes(message.stopReason)) continue
      const answer = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (answer.trim()) output = answer
    }
    return output
  }

  private run(caller: AgentSession, args: RunArgs, call: Delegation['call'], signal: AbortSignal) {
    if (args.background === undefined) throw new Error('请明确提供 background。')
    if (Number(args.task !== undefined) + Number(args.tasks !== undefined) + Number(args.chain !== undefined) !== 1) {
      throw new Error('请在 task、tasks 和 chain 中选择一种委派方式。')
    }
    const tasks = args.tasks ?? args.chain ?? [{ task: args.task!, agent: args.agent, name: args.name, cwd: args.cwd }]
    const root = caller.delegationSession!.id
    const delegation: Delegation = {
      id: randomUUID(), callerSessionId: root, rootSessionId: root, call, background: args.background,
      mode: args.chain ? 'chain' : args.tasks ? 'parallel' : 'single', items: tasks.map(task => ({ status: 'not-started', name: task.name })),
    }
    const prepare = tasks.map(task => (signal: AbortSignal, previous: string) => this.prepareNew(caller,
      args.chain ? { ...task, task: task.task.replaceAll('{previous}', () => previous) } : task, args.agentScope, signal))
    return this.start(delegation, prepare, signal, true)
  }

  private async start(delegation: Delegation, prepare: ((signal: AbortSignal, previous: string) => Promise<BatchTask>)[],
    callerSignal: AbortSignal, cancelTarget: boolean) {
    const { id, rootSessionId: root, items, background, mode } = delegation
    const ownsExecution = cancelTarget && !background
    const single = mode === 'continue' || mode === 'single'
    if ((this.slots.get(root) ?? 0) >= 8 && items.some(item => item.sessionId !== root)) {
      throw new Error('已达到当前会话的 8 个子任务并发上限。')
    }
    this.store.createDelegation(delegation)
    const controller = new AbortController()
    const batchSignal = ownsExecution ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal
    const admissionSignal = !ownsExecution && single ? AbortSignal.any([batchSignal, callerSignal]) : batchSignal
    let admit!: (receipt: { runId: string; sessionId: string } | null) => void
    const admitted = new Promise<{ runId: string; sessionId: string } | null>(resolve => { admit = resolve })
    let next = 0, previous = '', chainFailed = false
    const worker = async () => {
      while (!batchSignal.aborted && !chainFailed && next < prepare.length) {
        const index = next++
        let release: (() => void) | undefined
        let task: BatchTask | undefined
        let runId: string | undefined
        try {
          if (items[index]?.sessionId !== root) release = await this.reserveSlot(root, admissionSignal, !single)
          task = await prepare[index]!(admissionSignal, previous)
          const start = await task.target.runDelegatedTask({ ...task.input, text: task.text },
            { id, index, source: task.source }, admissionSignal)
          if (start.status !== 'accepted') throw new Error(stateText[start.status] ?? '目标未接收任务。')
          runId = start.runId
          const sessionId = task.target.delegationSession!.id
          this.publish(delegation)
          if (single) admit({ runId, sessionId })
          const stop = () => { void task!.target.abort(start.runId).catch(() => undefined) }
          if (batchSignal.aborted) stop()
          else batchSignal.addEventListener('abort', stop, { once: true })
          try {
            const result = await start.done
            if (mode === 'chain') {
              previous = result.output ?? ''
              chainFailed = result.status !== 'completed'
            }
          } finally { batchSignal.removeEventListener('abort', stop) }
        } catch (error) {
          if (runId) throw error
          this.store.updateDelegationItem({ id, index, item: { status: admissionSignal.aborted ? 'aborted' : 'failed', error: errorText(error) } })
          if (single) admit(null)
          if (mode === 'chain') chainFailed = true
        } finally {
          try { await task?.discard?.() }
          finally { release?.() }
          this.publish(delegation)
        }
      }
    }
    const done = Promise.resolve().then(async () => {
      try {
        const workers = Array.from({ length: mode === 'parallel' ? Math.min(4, items.length) : 1 }, worker)
        const halted = (await Promise.allSettled(workers)).find(item => item.status === 'rejected')
        if (halted?.status === 'rejected') throw halted.reason
        const result = this.store.finishDelegation(id)
        this.publish(result)
        if (result.items.some(item => item.runId)) this.deliverReport(result)
        else if (result.report === 'pending') this.store.setDelegationReport(id, 'suppressed')
        return result
      } finally {
        admit(null)
        this.batches.delete(id)
      }
    })
    this.batches.set(id, { root, controller, done })
    void done.catch(error => console.error('子 Agent 任务收尾失败', error))
    if (background) {
      const receipt = single ? await admitted : undefined
      if (receipt === null) return resultFor(await done)
      return { delegationId: id, status: 'accepted', background: true, ...receipt }
    }
    if (ownsExecution) return resultFor(await done)
    return resultFor(await withAbort(done, callerSignal))
  }
}
