import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { discoverSkills, loadSkill } from '../src/skills.js'

let root: string, cwd: string, home: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'si-skills-'))
  cwd = join(root, 'repo/apps/web')
  home = join(root, 'home')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(root, 'repo/.git'), 'gitdir: /tmp/worktree-git')
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function put(path: string, name: string, body = 'instructions', description = 'description: >\n  first line\n  second line') {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `---\nname: ${name}\n${description}\n---\n${body}\n`)
  return target
}

test('discovers in priority order through the Git root and stops under SKILL.md', async () => {
  const hit = await put('repo/apps/web/.si/skills/groups/review/SKILL.md', 'review', 'project')
  await put('repo/apps/web/.si/skills/groups/review/references/another/SKILL.md', 'ignored')
  await put('repo/apps/.agents/skills/near/SKILL.md', 'near')
  await put('repo/.agents/skills/far/SKILL.md', 'far')
  await put('.agents/skills/outside/SKILL.md', 'outside')
  await put('home/.si/skills/review/SKILL.md', 'review', 'personal')
  await put('app/resources/skills/review/SKILL.md', 'review', 'bundled')
  const { skills, complete } = await discoverSkills(cwd, { home, applicationRoot: join(root, 'app') })
  expect(complete).toBe(true)
  expect(skills.map(x => x.name)).toEqual(['review', 'near', 'far'])
  expect(skills[0]).toMatchObject({ path: hit, source: 'project-si', description: 'first line second line' })
  expect(await loadSkill(skills[0])).toMatchObject({ status: 'loaded', body: 'project', directory: dirname(hit) })
  await rm(hit)
  expect(await loadSkill(skills[0])).toMatchObject({ status: 'failed', name: 'review', reason: expect.any(String) })
})

test('supports compatible single files, reports local failures, and follows links without cycling', async () => {
  await writeFile(join(cwd, '.si'), 'blocks directory lookup')
  const file = await put('repo/apps/.agents/skills/group/single.md', 'single')
  await put('repo/apps/.agents/skills/group/bad/SKILL.md', 'bad', '', 'description: [')
  await put('repo/apps/.agents/skills/group/missing/SKILL.md', 'missing', '', 'other: value')
  await put('repo/apps/.agents/skills/ignored.md', 'ignored')
  await put('home/.si/skills/extra.md', 'extra', 'personal', 'description: extra\ndisable-model-invocation: true')
  await symlink(dirname(file), join(dirname(file), 'cycle'))
  await symlink(file, join(dirname(file), 'same.md'))
  const catalog = await discoverSkills(cwd, { home })
  expect(catalog.complete).toBe(false)
  expect(catalog.diagnostics.map(entry => entry.path)).toEqual(expect.arrayContaining([
    join(cwd, '.si/skills'), join(dirname(file), 'bad/SKILL.md'), join(dirname(file), 'missing/SKILL.md'),
  ]))
  expect(catalog.skills.map(x => x.name)).toEqual(['single', 'extra'])
  expect(catalog.skills[1]).toMatchObject({ source: 'user-si', disableModelInvocation: true })
  expect(await loadSkill(catalog.skills[0])).toMatchObject({ directory: dirname(file) })

  await rm(join(cwd, '.si'))
  await put('repo/apps/web/.si/skills/recovered.md', 'recovered')
  const recovered = await discoverSkills(cwd, { home })
  expect(recovered.complete).toBe(true)
  expect(recovered.skills.map(x => x.name)).toEqual(['recovered', 'single', 'extra'])
})

test('rejects oversized and invalid UTF-8 files while leaving other skills discoverable', async () => {
  await put('repo/apps/web/.si/skills/huge.md', 'huge', 'x'.repeat(256 * 1024))
  const invalid = await put('repo/apps/web/.si/skills/invalid.md', 'invalid')
  await writeFile(invalid, Buffer.from([0xff, 0xfe]))
  await put('repo/apps/web/.si/skills/ok.md', 'ok')
  const catalog = await discoverSkills(cwd, { home })
  expect(catalog.skills.map(skill => skill.name)).toEqual(['ok'])
  expect(catalog.diagnostics.map(item => item.reason)).toEqual(expect.arrayContaining([
    expect.stringContaining('256 KiB'), expect.stringContaining('UTF-8'),
  ]))
})

test('classifies personal roots as personal even when the workspace is the home directory', async () => {
  await put('home/.si/skills/review/SKILL.md', 'review')
  await put('home/.agents/skills/triage/SKILL.md', 'triage')
  const { skills } = await discoverSkills(home, { home })
  expect(skills.map(({ source }) => source)).toEqual(['user-si', 'user-agents'])
})
