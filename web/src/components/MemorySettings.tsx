import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronDownIcon, CopyIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectMemoryEntryView, ProjectMemoryView, UserMemoryView } from '@agent-learning/server/protocol'
import { deleteProjectMemoryEntry, getMemorySettings, getProjectMemories, getUserMemory, saveMemorySettings, saveUserMemory } from '../chat/client'
import type { CopyKey } from '../i18n/en'
import { RequestError } from '../i18n/messages'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

function useMemoryView<T>(read: () => Promise<T>) {
  const [view, setView] = useState<T>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    void read().then(value => {
      if (current) setView(value)
    }, () => {
      if (current) setFailed(true)
    })
    return () => { current = false }
  }, [read, attempt])
  return { view, setView, failed, retry: () => { setFailed(false); setAttempt(count => count + 1) } }
}

function LoadingMemory({ failed, retry }: { failed: boolean; retry: () => void }) {
  const { t } = useTranslation()
  if (!failed) return <p className="settings-help" role="status">{t('memory.loading')}</p>
  return <>
    <p className="configuration-error" role="alert">{t('memory.readFailed')}</p>
    <Button variant="outline" size="sm" onClick={retry}>{t('common.retry')}</Button>
  </>
}

export function MemorySettings() {
  const { t } = useTranslation()
  const switchId = useId()
  const settings = useMemoryView(getMemorySettings)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  async function toggle(enabled: boolean) {
    setSaving(true)
    setFailed(false)
    try { settings.setView(await saveMemorySettings(enabled)) }
    catch { setFailed(true) }
    finally { setSaving(false) }
  }

  return <section className="web-settings-group" aria-labelledby="memory-settings-heading">
    <h4 id="memory-settings-heading">{t('memory.title')}</h4>
    <div className="memory-settings-rows">
      <div className="settings-option-row">
        <label htmlFor={switchId}>{t('memory.enabled')}</label>
        <Switch id={switchId} checked={settings.view?.memoryEnabled ?? false} disabled={!settings.view || saving}
          aria-busy={saving || (!settings.view && !settings.failed)} onCheckedChange={enabled => { void toggle(enabled) }} />
      </div>
      {!settings.view && <LoadingMemory failed={settings.failed} retry={settings.retry} />}
      {failed && <p className="configuration-error" role="alert">{t('memory.switchFailed')}</p>}
      <ManagementDialog title="memory.user" description="memory.userDescription"><UserMemoryEditor /></ManagementDialog>
      <ManagementDialog title="memory.projects" description="memory.projectsDescription"><ProjectMemoryList /></ManagementDialog>
    </div>
  </section>
}

function ManagementDialog({ title, description, children }: {
  title: 'memory.user' | 'memory.projects'; description: CopyKey; children: ReactNode
}) {
  const { t } = useTranslation()
  return <Dialog>
    <div className="settings-option-row">
      <span>{t(title)}</span>
      <DialogTrigger asChild><Button variant="outline" size="sm"
        aria-label={t('memory.manageSummary', { name: t(title) })}>{t('memory.manage')}</Button></DialogTrigger>
    </div>
    <DialogContent className="memory-dialog" overlayClassName="provider-delete-overlay" closeLabel={t('common.close')}>
      <DialogTitle>{t(title)}</DialogTitle>
      <DialogDescription className="settings-help">{t(description)}</DialogDescription>
      {children}
    </DialogContent>
  </Dialog>
}

type MemoryReview = { state: 'required' | 'loading' | 'failed' } | { state: 'ready'; latest: UserMemoryView }

function UserMemoryEditor() {
  const { t } = useTranslation()
  const editorId = useId()
  const latestId = useId()
  const memory = useMemoryView(getUserMemory)
  const [draft, setDraft] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<CopyKey>()
  const [review, setReview] = useState<MemoryReview>()
  const latest = review?.state === 'ready' ? review.latest : undefined
  const base = review ? latest : memory.view

  async function reviewLatest() {
    if (review?.state === 'loading' || saving) return
    setReview({ state: 'loading' })
    try { setReview({ state: 'ready', latest: await getUserMemory() }) }
    catch { setReview({ state: 'failed' }) }
  }

  async function save() {
    if (!base || draft === undefined || draft === base.markdown || saving) return
    setNotice(undefined)
    setSaving(true)
    try {
      memory.setView(await saveUserMemory(draft, base.revision))
      setDraft(undefined)
      setReview(undefined)
      setNotice('memory.saved')
    } catch (error) {
      const status = error instanceof RequestError && error.notice.status
      if (status === 409) setReview({ state: 'required' })
      else setNotice(status === 422 ? 'memory.capacityExceeded' : 'memory.saveFailed')
    } finally { setSaving(false) }
  }

  if (!memory.view) return <LoadingMemory failed={memory.failed} retry={memory.retry} />
  return <form className="user-memory-form" onSubmit={event => { event.preventDefault(); void save() }}>
    <label htmlFor={editorId}>Markdown</label>
    <Textarea id={editorId} value={draft ?? memory.view.markdown} readOnly={saving} spellCheck={false}
      onChange={event => { setDraft(event.target.value); setNotice(undefined) }} />
    {review && <>
      {!latest && <p className="configuration-error" role="alert">
        {t(review.state === 'failed' ? 'memory.readLatestFailed' : 'memory.versionConflict')}
      </p>}
      <Button type="button" className="memory-review-button" variant="outline" size="sm"
        aria-disabled={review.state === 'loading' || saving} onClick={() => { void reviewLatest() }}>
        {t(review.state === 'loading' ? 'memory.loading' : 'memory.reviewLatest')}
      </Button>
      {latest && <>
        <label htmlFor={latestId}>{t('memory.latestMarkdown')}</label>
        <Textarea id={latestId} className="memory-latest" value={latest.markdown} readOnly spellCheck={false} />
        <p className="settings-help">{t('memory.saveDraftHelp')}</p>
      </>}
    </>}
    {notice && <p className={notice === 'memory.saved' ? 'configuration-success' : 'configuration-error'}
      role={notice === 'memory.saved' ? 'status' : 'alert'}>{t(notice)}</p>}
    <div className="provider-actions">
      <Button type="submit" disabled={saving || !base || draft === undefined || draft === base.markdown}>
        {t(saving ? 'common.saving' : latest ? 'memory.saveDraft' : 'common.save')}
      </Button>
    </div>
  </form>
}

function ProjectMemoryList() {
  const { t } = useTranslation()
  const memory = useMemoryView(getProjectMemories)
  const [deleting, setDeleting] = useState(false)
  const [failure, setFailure] = useState<CopyKey>()

  async function remove(projectId: string, entry: ProjectMemoryEntryView, trigger: HTMLButtonElement) {
    if (!memory.view || deleting) return
    setDeleting(true)
    setFailure(undefined)
    try {
      const { project } = await deleteProjectMemoryEntry(projectId, entry.entryId, entry.revision)
      if (document.activeElement === trigger) trigger.closest<HTMLElement>('[role=dialog]')?.focus()
      memory.setView({ projects: memory.view.projects.flatMap(previous => previous.projectId !== projectId ? [previous] : project?.count ? [project] : []) })
    } catch (error) {
      setFailure(error instanceof RequestError && error.notice.status === 409 ? 'memory.deleteConflict' : 'memory.deleteFailed')
    } finally { setDeleting(false) }
  }

  if (!memory.view) return <LoadingMemory failed={memory.failed} retry={memory.retry} />
  if (!memory.view.projects.length) return <p className="settings-help" role="status">{t('memory.emptyProjects')}</p>
  return <>
    {failure && <p className="configuration-error" role="alert">{t(failure)}</p>}
    <div className="memory-projects">
      {memory.view.projects.map(project => <MemoryProject key={project.projectId} project={project} deleting={deleting}
        remove={(entry, trigger) => { void remove(project.projectId, entry, trigger) }} />)}
    </div>
  </>
}

function MemoryProject({ project, deleting, remove }: {
  project: ProjectMemoryView; deleting: boolean; remove: (entry: ProjectMemoryEntryView, trigger: HTMLButtonElement) => void
}) {
  const { t } = useTranslation()
  return <Collapsible className="memory-project">
    <CollapsibleTrigger asChild>
      <Button className="memory-project-trigger" variant="ghost" title={project.path}>
        <ChevronDownIcon aria-hidden="true" /><span>{project.name}</span><span className="settings-help">{t('memory.entries', { count: project.count })}</span>
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <ul className="memory-project-entries">
        {project.entries.map(entry => <li key={entry.entryId}>
          <div className="memory-entry-content">
            <span>{entry.title}</span>
            <p className="settings-help">{entry.summary}</p>
            <MemoryPath path={entry.path} />
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={t('memory.deleteEntry', { name: entry.title })} aria-disabled={deleting}
            onClick={event => remove(entry, event.currentTarget)}><XIcon aria-hidden="true" /></Button>
        </li>)}
      </ul>
    </CollapsibleContent>
  </Collapsible>
}

function MemoryPath({ path }: { path: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState<boolean>()
  async function copy() {
    try { await navigator.clipboard.writeText(path); setCopied(true) }
    catch { setCopied(false) }
  }
  return <>
    <div className="memory-entry-path">
      <code>{path}</code>
      <Button variant="ghost" size="icon-sm" aria-label={t('memory.copyPath')} onClick={() => { void copy() }}>
        <CopyIcon aria-hidden="true" />
      </Button>
    </div>
    <span className="sr-only" role="status">{copied && t('markdown.copied')}</span>
    {copied === false && <p className="configuration-error" role="alert">{t('markdown.copyContentFailed')}</p>}
  </>
}
