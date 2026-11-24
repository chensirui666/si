import { useTranslation } from 'react-i18next'
import type { UserQuestionBatch } from '@agent-learning/server/protocol'
import './conversation-interaction.css'

export function QuestionReply({ batch }: { batch: UserQuestionBatch }) {
  const { t } = useTranslation()
  const answers = new Map(batch.answers?.map(answer => [answer.id, answer]))

  return <dl className="message-text question-reply" data-question-reply={batch.id} aria-label={t('question.lateReply')}>
    {batch.questions.map(question => {
      const answer = answers.get(question.id)
      const values = [...(answer?.selected ?? []), answer?.custom].filter(Boolean)
      return <div key={question.id}>
        <dt>{question.question}</dt>
        <dd>{values.length > 0 ? values.join(' · ') : t('question.skipped')}</dd>
      </div>
    })}
  </dl>
}
