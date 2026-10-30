import { forwardRef, type ReactNode } from 'react'
import { ChevronDownIcon } from '../Icons'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'
import { MSG_EXPAND } from '../../features/message/messageExpandShared'

export type DisclosureRowSize = 'sm' | 'md' | 'lg'

/**
 * 高度与既有消息流对齐：
 * - sm: py-1（28px）— 思考、过程壳、描述型工具行、子任务行
 * - md: h-8（32px）— 卡片头（todo、ContentBlock）
 * - lg: h-9（36px）— 时间线工具行
 */
const sizeStyles: Record<DisclosureRowSize, string> = {
  sm: 'py-1 gap-1.5 text-[length:var(--fs-sm)]',
  md: 'h-8 gap-2 text-[length:var(--fs-sm)]',
  lg: 'h-9 gap-2.5 text-[length:var(--fs-md)]',
}

const labelToneStyles = {
  idle: 'text-text-400 group-hover/disclosure:text-text-200',
  active: 'reasoning-shimmer-text',
  accent: 'accent-shimmer-text',
  error: 'text-danger-100',
  warning: 'text-warning-100',
} as const

export type DisclosureLabelTone = keyof typeof labelToneStyles

interface DisclosureRowProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  expanded: boolean
  /** 左侧图标，固定 14px 列宽对齐 */
  icon?: ReactNode
  /** 主标签 */
  label: ReactNode
  /** 关闭标签的单行截断（内部需要自行测量/换行时用） */
  truncateLabel?: boolean
  /** 标签是否占满剩余空间。false 时标签按内容宽度、chevron 紧贴其后 */
  growLabel?: boolean
  /** 右侧元信息（耗时、计数、状态 chip 等） */
  meta?: ReactNode
  size?: DisclosureRowSize
  labelTone?: DisclosureLabelTone
  /** 是否显示 chevron，默认显示 */
  showChevron?: boolean
  /** 隐藏 chevron 时仍保留占位，避免多行纵向对齐抖动 */
  reserveChevronSpace?: boolean
  /**
   * 是否使用消息流的负 margin 内边距（默认 true）。
   * 卡片内的 header（如 todo 卡片）传 false，由卡片自身提供 px-3。
   */
  inset?: boolean
}

export const DisclosureRow = forwardRef<HTMLButtonElement, DisclosureRowProps>(
  (
    {
      expanded,
      icon,
      label,
      meta,
      size = 'md',
      labelTone = 'idle',
      truncateLabel = true,
      growLabel = true,
      showChevron = true,
      reserveChevronSpace = false,
      inset = true,
      className,
      onClick,
      type = 'button',
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      onClick={onClick}
      aria-expanded={expanded}
      className={cn(
        'group/disclosure flex min-w-0 items-center rounded-md text-left',
        /**
         * `w-full` 与 `contentRow` 的负边距组合会让行盒左右不对称。
         *
         * `contentRow` 是 `px-1.5 -mx-1.5`：负边距把行盒左右各外扩 6px，
         * 本意是「hover 底色比正文宽一圈、内边距把文字推回正文左缘」。但 `w-full`
         * 把宽度钉死为父容器的 100%，负边距就只剩「整行左移 6px」——文字左缘
         * 仍对齐正文，右缘却比正文窄 12px。展开面板是满宽渲染的，于是同一个
         * 工具行的 header 比它下面的内容窄一截，右侧看起来「更靠外」。
         *
         * 用 calc 把负边距那 12px 补回宽度，行盒才真正左右对称：
         * 文字左右缘都与正文（以及展开面板）对齐。
         */
        inset ? 'w-[calc(100%+0.75rem)]' : 'w-full',
        'transition-colors duration-150',
        inset ? interactive.contentRow : 'px-3',
        sizeStyles[size],
        className,
      )}
      {...props}
    >
      {icon != null && <span className="inline-flex w-4 shrink-0 items-center justify-center">{icon}</span>}

      <span
        className={cn(
          'min-w-0',
          growLabel ? 'flex-1' : 'flex-none',
          truncateLabel && 'truncate',
          labelToneStyles[labelTone],
        )}
      >
        {label}
      </span>

      {meta != null && (
        /**
         * `min-w-0` + `flex-shrink` 是移动端不溢出的关键。
         *
         * 之前这里是 `shrink-0`：meta 里的内容（如运行中的命令摘要）再长也不收缩，
         * 而它右边还有 chevron 占位 —— 窄屏上整行被挤出去，文字直接顶到屏幕外。
         * 现在允许收缩，并由调用方给具体文本加 `truncate` 与 `max-w` 上限。
         */
        <span className="ml-auto flex min-w-0 shrink items-center gap-2 overflow-hidden">{meta}</span>
      )}

      {(showChevron || reserveChevronSpace) && (
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex shrink-0 items-center justify-center text-text-500',
            size === 'sm' ? 'w-3' : 'w-3.5',
            MSG_EXPAND.chevron,
            expanded ? '' : '-rotate-90',
            !showChevron && 'invisible',
            // meta 自带 ml-auto，chevron 只需在「无 meta 且标签不占满」时自己靠右
            !inset && meta == null && !growLabel && 'ml-auto',
          )}
        >
          <ChevronDownIcon size={12} />
        </span>
      )}
    </button>
  ),
)
DisclosureRow.displayName = 'DisclosureRow'
