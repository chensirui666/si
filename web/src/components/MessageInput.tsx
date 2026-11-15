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
  HISTORY_PUSH_TAG,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ESCAPE_COMMAND,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  RootNode,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SCROLL_INTO_VIEW_TAG,
} from 'lexical'
import { mergeRegister } from '@lexical/utils'

import type { WorkspaceSkills } from '@agent-learning/server/protocol'
import { getWorkspaceSkills } from '../chat/client'
import { errorNotice, NoticeText, skillSourceKey, type Notice } from '../i18n/messages'
import { Button } from '@/components/ui/button'
import { $styleSkillPrefix, skillPrefix } from './skill-prefix'

type MessageInputProps = {
  onSend: (text: string, restoreDraft: () => void) => boolean
  sendDisabled: boolean
  action?: 'send' | 'abort' | 'aborting'
  abortDisabled?: boolean
  onAbort?: () => void
  contextMeter?: ReactNode
  footerControl?: ReactNode
  commandsEnabled?: boolean
  skillWorkspaceId?: string
  draft?: { text: string }
  onDraftChange?: (text: string) => void
  editorRef?: Ref<HTMLDivElement>
  quote?: string
  onRemoveQuote?: () => void
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
const optionId = (option: string) => option === '/compact' ? 'compact-option' : `skill-option-${option.slice(7).trim()}`

export function MessageInput(props: MessageInputProps) {
  const initialDraft = props.draft?.text
  return (
    <LexicalComposer initialConfig={{ ...initialConfig, editorState: initialDraft ? () => $writeDraft(initialDraft) : undefined }}>
      <Composer {...props} />
    </LexicalComposer>
  )
}

function Composer({ onSend, sendDisabled, action = 'send', abortDisabled = false, onAbort, contextMeter, footerControl, commandsEnabled = true, skillWorkspaceId, draft, onDraftChange, editorRef, quote, onRemoveQuote }: MessageInputProps) {
  const { t } = useTranslation()
  const [editor] = useLexicalComposerContext()
  const [hasSkillPrefix, setHasSkillPrefix] = useState(() => skillPrefix.test(draft?.text ?? ''))
  const [canSend, setCanSend] = useState(Boolean(draft?.text.trim()))
  const draftRevision = useRef(0)
  const [query, setQuery] = useState<string | null>(null)
  const menu = useRef<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [catalog, setCatalog] = useState<{ workspaceId: string; view?: WorkspaceSkills; error?: Notice } | null>(null)
  const loadedCatalog = useRef<string | undefined>(undefined)
  const menuOpen = query !== null
  const skillMenu = menuOpen && Boolean(skillWorkspaceId)
  const currentCatalog = catalog?.workspaceId === skillWorkspaceId ? catalog : null
  const canRunCompact = commandsEnabled && !sendDisabled
  const showCompact = query !== null && canRunCompact && '/compact'.startsWith(query)
  const skillOptions = query === null ? [] : (currentCatalog?.view?.skills ?? []).filter(skill =>
    `/skill:${skill.name}`.startsWith(query) || `/${skill.name}`.startsWith(query))
  const options = [...(showCompact ? ['/compact'] : []), ...skillOptions.map(skill => `/skill:${skill.name} `)]
  const active = options[Math.min(highlight, options.length - 1)]

  const dismissedText = useRef<string | undefined>(undefined)
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
    const available = (canRunCompact && '/compact'.startsWith(prefix)) || Boolean(skillWorkspaceId)
    const visible = available && editor.getRootElement() === document.activeElement && !composingRef.current && !editor.isComposing()
      && /^[ \t]*\/[a-z0-9:-]*$/i.test(text) && atEnd && dismissedText.current !== text
    const next = visible ? prefix : null
    if (menu.current === next) return
    if (next === null) { closeMenu(); return }
    menu.current = next
    setQuery(next)
    setHighlight(0)
  }, [closeMenu, canRunCompact, editor, skillWorkspaceId])
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
  const completeSkill = useCallback((option: string) => {
    editor.update(() => {
      const text = $readDraft()
      dismissedText.current = text.replace(/\/[a-z0-9:-]*$/i, () => option)
      const root = $getRoot()
      root.clear().append($createParagraphNode().append($createTextNode(dismissedText.current)))
      root.selectEnd()
      closeMenu()
    }, { discrete: true, tag: HISTORY_PUSH_TAG })
  }, [closeMenu, editor])
  const label = t(action === 'send' ? 'chat.send' : action === 'abort' ? 'chat.abort' : 'chat.aborting')

  const submit = useCallback((text: string) => {
    let clearedRevision: number | undefined
    const restoreDraft = () => editor.update(() => {
      if (clearedRevision !== draftRevision.current || $readDraft() !== '') return
      $writeDraft(text)
      if (editor.getRootElement() === document.activeElement) $getRoot().selectEnd()
      else $addUpdateTag(SKIP_DOM_SELECTION_TAG)
    }, { discrete: true, tag: SKIP_SCROLL_INTO_VIEW_TAG })

    try {
      if (sendDisabled || !text.trim() || onSend(text, restoreDraft) !== true) return
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
  }, [editor, onSend, sendDisabled])

  const pickOption = useCallback((option: string) => {
    if (option !== '/compact') { completeSkill(option); return }
    const current = editor.getEditorState().read($readDraft).trimStart().toLowerCase()
    // The current menu only replaces a draft consisting entirely of its slash query.
    if (canRunCompact && current === menu.current && option.startsWith(current)) submit(option)
  }, [canRunCompact, completeSkill, editor, submit])

  useEffect(() => editor.registerUpdateListener(({ editorState, prevEditorState, tags }) => {
    const text = editorState.read($readDraft)
    if (text !== prevEditorState.read($readDraft)) {
      draftRevision.current++
      setHasSkillPrefix(skillPrefix.test(text))
      if (!tags.has(restoreTag)) onDraftChange?.(text)
      if (text !== dismissedText.current) dismissedText.current = undefined
    }
    setCanSend(Boolean(text.trim()))
    editorState.read(refreshMenu)
  }), [editor, refreshMenu, onDraftChange])

  useEffect(() => {
    if (draft === undefined || editor.getEditorState().read($readDraft) === draft.text) return
    editor.update(() => {
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
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, move(1), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, move(-1), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ESCAPE_COMMAND, event => {
        if (!menu.current) return false
        event?.preventDefault()
        dismissedText.current = $readDraft()
        closeMenu()
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
        if (event.ctrlKey || event.metaKey || event.altKey || event.getModifierState('AltGraph')) return true
        if (event.shiftKey) return false
        if (composingRef.current || editor.isComposing() || event.isComposing || event.keyCode === 229 || Date.now() < composingUntilRef.current) return true
        event.preventDefault()
        if (!event.repeat) { if (menu.current && active) pickOption(active); else submit($readDraft()) }
        return true
      }, COMMAND_PRIORITY_CRITICAL),
    )
  }, [editor, submit, pickOption, closeMenu, active, options.length])

  useEffect(() => {
    if (active) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const renderOption = (option: string, children: ReactNode) =>
    <Button key={option} variant="ghost" type="button" role="option" aria-selected={active === option}
      id={optionId(option)} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => pickOption(option)}>
      {children}
    </Button>

  return (
    <div className="message-input">
      {quote && <div className="composer-quote" role="group" aria-label={t('chat.quotedText')}>
        <QuoteIcon aria-hidden="true" />
        <div className="composer-quote-text">{quote}</div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('chat.removeQuote')} title={t('chat.removeQuote')} onClick={() => {
          onRemoveQuote?.()
          editor.getRootElement()?.focus({ preventScroll: true })
        }}><XIcon aria-hidden="true" /></Button>
      </div>}
      {menuOpen && <div className="command-menu" role="listbox" aria-label={t('chat.slashMenu')} id="compact-menu">
        {showCompact && <div role="group" aria-label={t('chat.commands')}>
          <div className="command-menu-label">{t('chat.commands')}</div>
          {renderOption('/compact', <><span>/compact</span><span>{t('chat.compactCommand')}</span></>)}
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
            aria-controls={menuOpen ? 'compact-menu' : undefined}
            aria-activedescendant={menuOpen && active ? optionId(active) : undefined}
            aria-autocomplete={commandsEnabled || skillWorkspaceId ? 'list' : undefined}
            aria-placeholder={t('chat.placeholder')}
            placeholder={<div className="message-placeholder">{t('chat.placeholder')}</div>}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <div className="composer-actions">
        {footerControl}
        {contextMeter}
        <Button className="send-button" size="icon" type="button" aria-label={label} title={label}
          disabled={action === 'send' ? sendDisabled || !canSend : action === 'aborting' || abortDisabled || !onAbort}
          onClick={() => { if (action === 'send') submit(editor.read($readDraft)); else if (action === 'abort') onAbort?.() }}>
          {action === 'send' ? <ArrowUpIcon aria-hidden="true" /> : <SquareIcon aria-hidden="true" fill="currentColor" />}
        </Button>
      </div>
    </div>
  )
}
