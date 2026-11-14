import { useRef, useState, type ComponentProps, type FormEvent } from 'react'
import { GlobeIcon, LayersIcon, PlusIcon, SettingsIcon, SlidersHorizontalIcon } from 'lucide-react'
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
  status: 'idle' | 'saving'
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

const sections = [
  { id: 'general', Icon: SlidersHorizontalIcon },
  { id: 'models', Icon: LayersIcon },
  { id: 'web', Icon: GlobeIcon },
] as const
type Section = typeof sections[number]['id']
type Editor = { kind: 'add'; providerId?: string } | { kind: 'edit'; providerId: string }
type Provider = ModelDiscovery['providers'][number]
type DeleteTarget = { provider: Provider; trigger: HTMLButtonElement; fallback: HTMLButtonElement | null }

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
  const [section, setSection] = useState<Section>('general')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [form, setForm] = useState<ProviderFormState>({ apiKey: '', status: 'idle' })
  const [notice, setNotice] = useState<CopyKey>()
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<Notice>()
  const generation = useRef(0)
  const pending = useRef(false)
  const editorButton = useRef<HTMLButtonElement>(null)
  const modelTab = useRef<HTMLButtonElement>(null)
  const webTab = useRef<HTMLButtonElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const configured = discovery?.providers.filter(provider => provider.status.state === 'configured') ?? []
  const addable = discovery?.providers.filter(provider => provider.status.state !== 'configured') ?? []
  const modelProvider = discovery?.providers.find(provider => provider.id === editor?.providerId)
  const providerError = discovery?.providers.find(provider => provider.status.state === 'error')?.status
  const webProvider = webSettings?.providers.find(provider => provider.id === editor?.providerId)
  const busy = form.status !== 'idle'

  function changeEditor(next: Editor | null) {
    generation.current++
    pending.current = false
    setEditor(next)
    setForm({ apiKey: '', status: 'idle' })
    setNotice(undefined)
  }

  function navigate(next: Section) {
    setSection(next)
    setLanguageMenuOpen(false)
    changeEditor(null)
  }

  function changeOpen(next: boolean) {
    if (!next && deleteTarget) return
    onOpenChange(next)
    navigate('general')
  }

  async function runUpdate(update: () => Promise<void>, message: CopyKey, done?: () => void) {
    if (pending.current) return
    pending.current = true
    const current = generation.current
    setForm(previous => ({ ...previous, status: 'saving', errorMessage: undefined }))
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

  function updateKey() {
    void runUpdate(async () => {
      if (section === 'web' && webProvider) {
        const settings = await saveWebApiKey(webProvider.id, form.apiKey)
        onWebSettingsChange?.(settings)
      } else if (section === 'models' && modelProvider) {
        onChange(await saveApiKey(modelProvider.id, form.apiKey))
      }
    }, 'settings.saved', () => {
      setForm({ apiKey: '', status: 'idle' })
      if (section === 'web') return
      if (document.activeElement === document.body || formRef.current?.contains(document.activeElement)) {
        const target = editor?.kind === 'add' && addable.length === 1 ? modelTab.current : editorButton.current
        target?.focus()
      }
      setEditor(null)
    })
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return
    const { id } = deleteTarget.provider
    setDeleting(true)
    setDeleteError(undefined)
    setNotice(undefined)
    try {
      if (section === 'web') onWebSettingsChange?.(await deleteWebApiKey(id))
      else onChange(await deleteApiKey(id))
      if (editor?.providerId === id) changeEditor(null)
      setDeleteTarget(null)
      setNotice('settings.deleted')
    } catch (error) {
      setDeleteError(errorNotice('settings.updateFailed', error))
    } finally {
      setDeleting(false)
    }
  }

  function updateSelection(field: 'searchProvider' | 'fetchProvider', value: string) {
    if (!webSettings) return
    const { searchProvider, fetchProvider } = webSettings
    void runUpdate(async () => {
      const settings = await saveWebSettings({ searchProvider, fetchProvider, [field]: value })
      onWebSettingsChange?.(settings)
    }, 'settings.savedWeb')
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (form.apiKey.trim()) updateKey()
  }

  function keyForm(hasKey: boolean) {
    return <form className="provider-form" ref={formRef} onSubmit={save}>
      <label htmlFor="provider-key">API Key</label>
      <div className="provider-key-field"><Input id="provider-key" type="password" value={form.apiKey} autoComplete="off" spellCheck={false} disabled={busy} placeholder={t(hasKey ? 'settings.replaceKey' : 'settings.enterKey')} onChange={event => setForm(previous => ({ ...previous, apiKey: event.target.value, errorMessage: undefined }))} /></div>
      <p className="settings-help">{t('settings.keyHelp')}</p>
      {section === 'models' && form.errorMessage && <p className="configuration-error" role="alert"><NoticeText notice={form.errorMessage} /></p>}
      <div className="provider-actions">
        <Button type="button" variant="outline" disabled={busy} onClick={() => {
          editorButton.current?.focus()
          changeEditor(null)
        }}>{t('common.cancel')}</Button>
        <Button type="submit" disabled={busy || !form.apiKey.trim()}>{t(form.status === 'saving' ? 'common.saving' : 'common.save')}</Button>
      </div>
    </form>
  }

  function providerCard(provider: Provider) {
    const web = section === 'web'
    const expanded = editor?.kind === 'edit' && editor.providerId === provider.id
    const status = t(`settings.${provider.status.state}`)
    return <article className="provider-row" key={provider.id} aria-label={provider.name}>
      <div className="provider-row-heading">
        <span>{provider.name} <span className="provider-status" data-status={provider.status.state} role="img" aria-label={status} title={status} /></span>
        <div className="provider-row-actions">
          <Button variant="outline" size="sm" disabled={web && busy} aria-expanded={expanded}
            aria-label={web ? t('settings.editProvider', { name: provider.name }) : undefined} onClick={event => {
              editorButton.current = event.currentTarget
              changeEditor(expanded ? null : { kind: 'edit', providerId: provider.id })
            }}>{t('common.edit')}</Button>
          {provider.status.state === 'configured' && <Button variant="outline" size="sm" className="delete-provider" disabled={busy} onClick={event => {
            if (pending.current) return
            setDeleteError(undefined)
            setDeleteTarget({
              provider, trigger: event.currentTarget,
              fallback: web ? event.currentTarget.parentElement?.querySelector('button[aria-expanded]') ?? webTab.current : modelTab.current,
            })
          }}>{t('common.delete')}</Button>}
        </div>
      </div>
      {provider.status.state === 'error' && <p className="configuration-error" role="alert">{provider.status.message}</p>}
      {expanded && keyForm(provider.status.state === 'configured')}
    </article>
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogContent className="settings-dialog" onCloseAutoFocus={onCloseAutoFocus} onEscapeKeyDown={event => {
      if (!deleteTarget) return
      event.preventDefault()
      if (!deleting) setDeleteTarget(null)
    }}>
      <DialogTitle className="settings-title">{t('settings.title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('settings.description')}</DialogDescription>
      <nav className="settings-nav" aria-label={t('settings.sections')}>
        {sections.map(({ id, Icon }) => <Button key={id} ref={id === 'models' ? modelTab : id === 'web' ? webTab : undefined} variant="ghost"
          aria-current={section === id ? 'true' : undefined} onClick={() => { if (section !== id) navigate(id) }}>
          <Icon aria-hidden="true" />{t(`settings.${id}`)}
        </Button>)}
      </nav>
      <section key={section} className="settings-content" aria-label={t(`settings.${section}`)}>
        {section !== 'general' && <h3>{t(`settings.${section}`)}</h3>}
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
        </> : section === 'web' ? <>
          {webSettingsError && <p className="configuration-error" role="alert"><NoticeText notice={webSettingsError} /></p>}
          {!webSettings && !webSettingsError && <p className="settings-help">{t('settings.webLoading')}</p>}
          {webSettings && <>
            <section className="web-settings-group" aria-labelledby="web-tools-heading">
              <h4 id="web-tools-heading">{t('settings.webTools')}</h4>
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
            </section>
            <section className="web-settings-group" aria-labelledby="web-providers-heading">
              <h4 id="web-providers-heading">{t('settings.webProviders')}</h4>
              <p className="settings-help">{t('settings.webProviderHelp')}</p>
              <div className="provider-list">{webSettings.providers.map(providerCard)}</div>
            </section>
            {form.errorMessage && <p className="configuration-error" role="alert"><NoticeText notice={form.errorMessage} /></p>}
          </>}
        </> : <>
          <p className="settings-help">{t('settings.modelHelp')}</p>
          {providerError?.state === 'error' && <p className="configuration-error" role="alert"><NoticeText notice={{ key: 'settings.error', detail: providerError.message }} /></p>}
          <div className="provider-list">{configured.map(providerCard)}</div>
          <Button className="provider-add" variant="outline" aria-expanded={editor?.kind === 'add'} disabled={!addable.length && editor?.kind !== 'add'} onClick={event => {
            editorButton.current = event.currentTarget
            changeEditor(editor?.kind === 'add' ? null : { kind: 'add' })
          }}><PlusIcon aria-hidden="true" />{t('settings.addProvider')}</Button>
          {editor?.kind === 'add' && <div className="provider-row provider-add-card">
            <div className="settings-field">
              <label htmlFor="model-provider">{t('settings.provider')}</label>
              <Select value={editor.providerId ?? ''} disabled={busy || !addable.length} onValueChange={providerId => changeEditor({ kind: 'add', providerId })}>
                <SelectTrigger id="model-provider"><SelectValue placeholder={t('settings.chooseProvider')} /></SelectTrigger>
                <SelectContent align="end">
                  {addable.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {modelProvider && keyForm(modelProvider.status.state === 'configured')}
          </div>}
        </>}
        <div role="status" aria-live="polite">{notice && <p className="configuration-success">{t(notice)}</p>}</div>
      </section>
      {deleteTarget && <Dialog open onOpenChange={next => {
        if (!next && !deleting) setDeleteTarget(null)
      }}>
        <DialogContent className="provider-delete-dialog" overlayClassName="provider-delete-overlay" closeLabel={t('common.close')}
          onCloseAutoFocus={event => {
            event.preventDefault()
            const { trigger, fallback } = deleteTarget
            const focusTarget = trigger.isConnected ? trigger : fallback
            focusTarget?.focus()
          }}>
          <DialogTitle>{t('settings.deleteTitle', { name: deleteTarget.provider.name })}</DialogTitle>
          <DialogDescription>{t(section === 'web' ? 'settings.deleteWebDescription' : 'settings.deleteModelDescription', { name: deleteTarget.provider.name })}</DialogDescription>
          {deleteError && <p className="configuration-error" role="alert"><NoticeText notice={deleteError} /></p>}
          <div className="provider-actions">
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="outline" className="delete-provider" disabled={deleting} onClick={() => void confirmDelete()}>{t(deleting ? 'common.deleting' : 'common.delete')}</Button>
          </div>
        </DialogContent>
      </Dialog>}
    </DialogContent>
  </Dialog>
}
