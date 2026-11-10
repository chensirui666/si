import { describe, expect, it } from 'vitest'
import { Sessions } from '../src/sessions.js'

describe('Sessions', () => {
  it('allocates independent session IDs and numbers names by workspace', async () => {
    const sessions = new Sessions({
      resolveDirectory: async id => `/project/${id}`,
      createSession: resolveDirectory => ({ resolveDirectory, close: async () => {} }),
    })
    const [a1, b1, a2] = await Promise.all([sessions.create('a'), sessions.create('b'), sessions.create('a')])
    expect(sessions.list()).toEqual([a1, b1, a2])
    expect(new Set([a1.id, b1.id, a2.id]).size).toBe(3)
    expect([a1.name, b1.name, a2.name]).toEqual(['会话 1', '会话 1', '会话 2'])
    expect(await sessions.get(a2.id)?.resolveDirectory()).toBe('/project/a')
    expect(sessions.get('missing')).toBeUndefined()
    await sessions.close()
  })

  it('blocks a creation that is waiting on directory validation when shutdown begins', async () => {
    const directory = Promise.withResolvers<string>()
    const sessions = new Sessions({
      resolveDirectory: () => directory.promise,
      createSession: () => ({ close: async () => { throw new Error('unexpected session') } }),
    })
    const opening = sessions.create('a')
    const closing = sessions.close()
    directory.resolve('/project/a')
    await expect(opening).rejects.toMatchObject({ code: 'closed' })
    await closing
    expect(sessions.list()).toEqual([])
  })
})
