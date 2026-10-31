// ============================================
// WorkStatusPrimitives — 面板的行 / 板块词汇表
// ============================================
//
// 每条读数都是一个带标签的行：图标、名称、右侧数值。扫一眼就知道
// 这个数字是什么，不需要悬停。板块有标题，彼此用细线分隔；面板本身
// 没有额外装饰，因为它是对话里的一个对象，不是停靠的窗格。

import { type ReactNode, useSyncExternalStore } from 'react'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'
import { ChevronDownIcon } from '../../components/Icons'
import { workStatusStore } from '../../store/workStatusStore'

/** 板块是面板的直接兄弟节点，分隔线用 :not(:first-child)。
 *  注意 Tailwind 任意变体必须带 &，写成 [&:not(:first-child)] 才会生成规则。 */
const SECTION_CLASS =
  'flex flex-col [&:not(:first-child)]:mt-2.5 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border-200/40 [&:not(:first-child)]:pt-2.5'

const HEADING_CLASS = 'text-[length:var(--fs-xs)] font-semibold text-text-100'

export function WorkStatusSection({
  title,
  icon,
  summary,
  children,
}: {
  title: string
  icon?: ReactNode
  /** 整个板块的聚合值；属于标题行，不属于某一行 */
  summary?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={SECTION_CLASS}>
      <div data-work-status-heading className="flex h-6 items-center gap-1.5 px-1">
        {icon != null && (
          <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-text-500">{icon}</span>
        )}
        <h3 className={cn(HEADING_CLASS, 'min-w-0 flex-1 truncate')}>{title}</h3>
        {summary !== undefined && summary !== null ? (
          <span className="min-w-0 max-w-[60%] truncate text-right text-[length:var(--fs-xxs)] tabular-nums text-text-500">
            {summary}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

/**
 * 可折叠板块。chevron 的展开/收起与消息流里的工具块一致，
 * 让两个可折叠控件看起来是同一个东西而不是两套约定。
 *
 * 展开态由本组件自己订阅 store，而不是从父级接收：
 * 父级用 useMemo 持有这些板块元素，props 引用不会随展开态变化，
 * 若展开态走 props，memo 会直接跳过重渲，点了标题行没反应。
 * 订阅放在这里，store 一变本组件就重渲。
 */
export function WorkStatusCollapsibleSection({
  id,
  title,
  icon,
  summary,
  /** 独立的标题行操作，例如刷新本板块数据 */
  action,
  /** 操作与聚合值的先后：end = 数值在左、操作在右；beforeSummary = 操作在左、数值在右 */
  actionPlacement = 'end',
  /** 折叠时仍显示在标题下方的预览 */
  collapsedContent,
  children,
}: {
  /** 持久化展开态的稳定 key */
  id: string
  title: string
  icon?: ReactNode
  summary?: ReactNode
  action?: ReactNode
  actionPlacement?: 'end' | 'beforeSummary'
  collapsedContent?: ReactNode
  children: ReactNode
}) {
  const expanded = useSyncExternalStore(
    workStatusStore.subscribe,
    () => workStatusStore.isSectionExpanded(id),
    () => workStatusStore.isSectionExpanded(id),
  )
  const onToggle = () => workStatusStore.setSectionExpanded(id, !expanded)
  const summaryNode =
    summary !== undefined && summary !== null ? (
      <span className="min-w-0 max-w-[60%] truncate text-right text-[length:var(--fs-xxs)] tabular-nums text-text-500">
        {summary}
      </span>
    ) : null
  return (
    <section className={SECTION_CLASS}>
      <div data-work-status-heading className="flex h-6 items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className={cn(
            'group/section flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left',
            // 面板里不用 hover 底色：这个行密度下色块会被读成选中态而不是可交互提示。
            // 交互性靠文字颜色表达。
            'transition-colors',
          )}
        >
          {icon != null && (
            <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-text-500">{icon}</span>
          )}
          <span className={cn(HEADING_CLASS, 'min-w-0 truncate')}>{title}</span>
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex size-3 shrink-0 items-center justify-center text-text-500 transition-transform duration-150',
              expanded ? '' : '-rotate-90',
            )}
          >
            <ChevronDownIcon size={11} />
          </span>
          <span className="flex-1" />
          {actionPlacement === 'end' && summaryNode}
        </button>
        {actionPlacement === 'beforeSummary' ? (
          <>
            {action}
            {summaryNode}
          </>
        ) : (
          action
        )}
      </div>
      {/* 折叠态预览：只在收起时显示，与正文互斥，不参与高度动画 */}
      {!expanded && collapsedContent ? <div className="pt-1">{collapsedContent}</div> : null}

      {/* 展开/收起用 grid-rows 过渡：0fr ↔ 1fr 能对「内容实际高度」做平滑动画，
          不需要预先测量。动画的是本板块自身，不影响相邻板块。
          收起时保持挂载（高度 0），板块的数据订阅因此不会因折叠而中断；
          inert 阻止 Tab 落进不可见的控件。 */}
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
        inert={!expanded}
      >
        <div className="overflow-hidden">
          <div className="pt-1">{children}</div>
        </div>
      </div>
    </section>
  )
}

interface RowProps {
  icon?: ReactNode
  leading?: ReactNode
  label: ReactNode
  value?: ReactNode
  muted?: boolean
  /** 把整行变成按钮；由调用方决定点开什么 */
  onClick?: () => void
  ariaLabel?: string
  className?: string
}

/** 单条读数。value 靠最右，label 在它之前截断，长分支名不会挤掉后面的计数 */
export function WorkStatusRow({ icon, leading, label, value, muted, onClick, ariaLabel, className }: RowProps) {
  const body = (
    <>
      {leading ?? (icon != null && <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-text-500">{icon}</span>)}
      <span className={cn('min-w-0 flex-1 truncate text-[length:var(--fs-xs)]', muted && 'text-text-400')}>
        {label}
      </span>
      {value !== undefined && value !== null ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[length:var(--fs-xs)] tabular-nums">{value}</span>
      ) : null}
    </>
  )

  const shared = cn('flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-text-300', className)

  if (!onClick) return <div className={shared}>{body}</div>

  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className={cn(shared, interactive.subtle)}>
      {body}
    </button>
  )
}

/**
 * 板块内的行容器。行与行之间不加线，分隔只发生在板块之间。
 */
export function WorkStatusRows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col', className)}>{children}</div>
}

export type WorkStatusTone = 'default' | 'muted' | 'success' | 'error' | 'warning' | 'info'

const TONE_CLASS: Record<Exclude<WorkStatusTone, 'default' | 'muted'>, string> = {
  success: 'text-success-100',
  error: 'text-danger-100',
  warning: 'text-warning-100',
  info: 'text-info-100',
}

export function WorkStatusValue({ children, tone = 'default' }: { children: ReactNode; tone?: WorkStatusTone }) {
  return (
    <span className={tone === 'muted' ? 'text-text-500' : tone === 'default' ? undefined : TONE_CLASS[tone]}>
      {children}
    </span>
  )
}

/**
 * 尾部控件，形状像一枚徽标：状态本身就是可点的东西。
 * 用在「状态即操作」的场景——需要登录的 MCP 服务器、等待恢复的目标。
 */
export function WorkStatusRowAction({
  children,
  onClick,
  tone = 'default',
  disabled,
  ariaLabel,
}: {
  children: ReactNode
  onClick: () => void
  tone?: 'default' | 'warning' | 'error' | 'info'
  disabled?: boolean
  ariaLabel?: string
}) {
  const toneClass = tone === 'default' ? 'bg-bg-300 text-text-400' : TONE_CLASS[tone]
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={event => {
        // 下面的整行常常是另一个按钮，目的地不同
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[length:var(--fs-xxs)] font-medium leading-4 transition-opacity',
        'hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50',
        toneClass,
      )}
    >
      {children}
    </button>
  )
}

/** 上下文窗口占用：画在对应行下方，而不是塞进行里 */
export function WorkStatusMeter({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="mx-1 mb-1 h-1 overflow-hidden rounded-full bg-border-200/50">
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: color }}
      />
    </div>
  )
}
