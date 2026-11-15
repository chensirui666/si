import type { SkillSource } from '@agent-learning/server/protocol'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { i18n } from './copy'
import type { CopyKey } from './en'

export const skillSourceKey = {
  'project-si': 'chat.skillProject',
  'project-agents': 'chat.skillProject',
  'user-si': 'chat.skillPersonal',
  'user-agents': 'chat.skillPersonal',
  bundled: 'chat.skillBundled',
} as const satisfies Record<SkillSource, CopyKey>

export type Notice = { key: CopyKey; detail?: string; label?: CopyKey; status?: number }

export function noticeSummary(t: TFunction, notice: Notice) {
  return t(notice.key, { label: notice.label ? t(notice.label) : '', status: notice.status })
}

export class RequestError extends Error {
  constructor(readonly notice: Notice) {
    super(notice.detail ?? noticeSummary(i18n.t, notice))
  }
}

export function errorNotice(key: CopyKey, error: unknown): Notice {
  return error instanceof RequestError ? error.notice : { key, detail: error instanceof Error ? error.message : undefined }
}

export function NoticeText({ notice }: { notice: Notice }) {
  const { t } = useTranslation()
  const summary = noticeSummary(t, notice)
  return <>{summary}{notice.detail && notice.detail !== summary && <> · <span>{notice.detail}</span></>}</>
}
