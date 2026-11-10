import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { readCredentialFile, withCredentialFileLock, writeCredentialFile } from '@agent-learning/credentials'

type Workspace = { id: string; path: string }
type WorkspaceFile = { workspaces: Workspace[] }
export type WorkspaceView = {
  workspaces: (Workspace & { name: string; available: boolean })[]
}
export type WorkspaceRegistration = { workspaceId: string; created: boolean; view: WorkspaceView }
export class WorkspaceBindingError extends Error {}

async function directory(path: string) {
  if (!isAbsolute(path)) throw new Error('请选择本机文件夹。')
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory()) throw new Error('请选择本机文件夹。')
  await access(canonical, constants.X_OK)
  return canonical
}

export class Workspaces {
  constructor(private readonly filename = join(homedir(), '.agent-learning', 'workspaces.json')) {}

  private async read(): Promise<WorkspaceFile> {
    const contents = await readCredentialFile(this.filename)
    if (contents === undefined) return { workspaces: [] }
    const file = JSON.parse(contents) as Partial<WorkspaceFile> | null
    if (!file || !Array.isArray(file.workspaces)
      || !file.workspaces.every(workspace => workspace && typeof workspace.id === 'string' && workspace.id
        && typeof workspace.path === 'string' && isAbsolute(workspace.path))
      || new Set(file.workspaces.map(workspace => workspace.id)).size !== file.workspaces.length
      || new Set(file.workspaces.map(workspace => workspace.path)).size !== file.workspaces.length) {
      throw new Error('工作区登记文件无效，请修复后重试。')
    }
    return { workspaces: file.workspaces }
  }

  async view(): Promise<WorkspaceView> {
    const file = await this.read()
    const workspaces = await Promise.all(file.workspaces.map(async workspace => ({
      id: workspace.id, path: workspace.path, name: basename(workspace.path) || workspace.path,
      available: await directory(workspace.path).then(path => path === workspace.path, () => false),
    })))
    return { workspaces }
  }

  async register(path: string): Promise<WorkspaceRegistration> {
    const canonical = await directory(path).catch(() => { throw new WorkspaceBindingError('选中的文件夹当前不可用。') })
    const registration = await withCredentialFileLock(this.filename, async () => {
      const file = await this.read()
      const existing = file.workspaces.find(workspace => workspace.path === canonical)
      if (existing) return { workspaceId: existing.id, created: false }
      const workspace = { id: randomUUID(), path: canonical }
      file.workspaces.push(workspace)
      await writeCredentialFile(this.filename, JSON.stringify(file, null, 2) + '\n')
      return { workspaceId: workspace.id, created: true }
    })
    return { ...registration, view: await this.view() }
  }

  async resolveDirectory(id: string): Promise<string> {
    const file = await this.read()
    const workspace = file.workspaces.find(workspace => workspace.id === id)
    if (!workspace) throw new WorkspaceBindingError('找不到该工作区。')
    const path = await directory(workspace.path).catch(() => undefined)
    if (path !== workspace.path) throw new WorkspaceBindingError('工作区文件夹当前不可用。')
    return path
  }
}
