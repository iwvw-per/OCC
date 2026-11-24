import { forwardRef } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '../../utils/cn'
import { LAYER_POPUP } from '../../constants/layers'

/**
 * Popover - 锚定浮层
 *
 * 基于 Radix Popover：点击外部关闭、焦点管理、碰撞避让由原语负责。
 * 适合承载表单、详情等需要交互的内容；纯菜单场景请用 DropdownMenu。
 */
export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor
export const PopoverClose = PopoverPrimitive.Close

export const PopoverContent = forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 8, style, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      style={{ zIndex: LAYER_POPUP, ...style }}
      className={cn(
        'rounded-xl border border-border-200/60 glass p-3 shadow-lg outline-none',
        'text-ui-caption text-text-200',
        // 开合动画由 index.css 的 .overlay-surface 驱动（与 Select/DropdownMenu 统一）。
        'overlay-surface',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = 'PopoverContent'
