import { useRef, useState, type ComponentProps, type FormEvent } from 'react'
import { SettingsIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelDiscovery } from '@agent-learning/model'
import type { PermissionMode, WebSettingsView } from '@agent-learning/server/protocol'
import { deleteApiKey, saveApiKey, deleteWebApiKey, saveWebApiKey, saveWebSettings } from '../chat/client'
import { loadLanguage, selectLanguage, useLanguage } from '../i18n'
import type { CopyKey } from '../i18n/en'
import { errorNotice, NoticeText, type Notice } from '../i18n/messages'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { PermissionPicker } from './PermissionPicker'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

type ProviderFormState = {
  apiKey: string
  status: 'idle' | 'saving' | 'deleting'
  errorMessage?: Notice
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus: (event: Event) => void
  discovery: ModelDiscovery | null
  onChange: (discovery: ModelDiscovery) => void
  permissionSettings?: {
    mode: PermissionMode | null
    busy: boolean
    readError: Notice | null
    saveError?: Notice
    onSelect(mode: PermissionMode): void
    onRetry(): void
  }
  webSettings?: WebSettingsView | null
  webSettingsError?: Notice | null
  onWebSettingsChange?: (settings: WebSettingsView) => void
}

type Screen = 'general' | 'models' | 'providers' | 'edit' | 'web'

export function SettingsButton(props: ComponentProps<typeof Button>) {
  const { t } = useTranslation()
  return <Button className="settings-trigger" type="button" variant="ghost" aria-haspopup="dialog" {...props}>
    <SettingsIcon aria-hidden="true" />{t('settings.title')}
  </Button>
}

export function SettingsDialog({ open, onOpenChange, onCloseAutoFocus, discovery, onChange, permissionSettings, webSettings, webSettingsError, onWebSettingsChange }: Props) {
  const { t } = useTranslation()
  const { language, status: languageStatus, detail: languageDetail } = useLanguage()
  const languageBusy = languageStatus === 'loading' || languageStatus === 'saving'
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
  const [screen, setScreen] = useState<Screen>('general')
  const [providerId, setProviderId] = useState('')
  const [form, setForm] = useState<ProviderFormState>({ apiKey: '', status: 'idle' })
  const [notice, setNotice] = useState<CopyKey>()
  const generation = useRef(0)
  const pending = useRef(false)
  const configured = discovery?.providers.filter(provider => provider.status.state === 'configured') ?? []
  const addable = discovery?.providers.filter(provider => provider.status.state !== 'configured') ?? []
  const modelProvider = discovery?.providers.find(provider => provider.id === providerId)
  const providerError = discovery?.providers.find(provider => provider.status.state === 'error')?.status
  const web = screen === 'web'
  const section = screen === 'general' || web ? screen : 'models'
  const webProvider = webSettings?.providers.find(provider => provider.id === providerId)
  const busy = form.status !== 'idle'

  function navigate(next: Screen, providerId = '') {
    generation.current++
    pending.current = false
    setScreen(next)
    setLanguageMenuOpen(false)
    setProviderId(providerId)
    setForm({ apiKey: '', status: 'idle' })
    setNotice(undefined)
  }

  function changeOpen(next: boolean) {
    onOpenChange(next)
    navigate('general')
  }

  async function runUpdate(status: 'saving' | 'deleting', update: () => Promise<void>, message: CopyKey, done?: () => void) {
    if (pending.current) return
    pending.current = true
    const current = generation.current
    setForm(previous => ({ ...previous, status, errorMessage: undefined }))
    setNotice(undefined)
    try {
      await update()
      if (current !== generation.current) return
      setForm(previous => ({ ...previous, status: 'idle' }))
      done?.()
      setNotice(message)
    } catch (error) {
      if (current !== generation.current) return
      setForm(previous => ({ ...previous, status: 'idle', errorMessage: errorNotice('settings.updateFailed', error) }))
    } finally {
      if (current === generation.current) pending.current = false
    }
  }

  function updateKey(deleting = false) {
    void runUpdate(deleting ? 'deleting' : 'saving', async () => {
      if (web && webProvider) {
        const settings = await (deleting ? deleteWebApiKey(webProvider.id) : saveWebApiKey(webProvider.id, form.apiKey))
        onWebSettingsChange?.(settings)
      } else if (modelProvider) {
        onChange(await (deleting ? deleteApiKey(modelProvider.id) : saveApiKey(modelProvider.id, form.apiKey)))
      }
    }, deleting ? 'settings.deleted' : 'settings.saved', () => {
      setForm({ apiKey: '', status: 'idle' })
      if (!deleting) return
      if (web) setProviderId('')
      else setScreen('models')
    })
  }

  function updateSelection(field: 'searchProvider' | 'fetchProvider', value: string) {
    if (!webSettings) return
    const { searchProvider, fetchProvider } = webSettings
    void runUpdate('saving', async () => {
      const settings = await saveWebSettings({ searchProvider, fetchProvider, [field]: value })
      onWebSettingsChange?.(settings)
    }, 'settings.savedWeb')
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (form.apiKey.trim()) updateKey()
  }

  function keyForm(name: string, hasKey: boolean) {
    return <form className="provider-form" onSubmit={save}>
      <h3>{name}</h3>
      <label htmlFor="provider-key">API Key</label>
      <div className="provider-key-field"><Input id="provider-key" type="password" value={form.apiKey} autoComplete="off" spellCheck={false} disabled={busy} placeholder={t(hasKey ? 'settings.replaceKey' : 'settings.enterKey')} onChange={event => setForm(previous => ({ ...previous, apiKey: event.target.value, errorMessage: undefined }))} /></div>
      <p className="settings-help">{t('settings.keyHelp')}</p>
      <div className="provider-actions">
        <Button type="submit" disabled={busy || !form.apiKey.trim()}>{t(form.status === 'saving' ? 'common.saving' : 'common.save')}</Button>
        {hasKey && <Button type="button" variant="ghost" className="delete-provider" disabled={busy} onClick={() => updateKey(true)}>{t(form.status === 'deleting' ? 'common.deleting' : 'settings.deleteKey')}</Button>}
      </div>
    </form>
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
      <DialogTitle className="settings-title">{t('settings.title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('settings.description')}</DialogDescription>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('settings.sections')}>
          {(['general', 'models', 'web'] as const).map(item => <Button key={item} variant={section === item ? 'secondary' : 'ghost'}
            aria-current={section === item ? 'page' : undefined} onClick={() => navigate(item)}>{t(`settings.${item}`)}</Button>)}
        </nav>
        <section className="settings-models" aria-labelledby="settings-heading">
          <h2 id="settings-heading">{t(`settings.${section}`)}</h2>
          {section === 'general' ? <>
            <div className="language-setting">
              <label htmlFor="settings-language">{t('settings.language')}</label>
              <Select value={language} open={languageMenuOpen && !languageBusy} onOpenChange={next => {
                if (!next || !languageBusy) setLanguageMenuOpen(next)
              }} onValueChange={value => {
                if (!languageBusy && (value === 'en' || value === 'zh-CN')) void selectLanguage(value)
              }}>
                <SelectTrigger id="settings-language" aria-disabled={languageBusy || undefined}><SelectValue /></SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="en" lang="en">English</SelectItem>
                  <SelectItem value="zh-CN" lang="zh-CN">简体中文</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {languageStatus === 'saving' && <p className="settings-help" role="status">{t('settings.language.saving')}</p>}
            {(languageStatus === 'readFailed' || languageStatus === 'saveFailed' || languageStatus === 'unconfirmed') && <>
              <p className="configuration-error" role="alert"><NoticeText notice={{ key: `settings.language.${languageStatus}`, detail: languageDetail }} /></p>
              {languageStatus === 'readFailed' && <Button variant="ghost" onClick={() => { void loadLanguage() }}>{t('common.retry')}</Button>}
            </>}
            {permissionSettings && <>
              <div className="language-setting">
                <div>
                  <label htmlFor="settings-permission">{t('permission.label')}</label>
                  <p className="settings-help">{t('permission.defaultHelp')}</p>
                </div>
                <PermissionPicker id="settings-permission" mode={permissionSettings.mode}
                  disabled={permissionSettings.busy || !!permissionSettings.readError} onSelect={permissionSettings.onSelect} />
              </div>
              {permissionSettings.busy && <p className="settings-help" role="status">{t('permission.saving')}</p>}
              {permissionSettings.saveError && <p className="configuration-error" role="alert"><NoticeText notice={permissionSettings.saveError} /></p>}
              {permissionSettings.readError && <>
                <p className="configuration-error" role="alert"><NoticeText notice={permissionSettings.readError} /></p>
                <Button variant="ghost" onClick={permissionSettings.onRetry}>{t('common.retry')}</Button>
              </>}
            </>}
          </> : web ? <>
            <p className="settings-help">{t('settings.webHelp')}</p>
            {webSettingsError && <p className="configuration-error" role="alert"><NoticeText notice={webSettingsError} /></p>}
            {!webSettings && !webSettingsError && <p className="settings-help">{t('settings.webLoading')}</p>}
            {webSettings && <>
              <div className="web-provider-selections">
                {([
                  { field: 'searchProvider', capability: 'search', label: 'settings.search' },
                  { field: 'fetchProvider', capability: 'fetch', label: 'settings.fetch' },
                ] as const).map(({ field, capability, label }) => <div key={field}>
                  <label htmlFor={field}>{t(label)}</label>
                  <Select value={webSettings[field]} disabled={busy} onValueChange={value => updateSelection(field, value)}>
                    <SelectTrigger id={field}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {webSettings.providers.filter(provider => provider.capabilities.includes(capability)).map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>)}
              </div>
              {webSettings.providers.map(provider => <div className="provider-row" key={provider.id}>
                <div>
                  <span>{provider.name} <small data-status={provider.status.state}>{t(`settings.${provider.status.state}`)}</small></span>
                  {provider.status.state === 'error' && <p className="configuration-error" role="alert">{provider.status.message}</p>}
                </div>
                <Button variant="outline" disabled={busy} aria-label={t('settings.editProvider', { name: provider.name })} onClick={() => navigate('web', provider.id)}>{t('common.edit')}</Button>
              </div>)}
              {webProvider && keyForm(webProvider.name, webProvider.status.state === 'configured')}
            </>}
          </> : <>
            <p className="settings-help">{t('settings.modelHelp')}</p>
            {providerError?.state === 'error' && <p className="configuration-error" role="alert"><NoticeText notice={{ key: 'settings.error', detail: providerError.message }} /></p>}
            {screen === 'models' && <>
              {configured.map(provider => <div className="provider-row" key={provider.id}>
                <span>{provider.name} <small>{t('settings.configured')}</small></span>
                <Button variant="outline" onClick={() => navigate('edit', provider.id)}>{t('common.edit')}</Button>
              </div>)}
              <Button variant="outline" disabled={!addable.length} onClick={() => navigate('providers')}>{t('settings.addProvider')}</Button>
            </>}
            {screen === 'providers' && <div className="provider-choices">{addable.map(provider =>
              <Button key={provider.id} className="provider-choice" variant="outline" onClick={() => navigate('edit', provider.id)}>{provider.name}</Button>)}</div>}
            {screen === 'edit' && modelProvider && keyForm(modelProvider.name, modelProvider.status.state === 'configured')}
          </>}
          {form.errorMessage && <p className="configuration-error" role="alert"><NoticeText notice={form.errorMessage} /></p>}
          {notice && <p className="configuration-success" aria-live="polite">{t(notice)}</p>}
        </section>
      </div>
    </DialogContent>
  </Dialog>
}
