import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ArrowUpIcon, QuoteIcon, SquareIcon, XIcon } from 'lucide-react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import {
  $addUpdateTag,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  HISTORY_PUSH_TAG,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ESCAPE_COMMAND,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  RootNode,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SCROLL_INTO_VIEW_TAG,
} from 'lexical'
import { mergeRegister } from '@lexical/utils'

import type { SessionSummary, WorkspaceSkills } from '@agent-learning/server/protocol'
import { getWorkspaceSkills } from '../chat/client'
import { errorNotice, NoticeText, skillSourceKey, type Notice } from '../i18n/messages'
import { Button } from '@/components/ui/button'
import { ComposerAddMenu } from './ComposerAddMenu'
import { $styleSkillPrefix, skillPrefix } from './skill-prefix'
import './message-input.css'

type MessageInputProps = {
  onSend: (text: string, restoreDraft: () => void) => boolean
  sendDisabled: boolean
  onSteer?: (text: string) => boolean
  activeRunId?: string
  hidden?: boolean
  action?: 'send' | 'abort' | 'aborting'
  abortDisabled?: boolean
  onAbort?: () => void
  onStop?: () => boolean
  contextMeter?: ReactNode
  permissionControl?: ReactNode
  footerControl?: ReactNode
  commandsEnabled?: boolean
  skillWorkspaceId?: string
  draft?: { text: string }
  onDraftChange?: (text: string) => void
  editorRef?: Ref<HTMLDivElement>
  quote?: string
  onRemoveQuote?: () => void
  attachments?: ReactNode
  onAddFiles?: (files: File[]) => void
  hasAttachments?: boolean
  attachmentsPending?: boolean
  referenceDraft?: ReactNode
  referenceSessions?: readonly SessionSummary[]
  onSelectReference?: (session: SessionSummary) => void
  onPlan?: (draftText: string) => void
  planActive?: boolean
  onExitPlan?: (draftText?: string) => void
}

const initialConfig = {
  namespace: 'message-input',
  onError: (error: Error) => { throw error },
}

function $readDraft() {
  return $getRoot().getChildren().map((paragraph) => paragraph.getTextContent()).join('\n')
}

function $writeDraft(text: string) {
  const root = $getRoot()
  root.clear()
  for (const line of text.split('\n')) {
    const paragraph = $createParagraphNode()
    if (line) paragraph.append($createTextNode(line))
    root.append(paragraph)
  }
}

const restoreTag = 'restore-session-draft'
const optionId = (option: string) =>
  option.startsWith('@') ? `session-option-${option.slice(1)}` : isControl(option)
    ? `${option.slice(1)}-option` : `skill-option-${option.slice(7).trim()}`
const isControl = (text: string) => ['/compact', '/plan', '/stop'].includes(text.trim())
const isStopCommand = (text: string) => /^\/stop(?:$|\s)/iu.test(text.trimStart())
const isPlanCommand = (text: string) => /^\/plan(?:$|\s)/u.test(text.trim())
const isPlanExit = (text: string) => /^\/plan\s+off$/u.test(text.trim())

function $mentionAtCursor() {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
  const node = selection.anchor.getNode()
  if (!($isTextNode(node))) return
  const text = node.getTextContent().slice(0, selection.anchor.offset)
  return /(?:^|\s)(@[^@\r\n]{0,80})$/u.exec(text)?.[1]
}

export function MessageInput(props: MessageInputProps) {
  const initialDraft = props.draft?.text
  return (
    <LexicalComposer initialConfig={{ ...initialConfig, editorState: initialDraft ? () => $writeDraft(initialDraft) : undefined }}>
      <Composer {...props} />
    </LexicalComposer>
  )
}

function Composer({ onSend, onSteer, activeRunId, hidden = false, sendDisabled, action = 'send', abortDisabled = false, onAbort, onStop, contextMeter, permissionControl, footerControl, commandsEnabled = true, skillWorkspaceId, draft, onDraftChange, editorRef, quote, onRemoveQuote,
  attachments, onAddFiles, hasAttachments = false, attachmentsPending = false, referenceDraft,
  referenceSessions, onSelectReference, onPlan, planActive = false, onExitPlan }: MessageInputProps) {
  const { t } = useTranslation()
  const [editor] = useLexicalComposerContext()
  const [hasSkillPrefix, setHasSkillPrefix] = useState(() => skillPrefix.test(draft?.text ?? ''))
  const [inputText, setInputText] = useState(draft?.text ?? '')
  const hasDraft = Boolean(inputText.trim()) || hasAttachments
  const canSend = hasDraft && (!attachmentsPending || isControl(inputText))
  const stopDraft = isStopCommand(inputText)
  const canSubmit = stopDraft ? Boolean(onStop) : isPlanExit(inputText) ? Boolean(onExitPlan) : canSend && !sendDisabled
    && (action === 'send' || Boolean(activeRunId) && !isControl(inputText) && !isPlanCommand(inputText))
  const primaryStops = !stopDraft && action !== 'send' && (action === 'aborting' || !activeRunId || !hasDraft || sendDisabled && !canSubmit)
  const canAbort = action === 'abort' && !abortDisabled && Boolean(onAbort)
  const placeholder = t(planActive ? 'plan.placeholder' : 'chat.placeholder')
  const draftRevision = useRef(0)
  const [query, setQuery] = useState<string | null>(null)
  const menu = useRef<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [catalog, setCatalog] = useState<{ workspaceId: string; view?: WorkspaceSkills; error?: Notice } | null>(null)
  const loadedCatalog = useRef<string | undefined>(undefined)
  const menuOpen = query !== null
  const referenceMenu = Boolean(query?.startsWith('@'))
  const slashMenu = menuOpen && !referenceMenu
  const skillMenu = slashMenu && Boolean(skillWorkspaceId)
  const currentCatalog = catalog?.workspaceId === skillWorkspaceId ? catalog : null
  const canRunCompact = commandsEnabled && !sendDisabled
  const canRunPlan = Boolean(onPlan) && !sendDisabled
  const showCompact = slashMenu && canRunCompact && '/compact'.startsWith(query!)
  const showStop = slashMenu && Boolean(onStop) && '/stop'.startsWith(query!)
  const showPlan = slashMenu && canRunPlan && '/plan'.startsWith(query!)
  const referenceOptions = query?.startsWith('@') ? (referenceSessions ?? []).filter(session =>
    session.name.toLowerCase().includes(query.slice(1).trim().toLowerCase())) : []
  const skillOptions = !slashMenu ? [] : (currentCatalog?.view?.skills ?? []).filter(skill =>
    `/skill:${skill.name}`.startsWith(query!) || `/${skill.name}`.startsWith(query!))
  const options = referenceMenu ? referenceOptions.map(session => `@${session.id}`)
    : [...(showCompact ? ['/compact'] : []), ...(showPlan ? ['/plan'] : []), ...(showStop ? ['/stop'] : []), ...skillOptions.map(skill => `/skill:${skill.name} `)]
  const active = options[Math.min(highlight, options.length - 1)]

  const dismissedText = useRef<string | undefined>(undefined)
  const firstEscape = useRef<{ runId: string; at: number } | undefined>(undefined)
  const composingRef = useRef(false)
  const composingUntilRef = useRef(0)
  const closeMenu = useCallback(() => {
    menu.current = null
    setQuery(null)
    setHighlight(0)
  }, [])
  const refreshMenu = useCallback(() => {
    const text = $readDraft()
    const selection = $getSelection()
    const atEnd = $isRangeSelection(selection) && selection.isCollapsed()
      && selection.anchor.getNode() === $getRoot().getLastDescendant()
      && selection.anchor.offset === selection.anchor.getNode().getTextContentSize()
    const prefix = text.trimStart().toLowerCase()
    const available = (canRunCompact && '/compact'.startsWith(prefix))
      || (canRunPlan && '/plan'.startsWith(prefix)) || (onStop && '/stop'.startsWith(prefix)) || Boolean(skillWorkspaceId)
    const visible = editor.getRootElement() === document.activeElement && !composingRef.current && !editor.isComposing()
      && dismissedText.current !== text
    const slash = visible && available && /^[ \t]*\/[a-z0-9:-]*$/i.test(text) && atEnd
    const mention = visible && referenceSessions && $mentionAtCursor()
    const next = mention || (slash ? prefix : null)
    if (menu.current === next) return
    if (next === null) { closeMenu(); return }
    menu.current = next
    setQuery(next)
    setHighlight(0)
  }, [closeMenu, canRunCompact, canRunPlan, onStop, editor, skillWorkspaceId, referenceSessions])
  const needsCatalog = skillMenu || hasSkillPrefix
  useEffect(() => {
    if (!skillWorkspaceId || !needsCatalog || (!skillMenu && loadedCatalog.current === skillWorkspaceId)) return
    const controller = new AbortController()
    void getWorkspaceSkills(skillWorkspaceId, controller.signal).then(view => {
      if (controller.signal.aborted) return
      loadedCatalog.current = skillWorkspaceId
      setCatalog({ workspaceId: skillWorkspaceId, view })
    }, error => {
      if (controller.signal.aborted) return
      loadedCatalog.current = undefined
      setCatalog({ workspaceId: skillWorkspaceId, error: errorNotice('chat.skillsUnavailable', error) })
    })
    return () => controller.abort()
  }, [needsCatalog, skillMenu, skillWorkspaceId])
  const availableSkills = currentCatalog?.view?.skills
  const styledCatalog = useRef(false)
  useEffect(() => {
    if (!availableSkills && !styledCatalog.current) return
    styledCatalog.current = Boolean(availableSkills)
    const names = new Set(availableSkills?.map(skill => skill.name))
    return editor.registerNodeTransform(RootNode, root => $styleSkillPrefix(root, names))
  }, [availableSkills, editor])
  const completeCommand = useCallback((option: string) => {
    editor.update(() => {
      const text = $readDraft()
      dismissedText.current = text.replace(/\/[a-z0-9:-]*$/i, () => option)
      const root = $getRoot()
      root.clear().append($createParagraphNode().append($createTextNode(dismissedText.current)))
      root.selectEnd()
      closeMenu()
    }, { discrete: true, tag: HISTORY_PUSH_TAG })
  }, [closeMenu, editor])
  const preparePlan = () => {
    editor.getRootElement()?.focus({ preventScroll: true })
    editor.update(() => {
      const text = $readDraft()
      if (!/^\s*\/plan(?:\s|$)/.test(text)) $writeDraft(`/plan ${text}`)
      else if (text.trimStart() === '/plan') $writeDraft(text + ' ')
      $getRoot().selectEnd()
      closeMenu()
    }, { discrete: true, tag: HISTORY_PUSH_TAG })
  }
  const label = t(primaryStops ? (action === 'aborting' ? 'chat.aborting' : 'chat.abort') : 'chat.send')

  const submit = useCallback((text: string, steer = false) => {
    let clearedRevision: number | undefined
    const restoreDraft = () => editor.update(() => {
      if (clearedRevision !== draftRevision.current || $readDraft() !== '') return
      $writeDraft(text)
      if (editor.getRootElement() === document.activeElement) $getRoot().selectEnd()
      else $addUpdateTag(SKIP_DOM_SELECTION_TAG)
    }, { discrete: true, tag: SKIP_SCROLL_INTO_VIEW_TAG })

    try {
      if (isStopCommand(text)) {
        if (steer || composingRef.current || editor.isComposing() || Date.now() < composingUntilRef.current || onStop?.() !== true) return
      } else {
        if (isPlanExit(text)) { if (!steer) onExitPlan?.(text); return }
        if ((isControl(text) || isPlanCommand(text)) && (action !== 'send' || steer)) return
        if (sendDisabled || !text.trim() && !hasAttachments || attachmentsPending && !isControl(text)) return
        if (text.trim() === '/plan' && onPlan) {
          onPlan(text)
          return
        }
        if ((steer ? onSteer?.(text) : onSend(text, restoreDraft)) !== true) return
      }
    } catch (error) {
      // Report receiver errors after Lexical has finished its active update.
      queueMicrotask(() => { throw error })
      return
    }

    editor.update(() => {
      // The cleared editor becomes the undo baseline for the next draft.
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
      const root = $getRoot()
      root.clear().append($createParagraphNode())
      root.selectEnd()
    }, {
      discrete: true,
      tag: SKIP_SCROLL_INTO_VIEW_TAG,
      onUpdate: () => {
        clearedRevision = draftRevision.current
        editor.getRootElement()?.focus({ preventScroll: true })
      },
    })
  }, [editor, onPlan, onExitPlan, onSend, onSteer, onStop, action, sendDisabled, hasAttachments, attachmentsPending])

  const pickOption = useCallback((option: string) => {
    if (option.startsWith('@')) {
      const session = referenceSessions?.find(item => item.id === option.slice(1))
      if (!session || !onSelectReference) return
      editor.update(() => {
        const token = $mentionAtCursor()
        const selection = $getSelection()
        if (!token || !$isRangeSelection(selection)) return
        const anchor = selection.anchor
        selection.setTextNodeRange(anchor.getNode() as ReturnType<typeof $createTextNode>, anchor.offset - token.length,
          anchor.getNode() as ReturnType<typeof $createTextNode>, anchor.offset)
        selection.removeText()
        closeMenu()
      }, { discrete: true, tag: HISTORY_PUSH_TAG })
      onSelectReference(session)
      return
    }
    if (!isControl(option)) { completeCommand(option); return }
    const current = editor.getEditorState().read($readDraft).trimStart().toLowerCase()
    if (current !== menu.current || !option.startsWith(current)) return
    if (option === '/plan' && canRunPlan) completeCommand('/plan ')
    if (option === '/compact' && canRunCompact || option === '/stop' && onStop) submit(option)
  }, [canRunCompact, canRunPlan, onStop, completeCommand, editor, submit, referenceSessions, onSelectReference, closeMenu])

  useEffect(() => editor.registerUpdateListener(({ editorState, prevEditorState, tags }) => {
    const text = editorState.read($readDraft)
    if (text !== prevEditorState.read($readDraft)) {
      draftRevision.current++
      setHasSkillPrefix(skillPrefix.test(text))
      if (!tags.has(restoreTag)) onDraftChange?.(text)
      if (text !== dismissedText.current) dismissedText.current = undefined
    }
    setInputText(text)
    editorState.read(refreshMenu)
  }), [editor, refreshMenu, onDraftChange])

  useEffect(() => {
    if (draft === undefined || editor.getEditorState().read($readDraft) === draft.text) return
    editor.update(() => {
      if (!draft.text) editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
      $writeDraft(draft.text)
      if (editor.getRootElement() === document.activeElement) $getRoot().selectEnd()
      else $addUpdateTag(SKIP_DOM_SELECTION_TAG)
    }, { discrete: true, tag: [restoreTag, SKIP_SCROLL_INTO_VIEW_TAG] })
  }, [draft, editor])

  useEffect(() => {
    const startComposition = () => { composingRef.current = true; closeMenu() }
    const endComposition = () => {
      composingRef.current = false
      // Safari can report the confirming Enter just after compositionend.
      composingUntilRef.current = Date.now() + 10
    }

    const blur = () => {
      firstEscape.current = undefined
      dismissedText.current = editor.getEditorState().read($readDraft)
      closeMenu()
    }
    return mergeRegister(
      editor.registerRootListener((root, previous) => {
        previous?.removeEventListener('compositionstart', startComposition)
        previous?.removeEventListener('compositionend', endComposition)
        previous?.removeEventListener('blur', blur)
        composingRef.current = false
        composingUntilRef.current = 0
        root?.addEventListener('compositionstart', startComposition)
        root?.addEventListener('compositionend', endComposition)
        root?.addEventListener('blur', blur)
      }),
      () => {
        const root = editor.getRootElement()
        root?.removeEventListener('compositionstart', startComposition)
        root?.removeEventListener('compositionend', endComposition)
        root?.removeEventListener('blur', blur)
      },
    )
  }, [editor, closeMenu])

  useEffect(() => {
    const move = (step: number) => (event: KeyboardEvent) => {
      if (!menu.current || !options.length || composingRef.current || editor.isComposing() || event.isComposing || event.keyCode === 229) return false
      event.preventDefault()
      setHighlight(index => (Math.min(index, options.length - 1) + step + options.length) % options.length)
      return true
    }
    return mergeRegister(
      editor.registerCommand(PASTE_COMMAND, event => {
        const files = 'clipboardData' in event ? Array.from(event.clipboardData?.files ?? []) : []
        if (!onAddFiles || !files.length) return false
        event.preventDefault()
        onAddFiles(files)
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, move(1), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, move(-1), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ESCAPE_COMMAND, event => {
        const previous = firstEscape.current
        firstEscape.current = undefined
        if (menu.current) {
          event?.preventDefault()
          dismissedText.current = $readDraft()
          closeMenu()
          return true
        }
        if (!event || event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || !activeRunId || !canAbort || composingRef.current || editor.isComposing() || event.isComposing || event.keyCode === 229
          || Date.now() < composingUntilRef.current) return false
        event.preventDefault()
        const now = performance.now()
        if (previous?.runId === activeRunId && now - previous.at <= 500) onAbort?.()
        else firstEscape.current = { runId: activeRunId, at: now }
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_TAB_COMMAND, event => {
        if (composingRef.current || editor.isComposing() || event.isComposing || event.keyCode === 229 || Date.now() < composingUntilRef.current) return true
        if (!event.shiftKey && menu.current && active) {
          event.preventDefault()
          pickOption(active)
          return true
        }
        if (event.shiftKey) { dismissedText.current = $readDraft(); closeMenu() }
        // 原生 Tab 移焦后，避免本次内部选区提交重新抢回输入焦点。
        $addUpdateTag(SKIP_DOM_SELECTION_TAG)
        return false
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
        // 失焦后的延迟选区同步不应重新聚焦输入框。
        if (editor.getRootElement() !== document.activeElement) $addUpdateTag(SKIP_DOM_SELECTION_TAG)
        return false
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
        if (event === null) return true
        if (event.altKey || event.getModifierState('AltGraph') || event.ctrlKey && event.metaKey) return true
        const steer = event.ctrlKey || event.metaKey
        if (steer && (!onSteer || event.shiftKey)) return true
        if (event.shiftKey) return false
        if (composingRef.current || editor.isComposing() || event.isComposing || event.keyCode === 229 || Date.now() < composingUntilRef.current) return true
        event.preventDefault()
        if (!event.repeat) {
          const text = $readDraft()
          if (!isStopCommand(text) && menu.current && active && !(active === '/plan' && text.trim() === '/plan')) pickOption(active)
          else submit(text, steer)
        }
        return true
      }, COMMAND_PRIORITY_CRITICAL),
    )
  }, [editor, submit, pickOption, closeMenu, active, options.length, onAddFiles, onSteer, activeRunId, canAbort, onAbort])

  useEffect(() => {
    if (active) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const renderOption = (option: string, children: ReactNode) =>
    <Button key={option} variant="ghost" type="button" role="option" aria-selected={active === option}
      id={optionId(option)} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => pickOption(option)}>
      {children}
    </Button>

  return (
    <div hidden={hidden} className="message-input">
      {quote && <div className="composer-quote" role="group" aria-label={t('chat.quotedText')}>
        <QuoteIcon aria-hidden="true" />
        <div className="composer-quote-text">{quote}</div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('chat.removeQuote')} title={t('chat.removeQuote')} onClick={() => {
          onRemoveQuote?.()
          editor.getRootElement()?.focus({ preventScroll: true })
        }}><XIcon aria-hidden="true" /></Button>
      </div>}
      {attachments}
      {referenceDraft}
      {referenceMenu && <div className="command-menu" role="listbox" aria-label={t('chat.sessionReferences')} id="reference-menu">
        {referenceOptions.map(session => renderOption(`@${session.id}`, <span className="session-reference-name">Session · {session.name}</span>))}
        {!referenceOptions.length && <div className="command-menu-label">{t('chat.referenceEmpty')}</div>}
      </div>}
      {slashMenu && <div className="command-menu" role="listbox" aria-label={t('chat.slashMenu')} id="compact-menu">
        {(showCompact || showPlan || showStop) && <div role="group" aria-label={t('chat.commands')}>
          <div className="command-menu-label">{t('chat.commands')}</div>
          {showCompact && renderOption('/compact', <><span>/compact</span><span>{t('chat.compactCommand')}</span></>)}
          {showPlan && renderOption('/plan', <><span>/plan</span><span>{t('plan.command')}</span></>)}
          {showStop && renderOption('/stop', <><span>/stop</span><span>{t('chat.stopCommand')}</span></>)}
        </div>}
        {skillMenu && <div role="group" aria-label={t('chat.skills')}>
          <div className="command-menu-label">{t('chat.skills')}</div>
          {skillOptions.map(skill => renderOption(`/skill:${skill.name} `, <>
            <span>{skill.name}</span>
            <span className="skill-description" title={skill.description}>
              {skill.disableModelInvocation ? `${t('chat.skillUserOnly')} · ` : ''}{skill.description}
            </span>
            <span>{t(skillSourceKey[skill.source])}</span>
          </>))}
          {!currentCatalog && <div className="command-menu-label" role="status">{t('chat.skillsLoading')}</div>}
          {currentCatalog?.error && <div className="command-menu-label" role="status">
            <NoticeText notice={currentCatalog.error} /> · {t('chat.skillsRetry')}
          </div>}
          {currentCatalog?.view && !currentCatalog.view.complete && <div className="command-menu-label" role="status">{t('chat.skillsIncomplete')}</div>}
          {currentCatalog?.view?.complete && !skillOptions.length && <div className="command-menu-label">{t('chat.skillsEmpty')}</div>}
        </div>}
      </div>}
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            ref={editorRef}
            className="message-editor"
            role="textbox"
            aria-label={t('chat.message')}
            aria-multiline="true"
            aria-keyshortcuts={onSteer ? 'Control+Enter Meta+Enter' : undefined}
            onKeyDownCapture={event => { if (event.key !== 'Escape') firstEscape.current = undefined }}
            aria-controls={referenceMenu ? 'reference-menu' : slashMenu ? 'compact-menu' : undefined}
            aria-activedescendant={menuOpen && active ? optionId(active) : undefined}
            aria-autocomplete={commandsEnabled || onStop || skillWorkspaceId || referenceSessions ? 'list' : undefined}
            aria-placeholder={placeholder}
            placeholder={<div className="message-placeholder">{placeholder}</div>}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <div className="composer-actions">
        {(onAddFiles || onPlan || permissionControl || planActive) && <div className="composer-tools">
          {(onAddFiles || onPlan) && <ComposerAddMenu onAddFiles={onAddFiles} onPlan={onPlan && !planActive ? preparePlan : undefined} />}
          {permissionControl}
          {planActive && <Button variant="ghost" size="xs" type="button" className="plan-chip"
            aria-label={t('plan.exit')} title={t('plan.exit')} disabled={!onExitPlan} onClick={() => onExitPlan?.()}>
            Plan <XIcon aria-hidden="true" />
          </Button>}
        </div>}
        <div className="composer-trailing">
          {footerControl}
          {contextMeter}
          <Button className="send-button" size="icon" type="button" aria-label={label}
            title={primaryStops && canAbort && activeRunId ? t('chat.abortShortcut') : label}
            disabled={primaryStops ? !canAbort : !canSubmit}
            onMouseDown={event => { if (document.activeElement === editor.getRootElement()) event.preventDefault() }}
            onClick={primaryStops ? () => { firstEscape.current = undefined; onAbort?.() } : () => submit(editor.read($readDraft))}>
            {primaryStops ? <SquareIcon aria-hidden="true" fill="currentColor" /> : <ArrowUpIcon aria-hidden="true" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
