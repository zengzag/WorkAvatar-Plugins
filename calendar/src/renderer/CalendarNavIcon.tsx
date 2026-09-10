/**
 * 导航栏日历图标（与 manifest.nav.icon 一致的 SVG），存在逾期待办时叠加红色角标。
 * - 挂载时拉取 todo-stats，订阅 data-changed(todo) 实时刷新
 * - 逾期随时间推移不断产生，每分钟兜底轮询一次
 */
import { useEffect, useState } from 'react'
import { cal } from './store'
import type { CalendarTodoStats } from './types'

const NAV_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5"/><path d="M1.5 6h13"/><path d="M5 1.5v3M11 1.5v3"/></svg>'

const REFRESH_INTERVAL_MS = 60_000

export function CalendarNavIcon(_props: { active: boolean }) {
  const [overdue, setOverdue] = useState(0)

  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      try {
        const result = await cal.todoStats()
        if (!disposed && result && !result.error) {
          setOverdue((result as CalendarTodoStats).overdue)
        }
      } catch {
        // 统计失败保持角标上次状态
      }
    }
    refresh()
    const unsubscribe = cal.onDataChanged((payload) => {
      if (payload.scope === 'todo') refresh()
    })
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => {
      disposed = true
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [])

  const icon = (
    <span style={{ display: 'inline-flex', width: 16, height: 16 }} dangerouslySetInnerHTML={{ __html: NAV_ICON_SVG }} />
  )

  if (overdue <= 0) return icon
  // 自定义角标：flex 居中保证数字完全居中，淡描边 + 小字号，>9 显示 "..."
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      {icon}
      <span
        style={{
          position: 'absolute',
          top: -4,
          right: -6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 12,
          height: 12,
          padding: '0 2px',
          boxSizing: 'border-box',
          borderRadius: 6,
          background: '#ff4d4f',
          color: '#fff',
          fontSize: 9,
          lineHeight: 1,
          fontWeight: 600,
          border: '1px solid rgba(255,255,255,0.5)',
        }}
      >
        {overdue > 9 ? '...' : overdue}
      </span>
    </span>
  )
}