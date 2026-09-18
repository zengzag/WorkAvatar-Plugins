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
}

export interface WordCanvasModule {
  WordCanvas: new (opts: Record<string, unknown>) => WordCanvasInstance
  darkCanvasTheme?: Record<string, unknown>
}

let modulePromise: Promise<WordCanvasModule> | null = null
let workersPromise: Promise<void> | null = null

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

/** 释放 blob URL（插件卸载时调用） */
export function releaseWorkers(): void {
  const g = globalThis as unknown as Record<string, unknown>
  delete g[WORKER_MAP_KEY]
  workersPromise = null
  modulePromise = null
}
