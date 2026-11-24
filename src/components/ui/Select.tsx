import { forwardRef } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { cn } from '../../utils/cn'
import { LAYER_POPUP } from '../../constants/layers'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from '../Icons'

/**
 * Select - 下拉选择
 *
 * 基于 Radix Select：键盘导航、typeahead、ARIA 由原语负责。
 * 注意：Radix 的 items 是 <SelectItem value>，不是传 options 数组，
 * 因此调用方显式声明选项，避免「显示原始值而非标签」这类问题。
 */
export const Select = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group
export const SelectValue = SelectPrimitive.Value

export const SelectTrigger = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-border-200 bg-transparent px-2.5',
      'text-ui-caption text-text-100 transition-colors',
      'hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30 focus-visible:outline-none',
      'disabled:opacity-40 disabled:cursor-not-allowed',
      '[&>span]:truncate',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDownIcon size={14} className="shrink-0 text-text-400" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = 'SelectTrigger'

export const SelectContent = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', style, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      // 层级统一走 LAYER_POPUP(必须高于 Dialog):见 constants/layers.ts 的说明。
      style={{ zIndex: LAYER_POPUP, ...style }}
      className={cn(
        'relative max-h-72 min-w-[8rem] overflow-hidden rounded-xl border border-border-200/60 glass p-1 shadow-lg',
        'overlay-surface',
        position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-text-400">
        <ChevronUpIcon size={14} />
      </SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className={cn(position === 'popper' && 'w-full min-w-[var(--radix-select-trigger-width)]')}>
        {children}
      </SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-text-400">
        <ChevronDownIcon size={14} />
      </SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = 'SelectContent'

export const SelectLabel = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn('px-2 py-1 text-ui-xs uppercase tracking-wider text-text-500', className)}
    {...props}
  />
))
SelectLabel.displayName = 'SelectLabel'

export const SelectItem = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 pr-7',
      'text-ui-caption text-text-200 outline-none transition-colors',
      // highlighted 是「鼠标/键盘高亮项」，语义为 hover，取统一悬停底色；
      // 选中态由 data-[state=checked] 的文字色 + CheckIcon 表达，不靠底色深浅区分。
      'data-[highlighted]:bg-bg-200 data-[highlighted]:text-text-100',
      'data-[state=checked]:text-text-100',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center text-accent-main-100">
      <CheckIcon size={13} />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
))
SelectItem.displayName = 'SelectItem'

export const SelectSeparator = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn('-mx-1 my-1 h-px bg-border-200/60', className)} {...props} />
))
SelectSeparator.displayName = 'SelectSeparator'
