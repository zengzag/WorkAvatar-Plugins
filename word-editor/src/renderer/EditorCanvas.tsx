// TipTap 编辑器画布：A4 页面式排版、AI 划词改写浮动条、远程内容合并

import { useEffect, useState } from 'react'
import { useEditor, EditorContent, BubbleMenu, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import Image from '@tiptap/extension-image'
import { invoke, hostT } from './store'
import { useWordEditorStore } from './word-editor.store'

const INLINE_ACTIONS: Array<{ key: string; prompt: string }> = [
  { key: 'rewrite', prompt: '请改写这段文字，保持原意但换一种表达。' },
  { key: 'polish', prompt: '请润色这段文字，使其更通顺自然。' },
  { key: 'expand', prompt: '请在不改变原意的前提下扩写这段文字，增加细节。' },
  { key: 'translate', prompt: '请将这段文字翻译为英文。' },
]

interface Props {
  docId: string
  initialHtml: string
  onReady: (handle: { getHtml: () => string; editor: Editor }) => void
  onRemoteHtml: (cb: (html: string, source: string) => void) => void
}

export function EditorCanvas({ docId, initialHtml, onReady, onRemoteHtml }: Props) {
  const updateHtml = useWordEditorStore((s) => s.updateHtml)
  const [inlinePreview, setInlinePreview] = useState<{ result: string } | null>(null)
  const [inlineBusy, setInlineBusy] = useState(false)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color.configure({ types: ['textStyle'] }),
      Highlight.configure({ multicolor: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table.configure({ resizable: true }),
      TableRow, TableCell, TableHeader,
      Image.configure({ inline: false, allowBase64: true }),
    ],
    content: initialHtml,
    onUpdate: () => {
      if (editor) updateHtml(editor.getHTML())
    },
    editorProps: {
      attributes: { class: 'we-prose' },
    },
  })

  // 就绪回执（父级拿到 getHtml 以供自动保存/导出）
  useEffect(() => {
    if (editor) onReady({ getHtml: () => editor.getHTML(), editor })
  }, [editor, onReady])

  // 远程 HTML 应用（AI/快照）
  useEffect(() => {
    if (!editor) return
    onRemoteHtml((html) => {
      editor.commands.setContent(html, false)
    })
  }, [editor])

  // 划词 AI
  const runInline = async (item: { key: string; prompt: string }) => {
    if (!editor) return
    const { from, to } = editor.state.selection
    const selectedText = editor.state.doc.textBetween(from, to, '\n')
    if (!selectedText.trim()) return
    setInlineBusy(true)
    try {
      const res = await invoke<{ text?: string; error?: string }>('inline-edit', {
        instruction: item.prompt,
        text: selectedText,
      })
      if ('error' in res && res.error) {
        throw new Error(res.error)
      } else if ('text' in res && res.text) {
        setInlinePreview({ result: res.text })
      }
    } catch (e) {
      console.warn('[word-editor] inline edit failed:', e instanceof Error ? e.message : e)
    } finally {
      setInlineBusy(false)
    }
  }

  const acceptInline = () => {
    if (inlinePreview && editor) {
      const { from, to } = editor.state.selection
      const lines = inlinePreview.result.split(/\n/)
      let chain = editor.chain().focus()
      const hasSelection = from !== to
      for (let i = 0; i < lines.length; i++) {
        if (hasSelection && i === 0) chain = chain.deleteSelection()
        chain = chain.insertContent(`<p>${lines[i]}</p>`)
      }
      chain.run()
    }
    setInlinePreview(null)
  }

  return (
    <div className="we-canvas-scroll">
      {editor && (
        <BubbleMenu editor={editor} tippyOptions={{ duration: 100 }}>
          <div className="we-bubble">
            {inlinePreview ? (
              <div className="we-inline-preview">
                <div className="we-inline-text">{inlinePreview.result}</div>
                <div className="we-inline-actions">
                  <button className="we-btn we-btn-primary" onClick={acceptInline}>{hostT('inline.accept')}</button>
                  <button className="we-btn" onClick={() => setInlinePreview(null)}>{hostT('inline.reject')}</button>
                </div>
              </div>
            ) : (
              <>
                {INLINE_ACTIONS.map((item) => (
                  <button key={item.key} className="we-btn" disabled={inlineBusy} onClick={() => void runInline(item)}>
                    {hostT(`inline.${item.key}`)}
                  </button>
                ))}
                {inlineBusy && <span className="we-inline-loading">{hostT('inline.generating')}</span>}
              </>
            )}
          </div>
        </BubbleMenu>
      )}
      <div className="we-page">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
