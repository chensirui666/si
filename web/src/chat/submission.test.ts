import { describe, expect, it } from 'vitest'
import { mergeSubmissions, settleSubmission } from './state'
import type { LocalSubmission } from '../types'

const local: LocalSubmission = { clientMessageId: 'local', modelId: 'deepseek-flash', text: '  原文\n', state: 'pending' }
const accepted = { clientMessageId: 'local', userMessageId: 'user', acceptedSeq: 4 }
const user = { id: 'user', clientMessageId: 'local', message: { role: 'user' as const, content: local.text, timestamp: 1 } }

describe('提交接收证据', () => {
  it('HTTP 回执先到仍保留未决状态，WS 正式 user 到达只显示一个气泡', () => {
    const pending = settleSubmission([local], 'local', { accepted })
    expect(pending).toEqual([{ ...local, accepted }])
    expect(mergeSubmissions([user], pending)).toEqual([user])
  })
  it('WS 先到移除临时气泡，随后错误不能重新产生失败气泡', () => {
    const pending = settleSubmission([local], 'local', { accepted })
    expect(settleSubmission([], 'local', { state: 'failed', errorMessage: '迟到错误' })).toEqual([])
    expect(settleSubmission(pending, 'local', { state: 'failed', errorMessage: '迟到错误' })).toEqual(pending)
  })
  it('未确认条目不会因空快照消失，也不按相同文字去重', () => {
    const unresolved = { ...local, state: 'unconfirmed' as const }
    expect(mergeSubmissions([], [unresolved])).toEqual([unresolved])
    expect(mergeSubmissions([{ ...user, clientMessageId: 'another' }], [unresolved])).toHaveLength(2)
  })
})

it('多条同锚点的本地失败按创建顺序插入，后续正式消息与回复不会越过它们', () => {
  const first = { ...local, clientMessageId: 'a', text: '失败 A', state: 'failed' as const, afterMessageId: 'history' }
  const second = { ...first, clientMessageId: 'b', text: '失败 B' }
  const history = { ...user, id: 'history', clientMessageId: undefined }
  expect(mergeSubmissions([history, user], [first, second])).toEqual([history, first, second, user])
})

it('没有正式锚点或重启后锚点消失时，本地失败仍可见并保持彼此顺序', () => {
  const first = { ...local, clientMessageId: 'a', text: '失败 A', state: 'failed' as const }
  const second = { ...first, clientMessageId: 'b', text: '失败 B', afterMessageId: 'deleted-history' }
  expect(mergeSubmissions([user], [first, second])).toEqual([first, second, user])
})
