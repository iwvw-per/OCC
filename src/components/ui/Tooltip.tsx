import { forwardRef, type ReactNode } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '../../utils/cn'

/**
 * Tooltip - 悬浮提示
 *
 * 基于 Radix Tooltip：自带延迟、碰撞避让与 aria-describedby。
 * 应用根需包一层 TooltipProvider（App 已接入，见 TooltipProvider 导出）。
 */
export const TooltipProvider = TooltipPrimitive.Provider
export const TooltipRoot = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-[300] max-w-[min(320px,80vw)] rounded-lg border border-border-200/60 glass px-2 py-1',
        'text-ui-sm leading-relaxed text-text-100 shadow-lg',
        // 开合动画由 index.css 的 .overlay-surface 驱动。
        'overlay-surface',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = 'TooltipContent'

export interface TooltipProps {
  /** 提示内容。为空时直接渲染 children，不创建 Tooltip 结构。 */
  content?: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delayDuration?: number
  className?: string
}

/**
 * Tooltip - 组合式便捷封装：传 content 即用。
 * 这是日常使用的主要入口，避免每个调用点重复拼装 Trigger/Content。
 */
export function Tooltip({ content, children, side = 'top', align = 'center', delayDuration = 300, className }: TooltipProps) {
  if (!content) return <>{children}</>
  return (
    <TooltipRoot delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align} className={className}>
        {content}
      </TooltipContent>
    </TooltipRoot>
  )
}
