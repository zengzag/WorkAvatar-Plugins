// wordcanvas 编辑器宿主：加载 vendor 模块、挂载实例、向 store 暴露编辑器桥

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Progress, Result, Spin } from 'antd'
import {
  loadWordCanvas, loadQueryModule, releaseWorkers,
  type WordCanvasInstance, type WordCanvasEditorHandle, type WordCanvasModule,
} from './wordcanvas-loader'
import { installWordCanvasLocalizer } from './wordcanvas-i18n'
import {
  removeInsertMenuBar, applyDirectionIcons, installFloatingLayerClamp,
  applySystemFontGlobals, stackStyleGroupButtons, installResponsiveRibbon,
  PAGE_HIDDEN_CLASS,
  type SystemFontEntry,
} from './wordcanvas-tweaks'
import { BLANK_DOCUMENT_JSON } from '../shared/blank-document'
import { hostT, useAppearance, we } from './store'
import { useWordEditorStore, type EditorBridge, type SelectionInfo } from './word-editor.store'

/** 系统字体列表（进程内缓存；编辑器构造前注入全局供 vendor 补丁消费） */
let systemFontsPromise: Promise<SystemFontEntry[]> | null = null
function loadSystemFonts(): Promise<SystemFontEntry[]> {
  if (!systemFontsPromise) {
    systemFontsPromise = we
      .listSystemFonts()
      .then((res) => res.fonts ?? [])
      .catch(() => [])
  }
  return systemFontsPromise
}

interface Props {
  /** 初始文档数据（Document JSON；空串表示空白文档）。仅首次挂载时使用，后续切换文档走 remoteData 回调 */
  initialData: string
  /** 就绪回执：注册编辑器桥（store 经此读写文档） */
  onReady: (bridge: EditorBridge) => void
  /** 注册远程数据应用回调（切换文档、快照恢复等） */
  onRemoteData: (cb: (data: string) => void) => void
  /** 编辑器工具栏导出按钮回调（Blob 交调用方落盘） */
  onToolbarExport: (bytes: Uint8Array, format: 'docx' | 'pdf') => void
}

/** 变更签名：blocks 数 + 各块 revision 与 runs 数之和（wordcanvas 每个变更递增 revision） */
function signatureOf(doc: unknown): string {
  const blocks = (doc as { blocks?: Array<{ revision?: number; runs?: unknown[] }> } | null)?.blocks
  if (!Array.isArray(blocks)) return '0'
  let acc = 0
  for (const b of blocks) {
    acc += (b?.revision ?? 0) + (Array.isArray(b?.runs) ? b.runs.length : 0)
  }
  return `${blocks.length}:${acc}`
}

/** 安全解析文档 JSON；失败返回 null（保留编辑器当前内容） */
function parseDocument(data: string): unknown | null {
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch (e) {
    console.warn('[word-editor] 文档数据解析失败:', e)
    return null
  }
}

export function WordCanvasHost({ initialData, onReady, onRemoteData, onToolbarExport }: Props) {
  const { isDark, locale } = useAppearance()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const instanceRef = useRef<WordCanvasInstance | null>(null)
  const editorRef = useRef<WordCanvasEditorHandle | null>(null)
  const onReadyRef = useRef(onReady)
  const onRemoteRef = useRef(onRemoteData)
  const onExportRef = useRef(onToolbarExport)
  const initDataRef = useRef(initialData)
  /** 最近一次编辑器内容：主题切换会重建实例，用它在重建后恢复内容（含未保存改动） */
  const liveDataRef = useRef<string | null>(null)
  /** 未就绪期间收到远程数据（切文档/恢复快照）时暂存，就绪后应用 */
  const pendingDataRef = useRef<string | null>(null)
  const themeRef = useRef(isDark)

  const [loading, setLoading] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  onReadyRef.current = onReady
  onRemoteRef.current = onRemoteData
  onExportRef.current = onToolbarExport
  // wordcanvas 只支持构造期传入 theme，故主题变化通过下方依赖触发实例重建
  themeRef.current = isDark

  const getData = useCallback((): string => {
    const doc = editorRef.current?.getDocument()
    return doc ? JSON.stringify(doc) : ''
  }, [])

  const getSignature = useCallback((): string => signatureOf(editorRef.current?.getDocument()), [])

  const setDocument = useCallback((next: string): void => {
    const handle = editorRef.current
    if (!handle || !next) {
      pendingDataRef.current = next || null
      return
    }
    const parsed = parseDocument(next)
    if (parsed === null) return
    liveDataRef.current = next
    handle.setDocument(parsed)
  }, [])

  const openDocx = useCallback(async (bytes: Uint8Array): Promise<void> => {
    const handle = editorRef.current
    if (!handle) throw new Error(hostT('page.editorNotReady'))
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    await handle.openDocx(buf)
  }, [])

  const exportBytes = useCallback(async (format: 'docx' | 'pdf'): Promise<Uint8Array> => {
    const handle = editorRef.current
    if (!handle) throw new Error(hostT('page.editorNotReady'))
    const blob = format === 'pdf' ? await handle.exportPdf() : await handle.exportDocx()
    return new Uint8Array(await blob.arrayBuffer())
  }, [])

  // 读取当前选区：getSelection 在编辑器未聚焦时返回 null，故调用方在 mouseup/keyup
  // 当下读取并缓存；选区文本由 query 模块的 rangeText 从模型计算（canvas 渲染无 DOM 选区）
  const getSelectionInfo = useCallback(async (): Promise<SelectionInfo | null> => {
    const handle = editorRef.current
    if (!handle) return null
    const sel = handle.getSelection()
    if (!sel) return null
    const doc = handle.getDocument()
    try {
      const mod = await loadQueryModule()
      const ranged = sel.anchor.blockId !== sel.focus.blockId || sel.anchor.offset !== sel.focus.offset
      const text = ranged ? mod.rangeText(doc, sel) : ''
      const anchorBlock = mod.getParagraphs(doc).find((p) => p.id === sel.anchor.blockId)
      const blockPreview = anchorBlock ? mod.textOf(anchorBlock).slice(0, 80) : ''
      return { text, anchor: sel.anchor, focus: sel.focus, blockPreview }
    } catch {
      return null
    }
  }, [])

  // 远程数据应用（切换文档、快照恢复等）
  useEffect(() => {
    onRemoteRef.current((next) => setDocument(next))
  }, [setDocument])

  // 挂载 wordcanvas（主题变化时重建实例；切换文档由调用方走 remoteData 回调 setDocument）
  useEffect(() => {
    let disposed = false
    const container = containerRef.current
    if (!container) return

    setReady(false)
    setError(null)
    setLoading(0)

    void (async () => {
      let mod: WordCanvasModule
      try {
        const [m, fonts] = await Promise.all([loadWordCanvas(), loadSystemFonts()])
        // 必须在构造编辑器前注入：字体下拉构建、画布族名解析都读这两个全局
        applySystemFontGlobals(fonts)
        mod = m
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
        return
      }
      if (disposed) return

      try {
        const instance = new mod.WordCanvas({
          container,
          // 纯离线编辑器：不传 backendUrl（无协作/发布/分享）
          theme: themeRef.current ? mod.darkCanvasTheme : undefined,
          onLoadProgress: (p: { percent?: number }) => {
            if (!disposed && typeof p?.percent === 'number') setLoading(p.percent)
          },
          onSave: (evt: { blob?: Blob; format?: string }) => {
            void (async () => {
              if (!evt?.blob) return
              const format = evt.format === 'pdf' ? 'pdf' : 'docx'
              onExportRef.current(new Uint8Array(await evt.blob.arrayBuffer()), format)
            })()
          },
        })
        instanceRef.current = instance

        const handle = await instance.whenReady()
        if (disposed) {
          instance.destroy()
          return
        }
        editorRef.current = handle

        // 预置文档：无文档时用空白文档，避免编辑器载入上游内置演示文档
        const initial = pendingDataRef.current ?? liveDataRef.current ?? initDataRef.current ?? BLANK_DOCUMENT_JSON
        pendingDataRef.current = null
        const parsed = parseDocument(initial)
        if (parsed !== null) handle.setDocument(parsed)

        setReady(true)
        setLoading(1)
        onReadyRef.current({
          getData, getSignature, setDocument, openDocx,
          exportDocx: () => exportBytes('docx'),
          exportPdf: () => exportBytes('pdf'),
          getSelectionInfo,
        })
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      // 重建前留存当前内容（含未保存改动），销毁后由下一次挂载恢复
      if (editorRef.current) {
        try {
          const doc = editorRef.current.getDocument()
          if (doc) liveDataRef.current = JSON.stringify(doc)
        } catch { /* ignore */ }
      }
      editorRef.current = null
      try {
        instanceRef.current?.destroy()
      } catch { /* ignore */ }
      instanceRef.current = null
    }
  }, [getData, getSignature, setDocument, openDocx, exportBytes, retryNonce, isDark])

  // 编辑器就绪后：去掉空白段落上的「＋ 插入」浮条、把方向按钮换成图标、样式组操作按钮竖排，
  // 再安装弹层视口钳制与 UI 本地化
  // （图标替换需在本地化之前，按面部原文 LTR/RTL 命中；宽度自适应需在本地化之后，
  //   使布局量测基于本地化后的文案宽度）
  useEffect(() => {
    if (!ready) return
    removeInsertMenuBar()
    applyDirectionIcons()
    stackStyleGroupButtons()
    const stopClamp = installFloatingLayerClamp()
    const container = containerRef.current
    const stopLocalize = container ? installWordCanvasLocalizer(container, locale) : () => {}
    const stopResponsive = container ? installResponsiveRibbon(container, hostT('page.toolbarMore')) : () => {}
    return () => {
      stopClamp()
      stopLocalize()
      stopResponsive()
    }
  }, [ready, locale])

  // 宿主 KeepAlive 用 display:none 隐藏非活动页，而 wordcanvas 的浮动工具条/弹层挂在
  // document.body 上且 position:fixed —— 不处理会残留显示在其他页面上层（如任务页）。
  // 这里用 IntersectionObserver 感知插件页可见性，打 html 类交由 CSS 统一收起/恢复
  // （不触碰上游内联状态，切回页面后上游按原状态继续管理）。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting)
      document.documentElement.classList.toggle(PAGE_HIDDEN_CLASS, !visible)
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      document.documentElement.classList.remove(PAGE_HIDDEN_CLASS)
    }
  }, [])

  // 划词 AI：wordcanvas 是 canvas 渲染（无 DOM selectionchange），在鼠标选择 / 键盘
  // Shift 选择结束后防抖读取一次选区，缓存进 store 供 AI 面板「选中即改」使用。
  // 焦点离开画布（如点击侧栏）时 getSelection 返回 null，监听器不覆盖缓存，保留最后选区。
  useEffect(() => {
    if (!ready) return
    const el = containerRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onSelect = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void getSelectionInfo().then((info) => {
          if (info) useWordEditorStore.getState().setLastSelection(info)
        })
      }, 120)
    }
    el.addEventListener('mouseup', onSelect)
    el.addEventListener('keyup', onSelect)
    return () => {
      el.removeEventListener('mouseup', onSelect)
      el.removeEventListener('keyup', onSelect)
      if (timer) clearTimeout(timer)
    }
  }, [ready, getSelectionInfo])

  // 插件卸载时释放 worker blob
  useEffect(() => () => releaseWorkers(), [])

  return (
    <div className="we-host">
      {!ready && !error && (
        <div className="we-host-loading">
          <Spin />
          <div className="we-host-loading-text">
            {hostT('page.loadingEditor')}
            {loading > 0 && loading < 1 ? ` ${Math.round(loading * 100)}%` : ''}
          </div>
          {loading > 0 && loading < 1 && (
            <Progress percent={Math.round(loading * 100)} showInfo={false} style={{ width: 220 }} />
          )}
        </div>
      )}
      {error && (
        <Result
          status="warning"
          title={hostT('page.editorLoadFailed')}
          subTitle={error}
          extra={<Button type="primary" onClick={() => setRetryNonce((n) => n + 1)}>{hostT('page.retry')}</Button>}
        />
      )}
      <div ref={containerRef} className="we-host-container" />
    </div>
  )
}
