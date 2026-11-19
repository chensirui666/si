import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { gitBoundary } from './project-context.js'
import { errorCode, readRegularFile, tooLarge } from './regular-file.js'

export type SkillSource = 'project-si' | 'project-agents' | 'user-si' | 'user-agents' | 'bundled'
export type SkillSummary = {
  name: string
  description: string
  source: SkillSource
  path: string
  disableModelInvocation: boolean
}
export type SkillInvocation = Pick<SkillSummary, 'name' | 'source'> & (
  | { status: 'loaded'; body: string; directory: string }
  | { status: 'failed'; reason: string }
)

export const skillCommand = /^\s*\/skill:([^\s]+)(?=\s|$)/

const maxSkillBytes = 256 * 1024
const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

class InvalidSkill extends Error {}

async function readSkill(path: string) {
  const buffer = await readRegularFile(path, maxSkillBytes)
  if (buffer === tooLarge) throw new InvalidSkill('说明文件超过 256 KiB。')
  if (!buffer) throw new InvalidSkill('说明文件必须是普通文件。')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  catch { throw new InvalidSkill('说明文件必须使用 UTF-8 编码。') }
  const header = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text)
  if (header?.index !== 0) throw new InvalidSkill('说明文件缺少 YAML 文件头。')
  const doc = parseDocument(header[1])
  if (doc.errors.length || !isMap(doc.contents)) throw new InvalidSkill('说明文件的 YAML 文件头无效。')
  const name = doc.get('name'), description = doc.get('description')
  if (typeof name !== 'string' || name.length > 64 || !validName.test(name)) throw new InvalidSkill('Skill 名称无效。')
  if (typeof description !== 'string' || !description.trim() || description.trim().length > 1024) {
    throw new InvalidSkill('Skill 描述必须包含 1 至 1024 个字符。')
  }
  return {
    name, description: description.trim(), disableModelInvocation: doc.get('disable-model-invocation') === true,
    body: text.slice(header[0].length).trim(),
  }
}

function failureReason(error: unknown) {
  if (error instanceof InvalidSkill) return error.message
  const code = errorCode(error)
  if (code === 'ENOENT') return '说明文件已移走或删除。'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限读取说明文件。'
  return '无法读取说明文件。'
}

export async function loadSkill({ name, source, path }: SkillSummary): Promise<SkillInvocation> {
  try {
    const skill = await readSkill(path)
    if (skill.name !== name) throw new InvalidSkill('说明文件中的 Skill 名称已变更。')
    return { name, source, status: 'loaded', body: skill.body, directory: dirname(path) }
  } catch (error) {
    return { name, source, status: 'failed', reason: failureReason(error) }
  }
}

export async function discoverSkills(cwd: string, options: { home?: string; applicationRoot?: string } = {}) {
  const home = options.home ?? homedir()
  const personalSi = join(home, '.si', 'skills')
  const personalAgents = join(home, '.agents', 'skills')
  const personalRoots = new Set(await Promise.all([personalSi, personalAgents].map(path => realpath(path).catch(() => path))))
  const skills = new Map<string, SkillSummary>()
  const files = new Set<string>()
  const diagnostics: { path: string; reason: string }[] = []
  let complete = true
  function report(path: string, reason: string, incomplete: boolean) {
    diagnostics.push({ path, reason })
    if (incomplete) complete = false
  }

  async function add(path: string, source: SkillSource) {
    try {
      const real = await realpath(path)
      if (files.has(real)) return
      const { body: _body, ...skill } = await readSkill(path)
      files.add(real)
      if (!skills.has(skill.name)) skills.set(skill.name, { ...skill, source, path })
    } catch (error) {
      report(path, failureReason(error), !(error instanceof InvalidSkill))
    }
  }

  async function scan(root: string, source: SkillSource) {
    const visited = new Set<string>()
    async function visit(directory: string) {
      try {
        const real = await realpath(directory)
        if (visited.has(real) || (source.startsWith('project-') && personalRoots.has(real))) return
        visited.add(real)
        const entries = await readdir(directory, { withFileTypes: true })
        const declared = entries.find(entry => entry.name === 'SKILL.md')
        if (declared && !declared.isDirectory()) {
          await add(join(directory, declared.name), source)
          return
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          const path = join(directory, entry.name)
          const info = entry.isSymbolicLink() ? await stat(path).catch(error => {
            report(path, failureReason(error), true)
            return undefined
          }) : entry
          if (info?.isDirectory()) await visit(path)
          else if (info?.isFile() && entry.name.endsWith('.md') &&
            (source.endsWith('-agents') ? directory !== root : directory === root)) await add(path, source)
        }
      } catch (error) {
        if (directory === root && errorCode(error) === 'ENOENT') return
        report(directory, '无法读取 Skill 目录。', true)
      }
    }
    await visit(root)
  }

  const workspace = resolve(cwd)
  await scan(join(workspace, '.si', 'skills'), 'project-si')
  for (let current = workspace;; current = dirname(current)) {
    await scan(join(current, '.agents', 'skills'), 'project-agents')
    if (current === dirname(current) || await gitBoundary(current)) break
  }
  await scan(personalSi, 'user-si')
  await scan(personalAgents, 'user-agents')
  if (options.applicationRoot) await scan(join(options.applicationRoot, 'resources', 'skills'), 'bundled')
  return { skills: [...skills.values()], complete, diagnostics }
}
