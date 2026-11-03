import { useRef, useState, type FormEvent } from 'react'
import type { ModelDiscovery } from '@agent-learning/model'
import { deleteApiKey, saveApiKey } from '../chat/client'
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
}

export function SettingsDialog({ discovery, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [screen, setScreen] = useState<'models' | 'providers' | 'edit'>('models')
  const [form, setForm] = useState<ProviderFormState>({ apiKey: '', status: 'idle' })
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const configured = discovery?.deepseek.state === 'configured'
  const busy = form.status !== 'idle'

  function changeOpen(next: boolean) {
    generation.current++
    setOpen(next)
    setScreen('models')
    setForm({ apiKey: '', status: 'idle' })
    setNotice('')
  }

  async function update(deleting = false) {
    if (busy) return
    const current = generation.current
    setForm(previous => ({ ...previous, status: deleting ? 'deleting' : 'saving', errorMessage: undefined }))
    setNotice('')
    try {
      const result = await (deleting ? deleteApiKey() : saveApiKey(form.apiKey))
      onChange(result)
      if (current !== generation.current) return
      setForm({ apiKey: '', status: 'idle' })
      setNotice(deleting ? '已删除本机配置' : '已保存在本机，尚未验证远端有效性')
      if (deleting) setScreen('models')
    } catch (error) {
      if (current !== generation.current) return
      setForm(previous => ({ ...previous, status: 'idle', errorMessage: error instanceof Error ? error.message : '配置更新失败，请重试' }))
    }
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (form.apiKey.trim()) void update()
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><Button className="settings-trigger" variant="ghost">设置</Button></DialogTrigger>
    <DialogContent>
      <DialogTitle className="settings-title">设置</DialogTitle>
      <DialogDescription className="settings-description">管理本机模型凭据。保存只检查本地配置，不验证服务商账号。</DialogDescription>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类"><Button variant="secondary" aria-current="page" onClick={() => setScreen('models')}>模型</Button></nav>
        <section className="settings-models" aria-labelledby="models-heading">
          <h2 id="models-heading">模型</h2>
          <p className="settings-help">添加 DeepSeek API Key 后，模型会出现在聊天页面。</p>
          {discovery?.deepseek.state === 'error' && <p className="configuration-error" role="alert">{discovery.deepseek.message}</p>}
          {screen === 'models' && <>
            {configured && <div className="provider-row"><span>DeepSeek <small>已配置</small></span><Button variant="outline" onClick={() => setScreen('edit')}>编辑</Button></div>}
            {!configured && <Button variant="outline" onClick={() => setScreen('providers')}>添加提供方</Button>}
          </>}
          {screen === 'providers' && <Button className="provider-choice" variant="outline" onClick={() => setScreen('edit')}>DeepSeek</Button>}
          {screen === 'edit' && <form className="provider-form" onSubmit={save}>
            <h3>DeepSeek</h3>
            <label htmlFor="deepseek-key">API Key</label>
            <div className="provider-key-field"><input id="deepseek-key" type="password" value={form.apiKey} autoComplete="off" spellCheck={false} disabled={busy} placeholder={configured ? '输入新的 API Key 以替换' : '输入 API Key'} onChange={event => setForm(previous => ({ ...previous, apiKey: event.target.value, errorMessage: undefined }))} /></div>
            <p className="settings-help">已有 Key 不会回填；新输入在保存成功或关闭设置后清空。</p>
            <div className="provider-actions">
              <Button type="submit" disabled={busy || !form.apiKey.trim()}>{form.status === 'saving' ? '保存中…' : '保存'}</Button>
              {configured && <Button type="button" variant="ghost" className="delete-provider" disabled={busy} onClick={() => { void update(true) }}>{form.status === 'deleting' ? '删除中…' : '删除 API Key'}</Button>}
            </div>
          </form>}
          {form.errorMessage && <p className="configuration-error" role="alert">{form.errorMessage}</p>}
          {notice && <p className="configuration-success" aria-live="polite">{notice}</p>}
        </section>
      </div>
    </DialogContent>
  </Dialog>
}
