// ============================================
// Breadcrumb — 带动画的面包屑导航
// ============================================
//
// 借鉴 beui.dev 的 Animated Breadcrumb，做成本项目自包含组件：
// - 用项目自己的令牌（bg-bg-*、text-text-*、border-border-*）与交互词汇表
// - 折叠区用已有的 Radix Popover（ui/Popover）而非 beui 的 morph popover，
//   避免引入其整套主题依赖
// - 保留其核心动画：条目进出的 layout 位移（motion LayoutGroup + AnimatePresence）
//
// 折叠规则与 beui 一致：maxItems 为最多可见槽位（含省略号），最小 3；
// 传 Infinity 关闭折叠。折叠时保留「首个 + 省略号 + 末尾若干」。

import {
  Children,
  forwardRef,
  type ComponentPropsWithRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion, type HTMLMotionProps } from 'motion/react'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'
import { ChevronRightIcon, MenuDotsIcon } from '../Icons'
import { Popover, PopoverContent, PopoverTrigger } from './Popover'

const EASE_OUT = [0.16, 1, 0.3, 1] as const
const SPRING_LAYOUT = { type: 'spring', stiffness: 360, damping: 32, mass: 0.6 } as const

export type BreadcrumbProps = ComponentPropsWithRef<'nav'>

/** 导航地标。路由变化时保持挂载，条目进出才有动画。 */
export function Breadcrumb({ className, children, ...props }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" {...props} className={cn('min-w-0', className)}>
      <LayoutGroup>{children}</LayoutGroup>
    </nav>
  )
}

export type BreadcrumbListProps = ComponentPropsWithRef<'ol'> & {
  /** 最多可见槽位（含省略号），最小 3；Infinity 关闭折叠。默认 4。 */
  maxItems?: number
  /** 折叠区可访问标签。 */
  overflowLabel?: string
}

/** 直接传入带 key 的 BreadcrumbItem，进出路由才有动画。 */
export function BreadcrumbList({
  className,
  children,
  maxItems = 4,
  overflowLabel = 'Show hidden paths',
  ...props
}: BreadcrumbListProps) {
  const items = Children.toArray(children)
  const limit = Number.isFinite(maxItems) ? Math.max(3, Math.floor(maxItems)) : 4
  const collapse = maxItems !== Infinity && items.length > limit
  const tailCount = limit - 2
  const visible = collapse
    ? [
        items[0],
        <BreadcrumbItem key="breadcrumb-overflow">
          <BreadcrumbSeparator />
          <BreadcrumbEllipsis label={overflowLabel}>{items.slice(1, -tailCount)}</BreadcrumbEllipsis>
        </BreadcrumbItem>,
        ...items.slice(-tailCount),
      ]
    : items
  return (
    <ol
      {...props}
      className={cn('relative flex flex-wrap items-center gap-x-1 gap-y-1 text-ui-caption', className)}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {visible}
      </AnimatePresence>
    </ol>
  )
}

export type BreadcrumbItemProps = HTMLMotionProps<'li'>

/** 用稳定的路由 key；可选分隔符放在本条目内部。 */
export const BreadcrumbItem = forwardRef<HTMLLIElement, BreadcrumbItemProps>(function BreadcrumbItem(
  { className, children, ...props },
  ref,
) {
  const reduce = useReducedMotion()
  const hidden = { opacity: 0, y: reduce ? 0 : 6 }
  return (
    <motion.li
      ref={ref}
      layout={reduce ? false : 'position'}
      initial={hidden}
      animate={{ opacity: 1, y: 0 }}
      exit={hidden}
      transition={{ duration: 0.2, ease: EASE_OUT, layout: SPRING_LAYOUT }}
      {...props}
      className={cn('relative inline-flex min-w-0 max-w-full items-center gap-1', className)}
    >
      {children}
    </motion.li>
  )
})

export type BreadcrumbLinkProps = ComponentPropsWithRef<'a'> & {
  /** 渲染路由自己的 Link，把这些 props 展开上去。 */
  render?: (props: ComponentPropsWithRef<'a'>) => ReactElement
}

export function BreadcrumbLink({ className, render, ...props }: BreadcrumbLinkProps) {
  const linkProps = {
    ...props,
    className: cn(
      'inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-2 font-medium text-text-400 transition-colors duration-150 hover:bg-bg-200 hover:text-text-100 [&>svg]:size-3.5 [&>svg]:shrink-0',
      interactive.focusRing,
      className,
    ),
  }
  return render ? render(linkProps) : <a {...linkProps} />
}

export type BreadcrumbPageProps = ComponentPropsWithRef<'span'>

export function BreadcrumbPage({ className, children, ...props }: BreadcrumbPageProps) {
  return (
    <span
      {...props}
      aria-current="page"
      className={cn(
        'relative isolate inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-2 font-medium text-text-100 [overflow-wrap:anywhere] [&>svg]:size-3.5 [&>svg]:shrink-0',
        interactive.focusRing,
        className,
      )}
    >
      {children}
    </span>
  )
}

export type BreadcrumbSeparatorProps = ComponentPropsWithRef<'span'>

/** 装饰性分隔符，放在紧随其后的 BreadcrumbItem 内。 */
export function BreadcrumbSeparator({ className, children, ...props }: BreadcrumbSeparatorProps) {
  return (
    <span
      {...props}
      aria-hidden="true"
      data-breadcrumb-separator=""
      className={cn('inline-flex shrink-0 items-center text-text-500/50 [&>svg]:size-3.5 rtl:rotate-180', className)}
    >
      {children ?? <ChevronRightIcon />}
    </span>
  )
}

export interface BreadcrumbEllipsisProps {
  /** 被隐藏的 BreadcrumbItem，按路径顺序。 */
  children: ReactNode
  className?: string
  label?: string
}

/** 省略号：hover 或点击展开被折叠的祖先路径。 */
export function BreadcrumbEllipsis({ children, className, label = 'Show hidden paths' }: BreadcrumbEllipsisProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100',
            interactive.focusRing,
            className,
          )}
        >
          <MenuDotsIcon className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        <ol className="flex max-h-64 flex-col gap-0.5 overflow-y-auto custom-scrollbar [&>li]:w-full [&_a]:w-full [&_a]:py-1 [&_[data-breadcrumb-separator]]:hidden">
          {children}
        </ol>
      </PopoverContent>
    </Popover>
  )
}
