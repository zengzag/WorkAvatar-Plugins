/**
 * 宿主工具目录缓存：把工具英文 id（如 file_write）解析为中文显示名与分组图标，
 * 与宿主普通任务的工具段同源同文案（listBuiltin / getCategories）。
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ToolOutlined, FileOutlined, DatabaseOutlined, CalendarOutlined, RobotOutlined, GlobalOutlined, SettingOutlined, FileTextOutlined, MessageOutlined, BulbOutlined, CodeOutlined, TeamOutlined } from '@ant-design/icons'

interface CatalogEntry {
  title: string
  pluginId?: string
  icon?: string
}

const catalogByName = new Map<string, CatalogEntry>()
let loading: Promise<void> | null = null

/** 分组 icon 键 → 图标（与宿主 tool-category-icons 同映射） */
const ICON_MAP: Record<string, ReactNode> = {
  file: <FileOutlined />,
  database: <DatabaseOutlined />,
  calendar: <CalendarOutlined />,
  robot: <RobotOutlined />,
  global: <GlobalOutlined />,
  setting: <SettingOutlined />,
  'file-document': <FileTextOutlined />,
  message: <MessageOutlined />,
  tool: <BulbOutlined />,
  code: <CodeOutlined />,
  plugin: <ToolOutlined />,
  team: <TeamOutlined />,
}

async function loadCatalog(): Promise<void> {
  if (loading) return loading
  loading = (async () => {
    try {
      const api = (window as { electronAPI?: { tool?: { listBuiltin?: () => Promise<Array<{ name: string; title: string; pluginId?: string }>>; getCategories?: () => Promise<Array<{ icon: string; tool_ids: string[] }>> } } }).electronAPI
      const tools = (await api?.tool?.listBuiltin?.()) || []
      for (const t of tools) catalogByName.set(t.name, { title: t.title, pluginId: t.pluginId })
      const iconByName = new Map<string, string>()
      const categories = (await api?.tool?.getCategories?.()) || []
      for (const cat of categories) {
        for (const toolId of cat.tool_ids || []) iconByName.set(toolId, cat.icon)
      }
      for (const [name, entry] of catalogByName) {
        entry.icon = iconByName.get(name)
      }
    } catch {
      /* 目录不可达时回退工具原名 */
    }
  })()
  return loading
}

/** 工具显示名：宿主 title（插件命名空间由宿主 i18n 解析过 title）→ 原名 */
export function resolveToolTitle(name: string): string {
  const entry = catalogByName.get(name)
  return entry?.title || name
}

/** 工具分组图标；无命中回退通用扳手 */
export function resolveToolIcon(name: string): ReactNode {
  const entry = catalogByName.get(name)
  const key = entry?.icon
  const icon = key ? ICON_MAP[key] : undefined
  return icon ?? <ToolOutlined />
}

export function useToolCatalog(): void {
  const [, force] = useState(0)
  useEffect(() => {
    void loadCatalog().then(() => force(v => v + 1))
  }, [])
}
