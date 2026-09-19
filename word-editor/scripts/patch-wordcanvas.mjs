// wordcanvas vendor 后处理：改写 Worker 创建与 Worker 内的资源基准 URL。
//
// 背景一：wordcanvas 用 `new Worker(new URL("assets/worker-x.js", import.meta.url), {type:'module'})`
// 加载导入/导出管道。插件渲染端页面来源是 http://localhost(dev) 或 file://(prod)，
// 而脚本位于 plugin://<id>/... —— 跨源，Chromium 拒绝构造 Worker。
// 因此把 Worker URL 改为经全局映射取 blob URL（渲染端加载前预取 worker 源码生成 blob）。
//
// 背景二：导出 worker 内部用 `new URL("./fonts/X.ttf", import.meta.url)` 兜底加载字体。
// blob worker 的 import.meta.url 是 blob: URL，相对解析会失败，故改写为 vendor 的 plugin:// 基准。
// （字体文件已由 manifest.vendor 的第二条拷贝到 assets/fonts/ 供该兜底路径使用。）
//
// worker 文件自身无真实 import（自包含），blob + type:'module' 可正常运行。

import fs from 'node:fs'
import path from 'node:path'

/** vite 产出的 worker 创建表达式（含 @vite-ignore 注释与多行缩进） */
const WORKER_RE =
  /new Worker\(new URL\(\s*\/\* @vite-ignore \*\/\s*"" \+ new URL\("(assets\/worker-[^"]+)",\s*import\.meta\.url\)\.href,\s*import\.meta\.url\s*\),\s*\{ type: "module" \}\)/g

// ====== 系统字体支持（宿主 word-editor 注入 __WE_SYSTEM_*__ 全局后生效） ======

/** 字体族解析（paintStyle 的 En）：在注册表/替换表都未命中时，若族名在宿主注入的
 *  `__WE_SYSTEM_FONTS__` 集合内则原样返回 —— 画布 measure/draw 直接用系统安装字体
 *  （二者都经此解析，宽度与字形一致），不再替换为默认克隆 Arimo。 */
const EN_RESOLVE_SRC = `function En(t) {
  const e = it(t);
  if (e) return { clone: e.family, substituted: !1 };
  const n = t.trim().toLowerCase().replace(/^["']|["']$/g, ""), s = ct[n];
  return s ? { clone: s, substituted: !1 } : { clone: lt, substituted: !0 };
}`
const EN_RESOLVE_DST = `function En(t) {
  const e = it(t);
  if (e) return { clone: e.family, substituted: !1 };
  const n = t.trim().toLowerCase().replace(/^["']|["']$/g, ""), s = ct[n];
  if (s) return { clone: s, substituted: !1 };
  if (globalThis.__WE_SYSTEM_FONTS__?.has(t.trim())) return { clone: t.trim(), substituted: !1 };
  return { clone: lt, substituted: !0 };
}`

/** 字体下拉列表（paintStyle 的 Bn，Ribbon 下拉 / 状态同步 / 浮动格式条菜单共用）：
 *  末尾追加宿主注入的 `__WE_SYSTEM_FONT_LIST__`（{value,label}，宿主已剔除内置克隆覆盖项），
 *  并与内置/自定义条目按族名去重。 */
const FONT_LIST_SRC = `function Bn(t) {
  const e = new Set((t?.disableBuiltin ?? []).map((o) => fe(o).trim().toLowerCase())), n = yt.filter((o) => !e.has(fe(o.value).trim().toLowerCase())), s = (t?.fonts ?? []).filter((o) => ye(o)).map((o) => ({ value: o.family, label: o.label ?? o.family }));
  return [...n, ...s];
}`
const FONT_LIST_DST = `function Bn(t) {
  const e = new Set((t?.disableBuiltin ?? []).map((o) => fe(o).trim().toLowerCase())), n = yt.filter((o) => !e.has(fe(o.value).trim().toLowerCase())), s = (t?.fonts ?? []).filter((o) => ye(o)).map((o) => ({ value: o.family, label: o.label ?? o.family }));
  const w = globalThis.__WE_SYSTEM_FONT_LIST__ ?? [];
  return [...n, ...s, ...w.filter((o) => !n.concat(s).some((p) => fe(p.value).trim().toLowerCase() === fe(o.value).trim().toLowerCase()))];
}`

/**
 * 应用系统字体补丁（仅主线程渲染分块；导出 worker 仍按注册字节渲染，系统字体由
 * PDF/DOCX 导出按既有回退逻辑处理）。
 * @returns 命中的补丁处数
 */
function patchSystemFonts(destDir) {
  let patched = 0
  for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const file = path.join(destDir, entry.name)
    const code = fs.readFileSync(file, 'utf-8')
    let next = code
    if (next.includes(EN_RESOLVE_SRC)) next = next.replaceAll(EN_RESOLVE_SRC, EN_RESOLVE_DST)
    if (next.includes(FONT_LIST_SRC)) next = next.replaceAll(FONT_LIST_SRC, FONT_LIST_DST)
    if (next !== code) {
      fs.writeFileSync(file, next, 'utf-8')
      patched++
    }
  }
  return patched
}

/**
 * @param {string} destDir vendor 目标目录（已拷贝完 dist-lib 内容）
 * @param {{ id: string }} manifest 插件 manifest（用于生成 plugin:// 基准 URL）
 * @returns {{ patched: number, workers: string[] }}
 */
export default function patchWordCanvas(destDir, manifest) {
  const pluginId = manifest?.id
  if (!pluginId) throw new Error('wordcanvas vendor 后处理失败：缺少 manifest.id')

  let patched = 0
  for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const file = path.join(destDir, entry.name)
    const code = fs.readFileSync(file, 'utf-8')
    if (!code.includes('new Worker(')) continue
    const next = code.replace(WORKER_RE, (_full, rel) =>
      `new Worker(globalThis.__WE_WORKER_URL__?.("${rel}") ?? new URL("${rel}", import.meta.url).href, { type: "module" })`)
    if (next !== code) {
      fs.writeFileSync(file, next, 'utf-8')
      patched++
    }
  }

  // Worker 内的资源基准：blob worker 无法用 import.meta.url 解析相对路径
  const assetsDir = path.join(destDir, 'assets')
  const workers = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
    : []
  if (workers.length === 0) {
    throw new Error('wordcanvas vendor 后处理失败：未找到 assets/worker-*.js')
  }
  const baseUrl = `plugin://${pluginId}/vendor/wordcanvas/assets/`
  let workerPatched = 0
  for (const w of workers) {
    const file = path.join(assetsDir, w)
    const code = fs.readFileSync(file, 'utf-8')
    if (!code.includes('import.meta.url')) continue
    const next = code.replaceAll('import.meta.url', JSON.stringify(baseUrl))
    if (next !== code) {
      fs.writeFileSync(file, next, 'utf-8')
      workerPatched++
    }
  }

  // 渲染端据此预取 worker 源码并构造 blob URL
  fs.writeFileSync(
    path.join(destDir, 'worker-manifest.json'),
    JSON.stringify({ workers: workers.map((f) => `assets/${f}`) }, null, 2),
    'utf-8'
  )
  const fontPatched = patchSystemFonts(destDir)
  return { patched: patched + workerPatched + fontPatched, workers }
}
