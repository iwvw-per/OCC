import {
  cloneElement,
  forwardRef,
  createContext,
  useContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '../../utils/cn'
import { useInputCapabilities } from '../../hooks/useInputCapabilities'

/**
 * 触摸端不展示自绘提示。
 *
 * Radix 的气泡在 Trigger 聚焦时就会打开,而触摸设备「一戳即 focus」——提示
 * 既不是用户主动触发、又容易停在屏幕上不消失。触摸端(preferTouchUi)因此
 * 直接渲染 children,不建立任何 Tooltip 结构。
 *
 * 判定与全局一致:能 hover 的设备(含带鼠标的触屏笔记本)照常显示。
 */
function useTooltipsDisabledOnTouch(): boolean {
  return useInputCapabilities().preferTouchUi
}

/**
 * Tooltip - 悬浮提示
 *
 * 基于 Radix Tooltip:自带延迟、碰撞避让与 aria-describedby。
 * 应用根需包一层 TooltipProvider(App 已接入,见 TooltipProvider 导出);
 * 若没有外层 Provider(单测直接渲染组件时),组件会自补一个,避免 Radix 报错。
 *
 * 气泡用实色面(bg-tooltip / text-tooltip-foreground,不走 .glass 毛玻璃),
 * 保证叠在任意内容上都清晰;快捷键徽标用 bg-tooltip-tag。
 */
const TooltipProviderPresence = createContext(false)

export function TooltipProvider({ children, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipProviderPresence.Provider value={true}>
      <TooltipPrimitive.Provider {...props}>{children}</TooltipPrimitive.Provider>
    </TooltipProviderPresence.Provider>
  )
}

/**
 * 检测外层是否已有 TooltipProvider:有则直连(共享同一 Provider,不为每个提示重复创建上下文),
 * 没有则自补一个,保证组件可独立渲染。
 */
function TooltipRootScoped({ delayDuration, children }: { delayDuration?: number; children: ReactNode }) {
  const provided = useContext(TooltipProviderPresence)
  if (provided) return <>{children}</>
  return (
    <TooltipProviderPresence.Provider value={true}>
      <TooltipPrimitive.Provider delayDuration={delayDuration}>{children}</TooltipPrimitive.Provider>
    </TooltipProviderPresence.Provider>
  )
}

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
        'z-[300] max-w-[min(320px,80vw)] rounded-lg border border-border-200/60 bg-tooltip px-2 py-1',
        'text-ui-sm leading-relaxed text-tooltip-foreground shadow-lg',
        // 开合动画由 index.css 的 .overlay-tooltip 驱动(位移淡入,不缩放)。
        'overlay-tooltip',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = 'TooltipContent'

export interface ShortcutBadgeProps {
  children: ReactNode
  className?: string
}

/** 提示气泡内的快捷键徽标。 */
export function ShortcutBadge({ children, className }: ShortcutBadgeProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 shrink-0 select-none items-center rounded-sm bg-tooltip-tag px-1.5 font-mono text-ui-xs text-tooltip-tag-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export interface TooltipProps {
  /** 提示内容。为空时直接渲染 children,不创建 Tooltip 结构。 */
  content?: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delayDuration?: number
  className?: string
}

/**
 * Tooltip - 组合式便捷封装:传 content 即用。
 * 这是日常使用的主要入口,避免每个调用点重复拼装 Trigger/Content。
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delayDuration = 300,
  className,
}: TooltipProps) {
  const touchDisabled = useTooltipsDisabledOnTouch()
  if (!content || touchDisabled) return <>{children}</>
  return (
    <TooltipRootScoped delayDuration={delayDuration}>
      <TooltipRoot delayDuration={delayDuration}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} align={align} className={className}>
          {content}
        </TooltipContent>
      </TooltipRoot>
    </TooltipRootScoped>
  )
}

export interface HintTooltipProps {
  /** 主标题(必填)。 */
  title: ReactNode
  /** 可选的补充说明,存在时气泡转为纵向布局。 */
  description?: ReactNode
  /** 可选的快捷键,展示为右侧徽标(如 'Ctrl+T')。 */
  shortcut?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  delayDuration?: number
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

/**
 * HintTooltip - 结构化提示(title / description / shortcut 三段式)。
 *
 * 与 Tooltip 的区别:统一了标题、说明、快捷键徽标的排版,
 * 调用点只描述内容,不重复拼装样式。
 */
export function HintTooltip({
  title,
  description,
  shortcut,
  side = 'top',
  align = 'center',
  sideOffset = 6,
  delayDuration = 300,
  className,
  open,
  onOpenChange,
  children,
}: HintTooltipProps) {
  const touchDisabled = useTooltipsDisabledOnTouch()
  const hasDescription = description !== undefined && description !== null && description !== ''
  if (touchDisabled) return <>{children}</>
  return (
    <TooltipRootScoped delayDuration={delayDuration}>
      <TooltipRoot open={open} onOpenChange={onOpenChange} delayDuration={delayDuration}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side={side}
          align={align}
          sideOffset={sideOffset}
          className={cn(
            hasDescription
              ? 'max-w-[min(320px,80vw)] flex-col items-start gap-1.5 px-3 py-2 text-left'
              : 'max-w-[min(28rem,80vw)] items-center gap-2 px-2.5 py-1 text-left',
            className,
          )}
        >
          {hasDescription ? (
            <>
              <div className="flex w-full items-start justify-between gap-3">
                <span className="text-ui-sm font-medium leading-4">{title}</span>
                {shortcut ? <ShortcutBadge>{shortcut}</ShortcutBadge> : null}
              </div>
              <span className="text-ui-sm leading-relaxed text-tooltip-foreground/80">{description}</span>
            </>
          ) : (
            <>
              <span className="text-ui-sm font-medium whitespace-pre-line break-words">{title}</span>
              {shortcut ? <ShortcutBadge>{shortcut}</ShortcutBadge> : null}
            </>
          )}
        </TooltipContent>
      </TooltipRoot>
    </TooltipRootScoped>
  )
}

type TooltipChildProps = { title?: string }

export interface NativeTooltipProps {
  /** 单个可转发 ref 的元素(button / span 等),沿用其原生 title 作为提示标题。 */
  children: ReactElement<TooltipChildProps>
  description?: ReactNode
  shortcut?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delayDuration?: number
}

/**
 * NativeTooltip - 把子元素的原生 `title` 就地升级为自绘提示。
 *
 * 用于渐进式替换大量 `title=` 提示:包裹元素即可,不用改元素本身,
 * 也无需手动搬运 title 文案。title 为空时原样渲染子元素。
 */
export function NativeTooltip({ children, description, shortcut, side, align, delayDuration }: NativeTooltipProps) {
  const touchDisabled = useTooltipsDisabledOnTouch()
  const title = children.props.title
  if (!title) return children
  // 触摸端不建 Tooltip,但要保留「去掉原生 title」这一步:否则气泡没了,
  // 长按却弹出浏览器原生 title 提示,与自绘提示的意图不一致。
  if (touchDisabled) return cloneElement(children, { title: undefined })
  return (
    <HintTooltip
      title={title}
      description={description}
      shortcut={shortcut}
      side={side}
      align={align}
      delayDuration={delayDuration}
    >
      {cloneElement(children, { title: undefined })}
    </HintTooltip>
  )
}
