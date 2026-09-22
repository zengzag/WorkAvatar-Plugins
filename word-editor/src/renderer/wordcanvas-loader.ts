// wordcanvas 加载器：从 vendor（plugin://）动态加载 + Worker blob 注入。
//
// 为什么要绕这一圈：
// 1. wordcanvas 是 code-split 的 ESM 产物（含 18MB 字体 chunk 与两个 Worker），
//    无法用 esbuild 单文件 bundle —— 故由 manifest.vendor 原样拷入 vendor/wordcanvas。
// 2. 它用 `new Worker(new URL("assets/worker-x.js", import.meta.url))` 起导入/导出管道。
//    渲染端页面来源是 http://localhost(dev) / file://(prod)，与 plugin:// 跨源，
//    Chromium 拒绝构造该 Worker —— 故构建期把 URL 改为全局映射，运行时在此预取
//    worker 源码并生成 blob URL 注入。

const PLUGIN_ID = 'word-editor'
const VENDOR_BASE = `plugin://${PLUGIN_ID}/vendor/wordcanvas/`
const WORKER_MAP_KEY = '__WE_WORKER_URL__'

/** WordCanvas 实例（仅声明本插件用到的成员） */
export interface WordCanvasInstance {
  whenReady(): Promise<WordCanvasEditorHandle>
  destroy(): void
}

/** 就绪后的编辑器句柄（仅声明本插件用到的成员） */
export interface WordCanvasEditorHandle {
  getDocument(): unknown
  setDocument(doc: unknown): void
  openDocx(file: File | ArrayBuffer): Promise<void>
  exportDocx(): Promise<Blob>
  exportPdf(): Promise<Blob>
  /** 当前选区/光标；编辑器未聚焦时返回 null */
  getSelection(): DocSelection | null
  /** 在光标处插入纯文本（有选区时替换选区） */
  insertText(text: string): void
}

/** 文档内位置（offset 为块拼接 run 文本的 UTF-16 偏移） */
export interface DocPosition {
  blockId: string
  offset: number
}

/** 选区：anchor === focus 为收拢的光标 */
export interface DocSelection {
  anchor: DocPosition
  focus: DocPosition
  goalX?: number
}

export interface WordCanvasModule {
  WordCanvas: new (opts: Record<string, unknown>) => WordCanvasInstance
  darkCanvasTheme?: Record<string, unknown>
}

// ====== headless 文档编辑引擎（vendor query.js）======
// AI 文档操作不改走 DOM，而是用编辑器自带的 headless 编辑引擎计算 Document 变更，
// 保证产出的文档结构与渲染结果一致。

export interface DocRunStyle {
  [key: string]: unknown
}

export interface DocRun {
  text: string
  style?: DocRunStyle
}

export interface DocBlock {
  kind: string
  id: string
  revision?: number
  runs?: DocRun[]
  style?: Record<string, unknown>
  rows?: Array<{ cells: Array<{ id: string; blocks: DocBlock[] }> }>
}

export interface DocParagraph extends DocBlock {
  kind: 'paragraph'
  runs: DocRun[]
  style: Record<string, unknown>
}

export interface DocStyle {
  id: string
  name: string
  basedOn?: string
  char?: DocRunStyle
  para?: Record<string, unknown>
}

export interface DocStylesheet {
  defaultStyleId?: string
  styles: DocStyle[]
}

export interface DocDocument {
  section?: Record<string, unknown>
  blocks: DocBlock[]
  stylesheet?: DocStylesheet
  [key: string]: unknown
}

/** headless 文档编辑器（query.js 的 DocumentEditor，仅声明本插件用到的成员） */
export interface DocEditor {
  doc: DocDocument
  readonly lastInsertedId: string | null
  getParagraph(id: string): DocParagraph | undefined
  setParagraphText(blockId: string, text: string, style?: DocRunStyle): DocEditor
  replaceText(blockId: string, start: number, end: number, text: string): DocEditor
  setParagraphStyle(blockId: string, patch: Record<string, unknown>): DocEditor
  removeBlock(blockId: string): DocEditor
  insertParagraph(
    referenceId: string,
    text: string,
    options?: { position?: 'before' | 'after'; style?: Record<string, unknown>; runStyle?: DocRunStyle }
  ): DocEditor
  moveBlock(blockId: string, toIndex: number): DocEditor
  replaceAllText(search: string, replace: string): DocEditor
  setStyleByName(blockId: string, styleName: string): DocEditor
  commit(ops: Array<Record<string, unknown>>): DocEditor
}

export interface DocQueryModule {
  DocumentEditor: new (doc: unknown) => DocEditor
  getParagraphs(doc: unknown): DocParagraph[]
  textOf(block: unknown): string
  /** 选区覆盖的文本（单块切片；跨顶层块选区以换行拼接） */
  rangeText(doc: unknown, selection: DocSelection): string
}

let modulePromise: Promise<WordCanvasModule> | null = null
let workersPromise: Promise<void> | null = null
let queryPromise: Promise<DocQueryModule> | null = null

/** 预取 Worker 源码并注入 blob URL 映射（导入/导出管道依赖；失败不阻塞编辑器本体） */
export function prepareWorkers(): Promise<void> {
  if (!workersPromise) workersPromise = doPrepareWorkers()
  return workersPromise
}

async function doPrepareWorkers(): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>
  if (typeof g[WORKER_MAP_KEY] === 'function') return
  const manifestRes = await fetch(`${VENDOR_BASE}worker-manifest.json`)
  if (!manifestRes.ok) throw new Error(`加载 wordcanvas worker 清单失败: ${manifestRes.status}`)
  const { workers } = (await manifestRes.json()) as { workers: string[] }
  const map: Record<string, string> = {}
  await Promise.all(workers.map(async (rel) => {
    const res = await fetch(VENDOR_BASE + rel)
    if (!res.ok) throw new Error(`加载 wordcanvas worker 失败: ${rel} (${res.status})`)
    const code = await res.text()
    map[rel] = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  }))
  g[WORKER_MAP_KEY] = (rel: string) => map[rel]
}

/** 加载 wordcanvas 模块（单例 Promise） */
export function loadWordCanvas(): Promise<WordCanvasModule> {
  if (!modulePromise) modulePromise = doLoad()
  return modulePromise
}

async function doLoad(): Promise<WordCanvasModule> {
  await prepareWorkers()
  return (await import(/* @vite-ignore */ `${VENDOR_BASE}wordcanvas.js`)) as WordCanvasModule
}

/** 加载 headless 文档编辑引擎（单例 Promise；与编辑器同源 vendor 分块） */
export function loadQueryModule(): Promise<DocQueryModule> {
  if (!queryPromise) queryPromise = doLoadQuery()
  return queryPromise
}

async function doLoadQuery(): Promise<DocQueryModule> {
  // query 分块自身不建 Worker，但其依赖的排版分块会引用 Worker URL 全局映射
  await prepareWorkers()
  return (await import(/* @vite-ignore */ `${VENDOR_BASE}query.js`)) as DocQueryModule
}

/** 释放 blob URL（插件卸载时调用） */
export function releaseWorkers(): void {
  const g = globalThis as unknown as Record<string, unknown>
  delete g[WORKER_MAP_KEY]
  workersPromise = null
  modulePromise = null
  queryPromise = null
}
