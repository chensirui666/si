import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useId, useRef, useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import type { ModelDiscovery, ModelInfo, ModelSelection } from '@agent-learning/model'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export const effortLabel = (t: TFunction, effort: string) => t(`model.effort.${effort}`, { defaultValue: effort })

export function ModelPicker({ discovery, selection, model, disabled, placeholder, onSelect }: {
  discovery: ModelDiscovery | null
  selection?: ModelSelection
  model?: ModelInfo
  disabled: boolean
  placeholder: string
  onSelect(selection: ModelSelection): void
}) {
  const { t } = useTranslation()
  const id = useId()
  const popover = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const term = query.trim().toLowerCase()
  const groups = (open ? discovery?.providers ?? [] : []).flatMap(provider => {
    const models = discovery?.models.filter(item => item.provider === provider.id
      && `${item.name} ${item.id} ${provider.name}`.toLowerCase().includes(term)) ?? []
    return models.length ? [{ provider, models }] : []
  })

  return <div className="composer-model-controls">
    <Button type="button" variant="ghost" role="combobox" aria-label={t('model.label')} aria-haspopup="dialog"
      aria-controls={id} aria-expanded={open}
      className="composer-model" popoverTarget={id} disabled={disabled} onClick={() => setQuery('')}>
      <span>{model?.name ?? placeholder}</span><ChevronDownIcon aria-hidden="true" />
    </Button>
    <div id={id} ref={popover} className="model-picker" popover="auto" role="dialog" aria-label={t('model.pick')} onToggle={event => {
      const expanded = event.currentTarget.matches(':popover-open')
      setOpen(expanded)
      if (expanded) search.current?.focus()
    }}>
      <Input ref={search} type="search" aria-label={t('model.search')} placeholder={t('model.search')} value={query} onChange={event => setQuery(event.target.value)} />
      <div className="model-picker-list">
        {groups.map(({ provider, models }) => <div key={provider.id} role="group" aria-label={provider.name}>
          <div className="model-picker-label">{provider.name}</div>
          {models.map(item => <Button variant="ghost" key={item.id} type="button" disabled={disabled} title={item.id}
            aria-pressed={selection?.provider === item.provider && selection.modelId === item.id}
            onClick={() => {
              popover.current?.hidePopover()
              onSelect({ provider: item.provider, modelId: item.id,
                ...(item.defaultReasoningEffort && { reasoningEffort: item.defaultReasoningEffort }) })
            }}>{item.name}
            {discovery?.models.some(other => other.provider === item.provider && other.id !== item.id && other.name === item.name)
              && <small>{item.id}</small>}
          </Button>)}
        </div>)}
        {!groups.length && <p className="model-picker-label">{t('model.noMatches')}</p>}
      </div>
    </div>
    {model?.reasoningEfforts && model.reasoningEfforts.length > 1 && <Select disabled={disabled}
      value={selection?.reasoningEffort} onValueChange={value => {
        const reasoningEffort = model.reasoningEfforts?.find(level => level === value)
        if (selection && reasoningEffort) onSelect({ ...selection, reasoningEffort })
      }}>
      <SelectTrigger aria-label={t('model.effort')} className="composer-model"><SelectValue /></SelectTrigger>
      <SelectContent align="end">{model.reasoningEfforts.map(effort =>
        <SelectItem key={effort} value={effort}>{effortLabel(t, effort)}</SelectItem>)}</SelectContent>
    </Select>}
  </div>
}
