import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { errorCode, readRegularFile, tooLarge } from './regular-file.js'

export type SubagentScope = 'user' | 'project' | 'both'
export type SubagentRoleSummary = {
  name: string
  description: string
  source: 'user' | 'project'
  path: string
}
export type SubagentRole = SubagentRoleSummary & {
  systemPrompt: string
  tools?: string[]
  model?: string
}

type RoleSource = SubagentRoleSummary['source']
type DiscoveryOptions = {
  home?: string
  workspace: string
  projectEnabled: boolean
  scope?: SubagentScope
  onWarning?: (diagnostic: { path: string; reason: string }) => void
}

const maxRoleBytes = 256 * 1024
const projectDisabled = '当前工作区未启用项目子 Agent 角色。'

class InvalidRole extends Error {}

function roleDirectory(options: DiscoveryOptions, source: RoleSource) {
  const base = source === 'user' ? options.home ?? homedir() : options.workspace
  return resolve(base, '.si', 'agents')
}

async function projectRoleDirectory(options: DiscoveryOptions, directory: string) {
  const home = options.home ?? homedir()
  const workspace = await realpath(options.workspace)
  if (workspace === await realpath(home).catch(() => resolve(home))) return undefined
  const canonical = await realpath(directory)
  if (canonical !== join(workspace, '.si', 'agents')) {
    throw new InvalidRole('项目角色目录必须位于登记的工作区内。')
  }
  return canonical
}

async function readRole(path: string, source: RoleSource, projectDirectory?: string): Promise<SubagentRole> {
  const target = projectDirectory === undefined ? path : await realpath(path)
  if (projectDirectory !== undefined && dirname(target) !== projectDirectory) {
    throw new InvalidRole('角色文件必须位于项目角色目录内。')
  }
  const buffer = await readRegularFile(target, maxRoleBytes)
  if (buffer === tooLarge) throw new InvalidRole('角色文件超过 256 KiB。')
  if (!buffer) throw new InvalidRole('角色文件必须是普通文件。')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  catch { throw new InvalidRole('角色文件必须使用 UTF-8 编码。') }
  const header = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text)
  if (header?.index !== 0) throw new InvalidRole('角色文件缺少 YAML 文件头。')
  const doc = parseDocument(header[1])
  if (doc.errors.length || !isMap(doc.contents)) throw new InvalidRole('角色文件的 YAML 文件头无效。')

  const name = doc.get('name'), description = doc.get('description'), model = doc.get('model')
  if (typeof name !== 'string' || !name.trim()) throw new InvalidRole('角色文件缺少有效的 name。')
  if (typeof description !== 'string' || !description.trim()) throw new InvalidRole('角色文件缺少有效的 description。')
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw new InvalidRole('角色文件的 model 必须是非空字符串。')
  }

  const toolNode = doc.get('tools', true)
  let tools: string[] | undefined
  if (toolNode !== undefined) {
    const entries = isSeq(toolNode) ? toolNode.items.map(item => isScalar(item) ? item.value : undefined)
      : isScalar(toolNode) && typeof toolNode.value === 'string' ? toolNode.value.split(',') : undefined
    if (!entries || !entries.every((item): item is string => typeof item === 'string' && Boolean(item.trim()))) {
      throw new InvalidRole('角色文件的 tools 必须是工具名称列表。')
    }
    tools = entries.map(item => item.trim())
  }
  return {
    name: name.trim(), description: description.trim(), source, path, systemPrompt: text.slice(header[0].length).trim(),
    ...(tools !== undefined && { tools }),
    ...(model !== undefined && { model: model.trim() }),
  }
}

function failureReason(error: unknown) {
  if (error instanceof InvalidRole) return error.message
  const code = errorCode(error)
  if (code === 'ENOENT') return '角色文件已移走或删除。'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限读取角色文件。'
  return '无法读取角色文件。'
}

async function scanRoles(options: DiscoveryOptions, source: RoleSource) {
  const directory = roleDirectory(options, source)
  const roles = new Map<string, SubagentRoleSummary>()
  try {
    const projectDirectory = source === 'project' ? await projectRoleDirectory(options, directory) : undefined
    if (source === 'project' && !projectDirectory) return roles
    const entries = await readdir(projectDirectory ?? directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!entry.name.endsWith('.md') || !(entry.isFile() || entry.isSymbolicLink())) continue
      const path = join(directory, entry.name)
      try {
        const { name, description } = await readRole(path, source, projectDirectory)
        if (roles.has(name)) throw new InvalidRole(`存在同名角色「${name}」。`)
        roles.set(name, { name, description, path, source })
      } catch (error) {
        options.onWarning?.({ path, reason: failureReason(error) })
      }
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      options.onWarning?.({ path: directory, reason: error instanceof InvalidRole ? error.message : '无法读取子 Agent 角色目录。' })
    }
  }
  return roles
}

export async function discoverSubagentRoles(options: DiscoveryOptions): Promise<SubagentRoleSummary[]> {
  const [user, project] = await Promise.all([
    options.scope !== 'project' ? scanRoles(options, 'user') : undefined,
    options.scope !== 'user' && options.projectEnabled ? scanRoles(options, 'project') : undefined,
  ])
  return [...new Map([...(user ?? []), ...(project ?? [])]).values()]
}

export async function resolveSubagentRole(name: string, options: DiscoveryOptions & { selected?: SubagentRoleSummary }): Promise<SubagentRole> {
  if (options.scope === 'project' && !options.projectEnabled) throw new Error(projectDisabled)
  const { selected, scope = 'both' } = options
  const summary = selected?.name === name && (scope === 'both' || scope === selected.source)
    ? selected : (await discoverSubagentRoles(options)).find(role => role.name === name)
  if (!summary) {
    const authorization = scope !== 'user' && !options.projectEnabled ? projectDisabled : ''
    throw new Error(`找不到子 Agent 角色「${name}」。${authorization}`)
  }
  const { source, path } = summary
  if (source === 'project' && !options.projectEnabled) throw new Error(projectDisabled)
  const directory = roleDirectory(options, source)
  if (dirname(path) !== directory) throw new Error('所选子 Agent 角色已离开原角色目录。')
  try {
    const projectDirectory = source === 'project' ? await projectRoleDirectory(options, directory) : undefined
    if (source === 'project' && !projectDirectory) throw new InvalidRole('项目角色目录已不可用。')
    const role = await readRole(path, source, projectDirectory)
    if (role.name !== name) throw new InvalidRole('角色文件中的 name 已变更。')
    return role
  } catch (error) {
    throw new Error(`无法启动子 Agent 角色「${name}」。${failureReason(error)}`)
  }
}
