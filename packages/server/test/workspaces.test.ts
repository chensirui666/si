import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { WorkspaceBindingError, Workspaces } from '../src/workspaces.js'

test('迁移旧登记后保留编号，允许多个目录并发去重和重启恢复', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'agent-learning-workspaces-')))
  try {
    const a = join(temp, 'a'), b = join(temp, 'b'), alias = join(temp, 'alias'), file = join(temp, 'workspaces.json')
    await Promise.all([mkdir(a), mkdir(b)])
    await symlink(b, alias, 'dir')
    const original = { id: 'old-id', path: a }
    await writeFile(file, JSON.stringify({ workspaces: [original], boundWorkspaceId: original.id }), { mode: 0o600 })
    const workspaces = new Workspaces(file)
    expect(await workspaces.view()).toEqual({ workspaces: [{ ...original, name: 'a', available: true }] })
    const added = await Promise.all([workspaces.register(b), workspaces.register(alias)])
    expect(added.filter(item => item.created)).toHaveLength(1)
    const id = added[0]!.workspaceId
    expect(added[1]!.workspaceId).toBe(id)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ workspaces: [original, { id, path: b }] })
    const restarted = new Workspaces(file)
    expect((await restarted.view()).workspaces.map(item => item.id)).toEqual([original.id, id])
    expect(await restarted.resolveDirectory(original.id)).toBe(a)
    expect(await restarted.resolveDirectory(id)).toBe(b)
    await rename(b, join(temp, 'moved'))
    expect((await restarted.view()).workspaces[1]).toMatchObject({ id, available: false })
    await expect(restarted.resolveDirectory(id)).rejects.toBeInstanceOf(WorkspaceBindingError)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
