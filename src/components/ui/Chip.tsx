import { forwardRef } from 'react'
import { cn } from '../../utils/cn'
import { Tooltip } from './Tooltip'

export type ChipTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info'
export type ChipSize = 'xs' | 'sm'

const toneStyles: Record<ChipTone, string> = {
  neutral: 'bg-bg-300 text-text-300',
  accent: 'bg-accent-main-100/15 text-accent-main-100',
  success: 'bg-success-100/15 text-success-100',
  danger: 'bg-danger-100/15 text-danger-100',
  warning: 'bg-warning-100/15 text-warning-100',
  info: 'bg-info-100/15 text-info-100',
}

const sizeStyles: Record<ChipSize, string> = {
  xs: 'h-4 px-1 text-ui-xs rounded-xs',
  sm: 'h-5 px-1.5 text-ui-xs rounded-sm',
}

interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone
  size?: ChipSize
}

export const Chip = forwardRef<HTMLSpanElement, ChipProps>(
  ({ tone = 'neutral', size = 'sm', className, title, ...props }, ref) => {
    const chip = (
      <span
        ref={ref}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 font-medium leading-none whitespace-nowrap',
          // shimmer 文本靠 -webkit-text-fill-color: transparent 实现，而该属性**会继承**。
          // 放进扫光容器（如运行中的折叠行 label）时，chip 只设 color 覆盖不了它，
          // 表现为底色还在、文字消失。这里显式恢复为自身文字色。
          '[-webkit-text-fill-color:currentColor]',
          sizeStyles[size],
          toneStyles[tone],
          className,
        )}
        {...props}
      />
    )

    // title 升级为自绘提示:原生 title 无法统一延迟与样式。
    if (!title) return chip
    return <Tooltip content={title}>{chip}</Tooltip>
  },
)
Chip.displayName = 'Chip'
