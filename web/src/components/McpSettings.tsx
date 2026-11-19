import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronRightIcon, EllipsisIcon, PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { McpServerView, SaveMcpServerRequest } from '@agent-learning/server/protocol'
import { cancelMcpOAuth, deleteMcpServer, enableMcpServer, saveMcpServer, startMcpOAuth } from '../chat/client'
import { errorNotice, NoticeText, type Notice } from '../i18n/messages'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'

export type McpSettingsProps = {
  servers: McpServerView[] | null
  error: Notice | null
  refresh: () => Promise<McpServerView[] | undefined>
}

type Editor = {
  original?: McpServerView
  name: string
  url: string
  authMode: McpServerView['authMode']
  token: string
  clientId: string
  clientSecret: string
}

type EnableIntent = {
  popup?: Window | null
  phase: 'enabling' | 'connecting' | 'authorizing'
}

type LocalAuthorization = { attemptId: string; authorizationUrl?: string }

function reserveAuthorizationPopup() {
  const popup = window.open('about:blank', '_blank')
  if (popup) popup.opener = null
  return popup
}

function sameAddress(left: string, right: string) {
  try { return new URL(left).href === new URL(right).href }
  catch { return false }
}

export function McpSettings({ servers, error, refresh }: McpSettingsProps) {
  const { t } = useTranslation()
  const [editor, setEditor] = useState<Editor>()
  const [notice, setNotice] = useState<Notice>()
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [removeTarget, setRemoveTarget] = useState<McpServerView>()
  const [authorization, setAuthorization] = useState<Record<string, LocalAuthorization | 'opening' | undefined>>({})
  const enables = useRef(new Map<string, EnableIntent>()).current
  const add = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menus = useRef(new Map<string, HTMLButtonElement>())

  function openEditor(original: McpServerView | undefined, button: HTMLButtonElement | null) {
    trigger.current = button
    setEditor({
      original, name: original?.name ?? '', url: original?.url ?? '',
      authMode: original?.authMode ?? 'token', token: '', clientId: original?.clientId ?? '', clientSecret: '',
    })
    setNotice(undefined)
    setSaved(false)
  }

  function closeEditor() {
    if (trigger.current?.isConnected) trigger.current.focus()
    else add.current?.focus()
    setEditor(undefined)
  }

  async function run(update: () => Promise<void>, done?: () => void) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setNotice(undefined)
    setSaved(false)
    let completed = false
    try {
      await update()
      completed = true
    } catch (error) {
      setNotice(errorNotice('settings.updateFailed', error))
    } finally {
      await refresh()
      pending.current = false
      setBusy(false)
    }
    if (completed) done?.()
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    const { original, authMode } = editor
    const name = editor.name.trim()
    const url = editor.url.trim()
    if (!name || !url) return
    const token = editor.token.trim()
    const clientId = editor.clientId.trim()
    const clientSecret = clientId ? editor.clientSecret.trim() : ''
    const input: SaveMcpServerRequest = {
      name, url, authMode, ...(authMode === 'token' ? (token ? { token } : {}) : {
        clientId, ...(clientSecret ? { clientSecret } : {}),
      }),
    }
    const existingIds = new Set(servers?.map(server => server.id))
    void run(async () => {
      try { await saveMcpServer(input, original?.id) }
      catch (failure) {
        const next = await refresh()
        const { key, status } = errorNotice('settings.updateFailed', failure)
        if (key !== 'request.network' && key !== 'request.invalid' && !(status && status >= 500)) throw failure
        const matches = (server: McpServerView) => server.name === name && sameAddress(server.url, url)
          && server.authMode === authMode && (authMode === 'token' ? server.hasCredential : (server.clientId ?? '') === clientId)
        const registered = original
          ? !token && !clientSecret && !matches(original) && next?.some(server => server.id === original.id && matches(server))
          : !clientSecret && next?.some(server => !existingIds.has(server.id) && matches(server))
        if (!registered) throw failure
      }
    }, () => {
      closeEditor()
      setSaved(true)
    })
  }

  const discardEnable = useCallback((id: string) => {
    enables.get(id)?.popup?.close()
    enables.delete(id)
  }, [enables])

  const authorize = useCallback(async (id: string, intent: EnableIntent) => {
    intent.phase = 'authorizing'
    setAuthorization(links => ({ ...links, [id]: 'opening' }))
    try {
      const attempt = await startMcpOAuth(id)
      if (enables.get(id) !== intent) return
      if (intent.popup === undefined) intent.popup = reserveAuthorizationPopup()
      let authorizationUrl: string | undefined = attempt.authorizationUrl
      if (intent.popup && !intent.popup.closed) {
        intent.popup.location.replace(authorizationUrl)
        intent.popup = undefined
        authorizationUrl = undefined
      }
      setAuthorization(links => ({ ...links, [id]: { attemptId: attempt.attemptId, authorizationUrl } }))
    } catch (error) {
      if (enables.get(id) !== intent) return
      setAuthorization(links => ({ ...links, [id]: undefined }))
      const failure = errorNotice('settings.updateFailed', error)
      if (failure.status === 409) {
        const current = (await refresh())?.find(server => server.id === id)
        if (enables.get(id) !== intent) return
        if (current?.enabled && (current.status === 'connecting' || current.status === 'connected')) return
      }
      setNotice(failure)
    } finally {
      if (enables.get(id) === intent) discardEnable(id)
      await refresh()
    }
  }, [discardEnable, enables, refresh])

  const advanceEnable = useCallback((server: McpServerView) => {
    const { id, status } = server
    const intent = enables.get(id)
    if (intent?.phase !== 'connecting' || status === 'connecting') return
    if (server.enabled && status === 'authorization_required') void authorize(id, intent)
    else discardEnable(id)
  }, [authorize, discardEnable, enables])

  useEffect(() => {
    if (!servers) return
    for (const id of enables.keys()) {
      const server = servers.find(server => server.id === id)
      if (server) advanceEnable(server)
      else discardEnable(id)
    }
  }, [advanceEnable, discardEnable, enables, servers])

  useEffect(() => () => {
    for (const id of enables.keys()) discardEnable(id)
  }, [discardEnable, enables])

  function forgetAuthorization(id: string) {
    discardEnable(id)
    setAuthorization(links => ({ ...links, [id]: undefined }))
  }

  async function changeEnabled(server: McpServerView, enabled: boolean) {
    const { id } = server
    if (enabled && enables.has(id)) return
    setNotice(undefined)
    setSaved(false)

    let intent: EnableIntent | undefined
    if (enabled) {
      intent = { phase: 'enabling' }
      // Reserve the window during the click when OAuth is likely to need it.
      if (server.authMode === 'oauth' && (!server.hasCredential || server.status === 'authorization_required')) {
        intent.popup = reserveAuthorizationPopup()
      }
      enables.set(id, intent)
    } else {
      forgetAuthorization(id)
    }

    try {
      const result = await enableMcpServer(id, enabled)
      if (intent && enables.get(id) === intent) {
        intent.phase = 'connecting'
        advanceEnable(result)
      }
    } catch (error) {
      if (!intent || enables.get(id) === intent) {
        discardEnable(id)
        setNotice(errorNotice('settings.updateFailed', error))
      }
    } finally {
      await refresh()
    }
  }

  function reopenAuthorization(id: string) {
    if (enables.get(id)?.phase === 'authorizing') return
    setNotice(undefined)
    const intent: EnableIntent = { popup: reserveAuthorizationPopup(), phase: 'authorizing' }
    enables.set(id, intent)
    void authorize(id, intent)
  }

  const retainedToken = editor?.original?.authMode === 'token' && editor.original.hasCredential && sameAddress(editor.original.url, editor.url)
  const form = editor && <form className="provider-form" onSubmit={save}>
    <label htmlFor="mcp-name">{t('mcp.name')}</label>
    <Input id="mcp-name" required autoComplete="off" value={editor.name} disabled={busy}
      onChange={event => setEditor({ ...editor, name: event.target.value })} />
    <label htmlFor="mcp-url">{t('mcp.url')}</label>
    <Input id="mcp-url" required type="url" autoComplete="off" spellCheck={false} value={editor.url} disabled={busy}
      onChange={event => setEditor({ ...editor, url: event.target.value })} />
    <div className="settings-field">
      <label htmlFor="mcp-auth">{t('mcp.authMode')}</label>
      <Select value={editor.authMode} disabled={busy} onValueChange={(authMode: Editor['authMode']) =>
        setEditor({ ...editor, authMode, token: '', clientSecret: '' })}>
        <SelectTrigger id="mcp-auth"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="token">{t('mcp.token')}</SelectItem>
          <SelectItem value="oauth">{t('mcp.oauth')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    {editor.authMode === 'token' ? <>
      <label htmlFor="mcp-token">{t('mcp.token')}</label>
      <Input id="mcp-token" type="password" required={!retainedToken} autoComplete="off" spellCheck={false} value={editor.token} disabled={busy}
        placeholder={retainedToken ? t('mcp.replaceToken') : undefined}
        onChange={event => setEditor({ ...editor, token: event.target.value })} />
    </> : <>
      {editor.original?.authMode === 'oauth' && <p className="settings-help">
        {t(servers?.find(server => server.id === editor.original?.id)?.hasCredential ? 'mcp.oauthSaved' : 'mcp.oauthMissing')}
      </p>}
      <label htmlFor="mcp-client-id">{t('mcp.clientId')}</label>
      <Input id="mcp-client-id" autoComplete="off" spellCheck={false} value={editor.clientId} disabled={busy}
        onChange={event => setEditor({ ...editor, clientId: event.target.value, clientSecret: '' })} />
      {editor.clientId.trim() && <>
        <label htmlFor="mcp-client-secret">{t('mcp.clientSecret')}</label>
        <Input id="mcp-client-secret" type="password" autoComplete="off" spellCheck={false} value={editor.clientSecret} disabled={busy}
          onChange={event => setEditor({ ...editor, clientSecret: event.target.value })} />
      </>}
    </>}
    <div className="provider-actions">
      <Button type="button" variant="outline" disabled={busy} onClick={closeEditor}>{t('common.cancel')}</Button>
      <Button type="submit" disabled={busy}>{t('common.save')}</Button>
    </div>
  </form>

  return <>
    {error && <p className="configuration-error" role="alert"><NoticeText notice={error} /></p>}
    {!servers && !error && <p className="settings-help" role="status">{t('mcp.loading')}</p>}
    {error && <Button variant="outline" size="sm" onClick={() => void refresh()}>{t('mcp.refresh')}</Button>}
    {notice && !removeTarget && <p className="configuration-error" role="alert"><NoticeText notice={notice} /></p>}
    {saved && <p className="configuration-success" role="status">{t('mcp.saved')}</p>}
    <div className="provider-list">
      {servers?.map(server => {
        const status = server.enabled ? server.status : 'disabled'
        const checked = status === 'connected' || status === 'recovering'
        const connecting = status === 'connecting' || status === 'authorizing'
        const editing = editor?.original?.id === server.id
        const attempt = server.attemptId
        const localAuthorization = authorization[server.id]
        const localAttempt = localAuthorization !== 'opening' && localAuthorization?.attemptId === attempt
          ? localAuthorization : undefined
        const link = localAttempt?.authorizationUrl
        const showAuthorizationActions = localAuthorization !== 'opening' && (!localAttempt || link)
        return <article key={server.id} className="provider-row mcp-server" aria-label={server.name}>
          <div className="provider-row-heading">
            <span>{server.name}</span>
            <Switch checked={checked} aria-label={t('mcp.toggle', { name: server.name })}
              className="motion-safe:aria-busy:animate-pulse" aria-busy={connecting || undefined}
              aria-description={connecting ? t('mcp.stopPending') : undefined}
              onCheckedChange={next => void changeEnabled(server, next && !connecting)} />
          </div>
          <div className="mcp-server-details">
            <div className="mcp-server-summary">
              <p className="settings-help">{server.url}</p>
              {server.tools.length > 0 && status === 'connected' && <Collapsible className="mcp-tools">
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="xs" className="group">
                    <ChevronRightIcon aria-hidden="true" className="group-data-[state=open]:rotate-90" />
                    {t('mcp.tools', { count: server.tools.length })}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent asChild>
                  <ul>{server.tools.map(tool => <li key={tool.name} title={tool.description}>{tool.name}</li>)}</ul>
                </CollapsibleContent>
              </Collapsible>}
              {status === 'authorizing' && attempt && showAuthorizationActions && <div className="mcp-authorization">
                {link ? <Button asChild variant="link" size="xs">
                  <a href={link} target="_blank" rel="noopener noreferrer">{t('mcp.openOAuth')}</a>
                </Button> : <Button variant="link" size="xs" disabled={busy}
                  onClick={() => reopenAuthorization(server.id)}>{t('mcp.openOAuth')}</Button>}
                <Button variant="outline" size="xs" disabled={busy} onClick={() => {
                  forgetAuthorization(server.id)
                  void run(async () => { await cancelMcpOAuth(server.id, attempt) })
                }}>{t('mcp.cancelOAuth')}</Button>
              </div>}
            </div>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={t('mcp.moreActions')} disabled={busy}
                  ref={node => {
                    if (node) menus.current.set(server.id, node)
                    else menus.current.delete(server.id)
                  }}>
                  <EllipsisIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onCloseAutoFocus={event => {
                if (removeTarget?.id === server.id) event.preventDefault()
              }}>
                <DropdownMenuItem onSelect={() => editing ? closeEditor() : openEditor(server, menus.current.get(server.id) ?? null)}>
                  {t('common.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem className="delete-provider" onSelect={() => {
                  setNotice(undefined)
                  setRemoveTarget(server)
                }}>{t('common.delete')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {editing && form}
        </article>
      })}
    </div>
    <Button ref={add} className="provider-add" variant="outline" aria-expanded={!!editor && !editor.original} disabled={!servers || busy}
      onClick={event => editor && !editor.original ? closeEditor() : openEditor(undefined, event.currentTarget)}>
      <PlusIcon aria-hidden="true" />{t('mcp.add')}
    </Button>
    {editor && !editor.original && <div className="provider-row provider-add-card">{form}</div>}
    {removeTarget && <Dialog open onOpenChange={open => { if (!open && !busy) setRemoveTarget(undefined) }}>
      <DialogContent className="provider-delete-dialog" overlayClassName="provider-delete-overlay" closeLabel={t('common.close')}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const menu = menus.current.get(removeTarget.id)
          if (menu) menu.focus()
          else add.current?.focus()
        }}>
        <DialogTitle>{t('settings.deleteTitle', { name: removeTarget.name })}</DialogTitle>
        <DialogDescription>{t('mcp.deleteDescription', { name: removeTarget.name })}</DialogDescription>
        {notice && <p className="configuration-error" role="alert"><NoticeText notice={notice} /></p>}
        <div className="provider-actions">
          <Button variant="outline" disabled={busy} onClick={() => setRemoveTarget(undefined)}>{t('common.cancel')}</Button>
          <Button variant="outline" className="delete-provider" disabled={busy} onClick={() => void run(async () => {
            const result = await deleteMcpServer(removeTarget.id)
            if (result.error) setNotice({ key: 'mcp.deleteCleanupFailed', detail: result.error })
          }, () => {
            if (editor?.original?.id === removeTarget.id) setEditor(undefined)
            setRemoveTarget(undefined)
          })}>{t(busy ? 'common.deleting' : 'common.delete')}</Button>
        </div>
      </DialogContent>
    </Dialog>}
  </>
}
