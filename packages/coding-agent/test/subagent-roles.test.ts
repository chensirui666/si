import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { discoverSubagentRoles, resolveSubagentRole } from '../src/subagent-roles.js'

let root: string, home: string, workspace: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'si-subagent-roles-')))
  home = join(root, 'home')
  workspace = join(root, 'workspace')
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function put(base: string, file: string, header: string, body = 'Role instructions') {
  const path = join(base, '.si', 'agents', file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `---\n${header}\n---\n${body}\n`)
  return path
}

test('discovers authorized summaries and resolves the project override or explicit personal role', async () => {
  const personal = await put(home, 'review.md', 'name: review\ndescription: Personal review')
  const project = await put(workspace, 'review.md', 'name: review\ndescription: >\n  Project review\n  for this workspace\ntools: [read, grep]\nmodel: provider/model', 'Project instructions')
  await put(root, 'outside.md', 'name: outside\ndescription: Not in the registered workspace')
  const options = { home, workspace, projectEnabled: false }

  expect(await discoverSubagentRoles(options)).toEqual([
    { name: 'review', description: 'Personal review', source: 'user', path: personal },
  ])
  const enabled = { ...options, projectEnabled: true }
  const summary = { name: 'review', description: 'Project review for this workspace', source: 'project', path: project }
  expect(await discoverSubagentRoles(enabled)).toEqual([summary])
  expect(await resolveSubagentRole('review', enabled)).toEqual({
    ...summary, tools: ['read', 'grep'], model: 'provider/model', systemPrompt: 'Project instructions',
  })
  expect(await resolveSubagentRole('review', { ...enabled, scope: 'user' })).toMatchObject({
    source: 'user', path: personal,
  })
  expect(await discoverSubagentRoles({ home, workspace: home, projectEnabled: true })).toEqual([
    { name: 'review', description: 'Personal review', source: 'user', path: personal },
  ])
})

test('rechecks the selected role and reports changes, removal, or revoked authorization without changing its source', async () => {
  await put(home, 'review.md', 'name: review\ndescription: Personal review')
  const path = await put(workspace, 'review.md', 'name: review\ndescription: Old review', 'Old instructions')
  const options = { home, workspace, projectEnabled: true }
  const [selected] = await discoverSubagentRoles(options)
  await writeFile(path, '---\nname: review\ndescription: New review\ntools: []\n---\nNew instructions\n')

  expect((await discoverSubagentRoles(options))[0]).toMatchObject({ description: 'New review' })
  expect(await resolveSubagentRole('review', { ...options, selected })).toMatchObject({
    description: 'New review', systemPrompt: 'New instructions', tools: [],
  })
  await expect(resolveSubagentRole('review', { ...options, selected, projectEnabled: false })).rejects.toThrow('未启用')
  await expect(resolveSubagentRole('review', { ...options, scope: 'project', projectEnabled: false })).rejects.toThrow('未启用')
  await rm(path)
  await expect(resolveSubagentRole('review', { ...options, selected })).rejects.toThrow('已移走或删除')
  await expect(resolveSubagentRole('missing', { ...options, scope: 'user' })).rejects.toThrow('找不到')
})

test('reports malformed or unreadable Markdown while preserving other usable roles', async () => {
  const invalid = await put(home, 'invalid.md', 'name: broken\ndescription: [')
  const unsafe = await put(home, 'unsafe.md', 'name: unsafe\ndescription: Invalid tools\ntools: [read, 3]')
  const dead = join(dirname(invalid), 'missing.md')
  await symlink(join(root, 'absent.md'), dead)
  const valid = await put(home, 'valid.md', 'name: valid\ndescription: Valid role\ntools: read, grep')
  const warnings: { path: string; reason: string }[] = []
  const options = { home, workspace, projectEnabled: true, onWarning: (warning: typeof warnings[number]) => warnings.push(warning) }

  expect(await discoverSubagentRoles(options)).toEqual([
    { name: 'valid', description: 'Valid role', path: valid, source: 'user' },
  ])
  expect(warnings).toEqual(expect.arrayContaining([
    { path: invalid, reason: expect.stringContaining('YAML') },
    { path: unsafe, reason: expect.stringContaining('tools') },
    { path: dead, reason: expect.stringContaining('已移走或删除') },
  ]))
  expect(await resolveSubagentRole('valid', options)).toMatchObject({ tools: ['read', 'grep'] })
})

test('project roles stay within the registered workspace role directory', async () => {
  const elsewhere = await put(root, 'outside.md', 'name: outside\ndescription: Different workspace')
  const roleDir = join(workspace, '.si', 'agents')
  await mkdir(dirname(roleDir), { recursive: true })
  await symlink(dirname(elsewhere), roleDir, 'dir')
  const warnings: { path: string; reason: string }[] = []
  const options = { home, workspace, projectEnabled: true, onWarning: (warning: typeof warnings[number]) => warnings.push(warning) }
  expect(await discoverSubagentRoles(options)).toEqual([])
  expect(warnings).toEqual([{ path: roleDir, reason: expect.stringContaining('工作区') }])

  await rm(roleDir)
  const local = await put(workspace, 'local.md', 'name: local\ndescription: Local review')
  const linked = join(roleDir, 'outside.md')
  await symlink(elsewhere, linked)
  expect(await discoverSubagentRoles(options)).toEqual([
    { name: 'local', description: 'Local review', path: local, source: 'project' },
  ])
  expect(warnings.at(-1)).toEqual({ path: linked, reason: expect.stringContaining('角色目录') })
})
