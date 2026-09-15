// 主进程数模镜像会话：持有当前模型，应用工具并广播变更

import * as path from 'path'
import * as fs from 'fs'
import type { PluginContext } from '@workavatar/plugin-sdk'
import type { DataModel } from '../shared/domain'
import { getToolByName, type ToolResult } from '../shared/model-tools'
import { importDbml } from './dbml-service'

export interface ModelChangedPayload {
  model: DataModel
  /** undefined: 不改动 filePath；null: 重置为未保存 */
  filePath?: string | null
}

let taskRootDirResolver: (() => string) | null = null

/**
 * 文件读写安全边界：agent 工具（import_dbml_file/import_model_file/export_model_file）
 * 的 path 参数由 LLM 生成，若不校验可读写磁盘任意路径。统一收敛到任务根目录内。
 */
function resolveWithinTaskRoot(p: unknown): string {
  const raw = typeof p === 'string' ? p.trim() : ''
  if (!raw) throw new Error('缺少文件路径')
  // 依赖注入 taskRootDir（由插件入口 init 时设置），避免循环 require
  if (!taskRootDirResolver) throw new Error('ModelSession 未初始化')
  const root = path.resolve(taskRootDirResolver())
  const target = path.resolve(raw)
  const rel = path.relative(root, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径不在任务工作区内，已拒绝访问: ${raw}`)
  }
  return target
}

class ModelSession {
  private current: DataModel | null = null
  private currentFilePath: string | null = null
  private ctx: PluginContext | null = null

  init(ctx: PluginContext): void {
    this.ctx = ctx
  }

  /** 由插件入口注入任务根目录解析（index.ts 的 taskRootDir），用于文件读写边界校验 */
  setTaskRootResolver(resolver: () => string): void {
    taskRootDirResolver = resolver
  }

  setModel(model: DataModel | null, filePath?: string | null): void {
    this.current = model ? clone(model) : null
    if (filePath !== undefined) this.currentFilePath = filePath
  }

  getModel(): DataModel | null {
    return this.current ? clone(this.current) : null
  }

  getFilePath(): string | null {
    return this.currentFilePath
  }

  applyTool(name: string, args: unknown): { result: ToolResult } {
    const tool = getToolByName(name)
    if (!tool) return { result: { ok: false, error: `未知工具: ${name}` } }
    if (!this.current) {
      return { result: { ok: false, error: '当前无数据模型（请先新建或打开项目）' } }
    }
    try {
      const { model, result } = tool.execute(this.current, args, {
        parseDbml: (dbml, n) => importDbml(dbml, n ?? this.ctx.services.i18n.t('defaults.dbmlImportName')),
        readFile: (p) => fs.readFileSync(resolveWithinTaskRoot(p), 'utf-8'),
        writeFile: (p, content) => fs.writeFileSync(resolveWithinTaskRoot(p), content, 'utf-8')
      })
      this.current = model
      this.broadcast()
      return { result }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { result: { ok: false, error: `工具执行异常: ${msg}` } }
    }
  }

  private broadcast(filePath?: string | null): void {
    if (!this.current || !this.ctx) return
    const payload: ModelChangedPayload = filePath === undefined ? { model: this.current } : { model: this.current, filePath }
    this.ctx.ipc.broadcast('model-changed', payload)
  }
}

function clone<T>(m: T): T {
  return JSON.parse(JSON.stringify(m)) as T
}

export const modelSession = new ModelSession()
