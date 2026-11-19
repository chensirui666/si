import { useTranslation } from 'react-i18next'
import type { SaveFailure } from '@agent-learning/server/protocol'

export function SaveFailureNotice({ failure }: { failure: SaveFailure }) {
  const { t } = useTranslation()
  const reason = t(failure.reason === 'storage-full' ? 'save.diskFull' : 'save.writeFailed')
  return <p className="message-ending" role="alert">{failure.reason === 'unconfirmed'
    ? t('save.unconfirmed') : t('save.details', { stage: t(`save.stage.${failure.stage}`), reason })}</p>
}
