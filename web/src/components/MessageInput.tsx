import { useCallback, useEffect, useRef, useState } from 'react'
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
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
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

function Composer({ onSend, sendDisabled, action = 'send', abortDisabled = false, onAbort }: MessageInputProps) {
  const [editor] = useLexicalComposerContext()
  const [canSend, setCanSend] = useState(false)
  const draftRevision = useRef(0)
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
    if (text !== prevEditorState.read($readDraft)) draftRevision.current++
    setCanSend(Boolean(text.trim()))
  }), [editor])

  useEffect(() => {
    let composing = false
    let composingUntil = 0
    const startComposition = () => { composing = true }
    const endComposition = () => {
      composing = false
      // Safari can report the confirming Enter just after compositionend.
      composingUntil = Date.now() + 10
    }

    return mergeRegister(
      editor.registerRootListener((root, previous) => {
        previous?.removeEventListener('compositionstart', startComposition)
        previous?.removeEventListener('compositionend', endComposition)
        composing = false
        composingUntil = 0
        root?.addEventListener('compositionstart', startComposition)
        root?.addEventListener('compositionend', endComposition)
      }),
      editor.registerCommand(KEY_TAB_COMMAND, () => {
        // 原生 Tab 移焦后，避免本次内部选区提交重新抢回输入焦点。
        $addUpdateTag(SKIP_DOM_SELECTION_TAG)
        return false
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
        if (event === null) return true
        if (event.ctrlKey || event.metaKey || event.altKey || event.getModifierState('AltGraph')) return true
        if (event.shiftKey) return false
        if (composing || editor.isComposing() || event.isComposing || event.keyCode === 229 || Date.now() < composingUntil) return true
        event.preventDefault()
        if (!event.repeat) submit($readDraft())
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      () => {
        const root = editor.getRootElement()
        root?.removeEventListener('compositionstart', startComposition)
        root?.removeEventListener('compositionend', endComposition)
      },
    )
  }, [editor, submit])

  return (
    <div className="message-input">
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className="message-editor"
            role="textbox"
            aria-label="消息"
            aria-multiline="true"
            aria-placeholder="输入消息…"
            placeholder={<div className="message-placeholder">输入消息…</div>}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <div className="composer-actions">
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
