import type { SaveFailure } from '@agent-learning/server/protocol'

const stages: Record<SaveFailure['stage'], string> = {
  'tool-call': '工具调用保存失败，本批工具未执行',
  'tool-result': '工具结果保存失败，本轮已结束',
  answer: '回答已生成，但未保存',
  compaction: '压缩记录保存失败，已保留上一次有效上下文',
  finish: '任务状态保存失败',
}

export function SaveFailureNotice({ failure }: { failure: SaveFailure }) {
  const reason = failure.reason === 'storage-full' ? '磁盘空间不足' : '本地会话库写入失败'
  return <p className="message-ending" role="alert">{failure.reason === 'unconfirmed'
    ? '会话保存状态未确认，请重启服务后核对。' : `${stages[failure.stage]}。原因是${reason}。`}</p>
}
