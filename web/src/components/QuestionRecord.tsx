import { useTranslation } from 'react-i18next'
import type { UserQuestionBatch } from '@agent-learning/server/protocol'
import { questionStatusKey } from '../i18n/messages'
import { Button } from './ui/button'
import './conversation-interaction.css'

export function QuestionRecord({ batch, onOpen }: { batch: UserQuestionBatch; onOpen?: () => void }) {
  const { t } = useTranslation()
  const label = t('question.count', { count: batch.questions.length, lng: 'en' })
  return <div className="question-record" data-question-batch={batch.id} data-tool-call-id={batch.toolCallId}>
    <Button variant="outline" size="sm" type="button" className="question-record-trigger"
      aria-label={`${label} · ${t(questionStatusKey(batch))}`} disabled={!onOpen} onClick={onOpen}>
      <span lang="en">{label}</span>
    </Button>
  </div>
}
