import { isPermissionMode, type PermissionMode } from '@agent-learning/server/protocol'
import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export function PermissionPicker({ mode, disabled, onSelect, id }: {
  mode: PermissionMode | null
  disabled?: boolean
  onSelect(mode: PermissionMode): void
  id?: string
}) {
  const { t } = useTranslation()
  return <Select value={mode ?? ''} disabled={disabled || !mode} onValueChange={value => {
    if (isPermissionMode(value) && value !== mode) onSelect(value)
  }}>
    <SelectTrigger id={id} aria-label={t('permission.label')} className={id ? undefined : 'composer-permission'}>
      <SelectValue placeholder={t('permission.label')} />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="normal">{t('permission.normal')}</SelectItem>
      <SelectItem value="read-only">{t('permission.read-only')}</SelectItem>
    </SelectContent>
  </Select>
}
