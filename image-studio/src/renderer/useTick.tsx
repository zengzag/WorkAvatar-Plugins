/** 生成中耗时展示：按 500ms 刷新；仅重渲染耗时文本，不牵连整页 */
import { useEffect, useState } from 'react'

export function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function Elapsed({ startedAt, className }: { startedAt: number; className?: string }) {
  const now = useTick(true)
  return <span className={className}>{formatElapsed(now - startedAt)}</span>
}
