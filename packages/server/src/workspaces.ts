import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { readCredentialFile, withCredentialFileLock, writeCredentialFile } from '@agent-learning/credentials'

type Workspace = { id: string; path: string }
type WorkspaceFile = { workspaces: Workspace[]; boundWorkspaceId: string | null }
export type WorkspaceView = {
  workspaces: (Workspace & { name: string; available: boolean })[]
  boundWorkspaceId: string | null
}
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
    if (contents === undefined) return { workspaces: [], boundWorkspaceId: null }
    const file = JSON.parse(contents) as Partial<WorkspaceFile> | null
    if (!file || !Array.isArray(file.workspaces)
      || !file.workspaces.every(workspace => workspace && typeof workspace.id === 'string' && workspace.id
        && typeof workspace.path === 'string' && isAbsolute(workspace.path))
      || new Set(file.workspaces.map(workspace => workspace.id)).size !== file.workspaces.length
      || new Set(file.workspaces.map(workspace => workspace.path)).size !== file.workspaces.length
      || !(file.boundWorkspaceId === null || file.workspaces.some(workspace => workspace.id === file.boundWorkspaceId))) {
      throw new Error('工作区登记文件无效，请修复后重试。')
    }
    return file as WorkspaceFile
  }

  async view(): Promise<WorkspaceView> {
    const file = await this.read()
    const workspaces = await Promise.all(file.workspaces.map(async workspace => ({
      id: workspace.id, path: workspace.path, name: basename(workspace.path) || workspace.path,
      available: await directory(workspace.path).then(path => path === workspace.path, () => false),
    })))
    return { workspaces, boundWorkspaceId: file.boundWorkspaceId }
  }

  async register(path: string): Promise<WorkspaceView> {
    const canonical = await directory(path).catch(() => { throw new WorkspaceBindingError('选中的文件夹当前不可用。') })
    await withCredentialFileLock(this.filename, async () => {
      const file = await this.read()
      const existing = file.workspaces.find(workspace => workspace.path === canonical)
      if (existing && file.boundWorkspaceId !== null) return
      const workspace = existing ?? { id: randomUUID(), path: canonical }
      if (!existing) file.workspaces.push(workspace)
      file.boundWorkspaceId ??= workspace.id
      await writeCredentialFile(this.filename, JSON.stringify(file, null, 2) + '\n')
    })
    return this.view()
  }

  async resolveBoundDirectory(id: string): Promise<string> {
    const file = await this.read()
    if (file.boundWorkspaceId !== id) throw new WorkspaceBindingError('请进入已绑定的工作区对话后发送。')
    const workspace = file.workspaces.find(workspace => workspace.id === id)!
    const path = await directory(workspace.path).catch(() => undefined)
    if (path !== workspace.path) throw new WorkspaceBindingError('工作区文件夹当前不可用。')
    return path
  }
}
