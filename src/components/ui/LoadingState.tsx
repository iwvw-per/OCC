import { useState } from 'react'
import { useNow } from '../../hooks/useNow'
import { Spinner, type SpinnerSize, type SpinnerVariant } from './Spinner'
import { cn } from '../../utils/cn'

interface LoadingStateProps {
  label?: string
  /** 起始时间戳（ms）。不传则从本组件挂载时刻起算 */
  startedAt?: number
  /** 是否显示已耗时 */
  showElapsed?: boolean
  size?: SpinnerSize
  /** 加载指示器变体，默认 pixel */
  variant?: SpinnerVariant
  /** 竖向排列（大块加载）/ 横向排列（行内加载） */
  layout?: 'row' | 'column'
  className?: string
}

function formatElapsed(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}

export function LoadingState({
  label,
  startedAt,
  showElapsed = true,
  size = 'lg',
  variant = 'pixel',
  layout = 'column',
  className,
}: LoadingStateProps) {
  // 挂载时刻只取一次；与 useNow 的惰性初始化同源，避免在渲染期直接读时钟
  const [mountAt] = useState(() => Date.now())
  const origin = startedAt ?? mountAt

  const now = useNow(200, showElapsed)
  const elapsed = showElapsed ? formatElapsed(Math.max(0, now - origin)) : null

  return (
    <div
      aria-busy="true"
      className={cn('flex items-center gap-3 text-text-400', layout === 'column' ? 'flex-col' : 'flex-row', className)}
    >
      <Spinner size={size} tone="accent" variant={variant} />
      {(label || elapsed) && (
        <span className="flex items-baseline gap-2 text-ui-base">
          {label && <span>{label}</span>}
          {elapsed && <span className="tabular-nums text-text-500 text-ui-caption">{elapsed}</span>}
        </span>
      )}
    </div>
  )
}
