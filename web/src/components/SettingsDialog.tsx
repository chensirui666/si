import { useRef, useState, type FormEvent } from 'react'
import type { ModelDiscovery } from '@agent-learning/model'
import type { WebSettingsView } from '@agent-learning/server/protocol'
import { deleteApiKey, saveApiKey, deleteWebApiKey, saveWebApiKey, saveWebSettings } from '../chat/client'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog'

type ProviderFormState = {
  apiKey: string
  status: 'idle' | 'saving' | 'deleting'
  errorMessage?: string
}

type Props = {
  discovery: ModelDiscovery | null
  onChange: (discovery: ModelDiscovery) => void
  webSettings?: WebSettingsView | null
  webSettingsError?: string | null
  onWebSettingsChange?: (settings: WebSettingsView) => void
}

type Screen = 'models' | 'providers' | 'edit' | 'web'

export function SettingsDialog({ discovery, onChange, webSettings, webSettingsError, onWebSettingsChange }: Props) {
  const [open, setOpen] = useState(false)
  const [screen, setScreen] = useState<Screen>('models')
  const [webProviderId, setWebProviderId] = useState('')
  const [form, setForm] = useState<ProviderFormState>({ apiKey: '', status: 'idle' })
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const pending = useRef(false)
  const configured = discovery?.deepseek.state === 'configured'
  const web = screen === 'web'
  const webProvider = webSettings?.providers.find(provider => provider.id === webProviderId)
  const busy = form.status !== 'idle'

  function navigate(next: Screen, providerId = '') {
    generation.current++
    pending.current = false
    setScreen(next)
    setWebProviderId(providerId)
    setForm({ apiKey: '', status: 'idle' })
    setNotice('')
  }

  function changeOpen(next: boolean) {
    setOpen(next)
    navigate('models')
  }

  async function runUpdate(status: 'saving' | 'deleting', update: () => Promise<void>, message: string, done?: () => void) {
    if (pending.current) return
    pending.current = true
    const current = generation.current
    setForm(previous => ({ ...previous, status, errorMessage: undefined }))
    setNotice('')
    try {
      await update()
      if (current !== generation.current) return
      setForm(previous => ({ ...previous, status: 'idle' }))
      done?.()
      setNotice(message)
    } catch (error) {
      if (current !== generation.current) return
      setForm(previous => ({ ...previous, status: 'idle', errorMessage: error instanceof Error ? error.message : '配置更新失败，请重试' }))
    } finally {
      if (current === generation.current) pending.current = false
    }
  }

  function updateKey(deleting = false) {
    void runUpdate(deleting ? 'deleting' : 'saving', async () => {
      if (web && webProvider) {
        const settings = await (deleting ? deleteWebApiKey(webProvider.id) : saveWebApiKey(webProvider.id, form.apiKey))
        onWebSettingsChange?.(settings)
      } else {
        onChange(await (deleting ? deleteApiKey() : saveApiKey(form.apiKey)))
      }
    }, deleting ? '已删除本机配置' : '已保存在本机，尚未验证远端有效性', () => {
      setForm({ apiKey: '', status: 'idle' })
      if (!deleting) return
      if (web) setWebProviderId('')
      else setScreen('models')
    })
  }

  function updateSelection(field: 'searchProvider' | 'fetchProvider', value: string) {
    if (!webSettings) return
    const { searchProvider, fetchProvider } = webSettings
    void runUpdate('saving', async () => {
      const settings = await saveWebSettings({ searchProvider, fetchProvider, [field]: value })
      onWebSettingsChange?.(settings)
    }, '网页服务商选择已保存在本机')
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (form.apiKey.trim()) updateKey()
  }

  function keyForm(name: string, hasKey: boolean) {
    return <form className="provider-form" onSubmit={save}>
      <h3>{name}</h3>
      <label htmlFor="provider-key">API Key</label>
      <div className="provider-key-field"><input id="provider-key" type="password" value={form.apiKey} autoComplete="off" spellCheck={false} disabled={busy} placeholder={hasKey ? '输入新的 API Key 以替换' : '输入 API Key'} onChange={event => setForm(previous => ({ ...previous, apiKey: event.target.value, errorMessage: undefined }))} /></div>
      <p className="settings-help">已有 Key 不会回填。保存成功或关闭编辑后会清空输入。</p>
      <div className="provider-actions">
        <Button type="submit" disabled={busy || !form.apiKey.trim()}>{form.status === 'saving' ? '保存中…' : '保存'}</Button>
        {hasKey && <Button type="button" variant="ghost" className="delete-provider" disabled={busy} onClick={() => updateKey(true)}>{form.status === 'deleting' ? '删除中…' : '删除 API Key'}</Button>}
      </div>
    </form>
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><Button className="settings-trigger" variant="ghost">设置</Button></DialogTrigger>
    <DialogContent>
      <DialogTitle className="settings-title">设置</DialogTitle>
      <DialogDescription className="settings-description">管理本机模型和网页工具。保存只检查本地配置，远端有效性需在使用时验证。</DialogDescription>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <Button variant={web ? 'ghost' : 'secondary'} aria-current={web ? undefined : 'page'} onClick={() => navigate('models')}>模型</Button>
          <Button variant={web ? 'secondary' : 'ghost'} aria-current={web ? 'page' : undefined} onClick={() => navigate('web')}>网页工具</Button>
        </nav>
        <section className="settings-models" aria-labelledby="settings-heading">
          <h2 id="settings-heading">{web ? '网页工具' : '模型'}</h2>
          {web ? <>
            <p className="settings-help">选择网页搜索和网页获取的服务商。同一服务商的两种能力共用一个 API Key。</p>
            {webSettingsError && <p className="configuration-error" role="alert">{webSettingsError}</p>}
            {!webSettings && !webSettingsError && <p className="settings-help">正在读取网页工具设置…</p>}
            {webSettings && <>
              <div className="web-provider-selections">
                {([
                  { field: 'searchProvider', capability: 'search', label: '网页搜索' },
                  { field: 'fetchProvider', capability: 'fetch', label: '网页获取' },
                ] as const).map(({ field, capability, label }) => <label key={field}>
                  {label}
                  <select value={webSettings[field]} disabled={busy} onChange={event => updateSelection(field, event.target.value)}>
                    {webSettings.providers.filter(provider => provider.capabilities.includes(capability)).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                </label>)}
              </div>
              {webSettings.providers.map(provider => <div className="provider-row" key={provider.id}>
                <div>
                  <span>{provider.name} <small data-status={provider.status.state}>{provider.status.state === 'configured' ? '已配置' : provider.status.state === 'missing' ? '未配置' : '配置异常'}</small></span>
                  {provider.status.state === 'error' && <p className="configuration-error" role="alert">{provider.status.message}</p>}
                </div>
                <Button variant="outline" disabled={busy} aria-label={`编辑 ${provider.name}`} onClick={() => navigate('web', provider.id)}>编辑</Button>
              </div>)}
              {webProvider && keyForm(webProvider.name, webProvider.status.state === 'configured')}
            </>}
          </> : <>
            <p className="settings-help">添加 DeepSeek API Key 后，模型会出现在聊天页面。</p>
            {discovery?.deepseek.state === 'error' && <p className="configuration-error" role="alert">{discovery.deepseek.message}</p>}
            {screen === 'models' && (configured
              ? <div className="provider-row"><span>DeepSeek <small>已配置</small></span><Button variant="outline" onClick={() => navigate('edit')}>编辑</Button></div>
              : <Button variant="outline" onClick={() => navigate('providers')}>添加提供方</Button>)}
            {screen === 'providers' && <Button className="provider-choice" variant="outline" onClick={() => navigate('edit')}>DeepSeek</Button>}
            {screen === 'edit' && keyForm('DeepSeek', configured)}
          </>}
          {form.errorMessage && <p className="configuration-error" role="alert">{form.errorMessage}</p>}
          {notice && <p className="configuration-success" aria-live="polite">{notice}</p>}
        </section>
      </div>
    </DialogContent>
  </Dialog>
}
