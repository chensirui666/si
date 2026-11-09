import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
  KEY_ESCAPE_COMMAND,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SCROLL_INTO_VIEW_TAG,
} from 'lexical'
import { mergeRegister } from '@lexical/utils'

import { Button } from '@/components/ui/button'

type MessageInputProps = {
  onSend: (text: string, restoreDraft: () => void) => boolean
  sendDisabled: boolean
  action?: 'send' | 'abort' | 'aborting'
  abortDisabled?: boolean
  onAbort?: () => void
  contextMeter?: ReactNode
}

const initialConfig = {
  namespace: 'message-input',
  onError: (error: Error) => { throw error },
}

function $readDraft() {
  return $getRoot().getChildren().map((paragraph) => paragraph.getTextContent()).join('\n')
}

export function MessageInput(props: MessageInputProps) {
  return (
    <LexicalComposer initialConfig={initialConfig}>
      <Composer {...props} />
    </LexicalComposer>
  )
}

function Composer({ onSend, sendDisabled, action = 'send', abortDisabled = false, onAbort, contextMeter }: MessageInputProps) {
  const [editor] = useLexicalComposerContext()
  const [canSend, setCanSend] = useState(false)
  const draftRevision = useRef(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const menu = useRef(false)
  const dismissedText = useRef<string | undefined>(undefined)
  const composingRef = useRef(false)
  const composingUntilRef = useRef(0)
  const closeMenu = useCallback(() => {
    menu.current = false
    setMenuOpen(false)
  }, [])
  const refreshMenu = useCallback(() => {
    const text = $readDraft()
    const selection = $getSelection()
    const atEnd = $isRangeSelection(selection) && selection.isCollapsed()
      && selection.anchor.getNode() === $getRoot().getLastDescendant()
      && selection.anchor.offset === selection.anchor.getNode().getTextContentSize()
    const visible = editor.getRootElement() === document.activeElement && !composingRef.current && !editor.isComposing()
      && /^[ \t]*\/[a-z]*$/.test(text) && '/compact'.startsWith(text.trimStart()) && atEnd && dismissedText.current !== text
    menu.current = visible
    setMenuOpen(visible)
  }, [editor])
  const complete = useCallback(() => {
    editor.update(() => {
      const text = $readDraft()
      dismissedText.current = text.replace(/\/[a-z]*$/, '/compact')
      const root = $getRoot()
      root.clear().append($createParagraphNode().append($createTextNode(dismissedText.current)))
      root.selectEnd()
      closeMenu()
    }, { discrete: true, tag: HISTORY_PUSH_TAG })
  }, [closeMenu, editor])
  const label = action === 'send' ? '发送' : action === 'abort' ? '中止' : '正在中止'

  const submit = useCallback((text: string) => {
    let clearedRevision: number | undefined
    const restoreDraft = () => editor.update(() => {
      if (clearedRevision !== draftRevision.current || $readDraft() !== '') return
      const root = $getRoot()
      root.clear()
      for (const line of text.split('\n')) {
        const paragraph = $createParagraphNode()
        if (line) paragraph.append($createTextNode(line))
        root.append(paragraph)
      }
      if (editor.getRootElement() === document.activeElement) root.selectEnd()
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

  useEffect(() => editor.registerUpdateListener(({ editorState, prevEditorState }) => {
    const text = editorState.read($readDraft)
    if (text !== prevEditorState.read($readDraft)) {
      draftRevision.current++
      if (text !== dismissedText.current) dismissedText.current = undefined
    }
    setCanSend(Boolean(text.trim()))
    editorState.read(refreshMenu)
  }), [editor, refreshMenu])

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
      editor.registerCommand(KEY_ESCAPE_COMMAND, event => {
        if (!menu.current) return false
        event?.preventDefault()
        dismissedText.current = $readDraft()
        closeMenu()
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_TAB_COMMAND, event => {
        if (composingRef.current || editor.isComposing() || event.isComposing || event.keyCode === 229 || Date.now() < composingUntilRef.current) return true
        if (!event.shiftKey && menu.current) {
          event.preventDefault()
          complete()
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
        if (!event.repeat) { if (menu.current) complete(); else submit($readDraft()) }
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      () => {
        const root = editor.getRootElement()
        root?.removeEventListener('compositionstart', startComposition)
        root?.removeEventListener('compositionend', endComposition)
        root?.removeEventListener('blur', blur)
      },
    )
  }, [editor, submit, complete, closeMenu])

  return (
    <div className="message-input">
      {menuOpen && <div className="command-menu" role="listbox" aria-label="命令" id="compact-menu">
        <div className="command-menu-label">命令</div>
        <button type="button" role="option" aria-selected="true" id="compact-option" onMouseDown={event => event.preventDefault()} onClick={complete}>
          <span>/compact</span><span>压缩较早的对话内容</span>
        </button>
      </div>}
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className="message-editor"
            role="textbox"
            aria-label="消息"
            aria-multiline="true"
            aria-controls={menuOpen ? 'compact-menu' : undefined}
            aria-activedescendant={menuOpen ? 'compact-option' : undefined}
            aria-autocomplete="list"
            aria-placeholder="输入消息…"
            placeholder={<div className="message-placeholder">输入消息…</div>}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <div className="composer-actions">
        {contextMeter}
        <Button className="send-button" size="icon" type="button" aria-label={label} title={label}
          disabled={action === 'send' ? sendDisabled || !canSend : action === 'aborting' || abortDisabled || !onAbort}
          onClick={() => { if (action === 'send') submit(editor.read($readDraft)); else if (action === 'abort') onAbort?.() }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            {action === 'send' ? <path d="M8 13V3M3 8l5-5 5 5" /> : <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />}
          </svg>
        </Button>
      </div>
    </div>
  )
}
