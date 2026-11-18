import type { ConversationMessage, PlanState } from './types.js'

export function planCommandArgument(text: string): string | undefined {
  const match = /^\/plan(?:\s+([\s\S]+))?$/u.exec(text.trim())
  return match ? match[1] ?? '' : undefined
}

export const planInstruction = `当前处于计划模式。先用可用的调查工具了解任务，可以提出澄清问题。请勿更改文件。
有足够信息时，在用户可见回复中使用独立的 Plan: 标题，接着每行一条编号步骤（1. 步骤）。用户确认后才开始执行。`

export const planReadTools = new Set(['read', 'grep', 'find', 'ls', 'web_search', 'web_fetch'])
export const planBashDescription = '仅运行 Git 调查命令（git status、git diff 及已允许的只读选项）。'

const statusOptions = new Set(['--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=v1', '--porcelain=v2'])
const diffOptions = new Set(['--stat', '--name-only', '--name-status', '--cached', '--staged'])

export function planGitArgs(command: unknown): string[] | undefined {
  if (typeof command !== 'string' || !/^[ \t]*git[ \t]+(?:status|diff)(?:[ \t]+[-a-z0-9=]+)*[ \t]*$/.test(command)
    || /[\r\n]/.test(command)) return
  const [, verb, ...options] = command.trim().split(/[ \t]+/)
  const allowed = verb === 'status' ? statusOptions : diffOptions
  if (options.every(option => allowed.has(option))) return [verb!, ...options]
}

export function extractPlan(entry: ConversationMessage | undefined): Extract<PlanState, { state: 'review' }> | undefined {
  if (entry?.message.role !== 'assistant' || entry.message.stopReason !== 'stop') return
  const text = entry.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  let steps: string[] | undefined
  let fence: string | undefined
  let listing = false
  let continuationIndent = 0
  let blanks = 0
  for (const line of text.split(/\r?\n/)) {
    const blank = !line.trim()
    const indent = /^[ \t]*/.exec(line)![0].replaceAll('\t', '    ').length
    if (listing && steps?.length && !blank && indent >= continuationIndent) {
      steps[steps.length - 1] += '\n'.repeat(blanks + 1) + line
      blanks = 0
      continue
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) {
        fence = marker
        listing = false
      } else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence) continue
    if (/^ {0,3}(?:#{1,6}[ \t]+)?(?:\*\*)?Plan:(?:\*\*)?[ \t]*$/i.test(line)) {
      steps = []
      listing = true
      blanks = 0
      continue
    }
    if (!listing || !steps) continue
    if (blank) { blanks++; continue }
    const step = /^( {0,3}\d+[.)][ \t]+)(\S.*?)\s*$/.exec(line)
    if (step) {
      steps.push(step[2])
      continuationIndent = step[1].replaceAll('\t', '    ').length
    } else listing = false
    blanks = 0
  }
  if (steps?.length) return { state: 'review', assistantMessageId: entry.id, steps }
}
