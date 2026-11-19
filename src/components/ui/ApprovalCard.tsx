import { forwardRef, type ReactNode } from 'react'
import { cn } from '../../utils/cn'

interface ApprovalCardProps {
  /** 卡片标题行（图标 + 标题 + 右侧元信息） */
  header: ReactNode
  children?: ReactNode
  /** 底部操作区，与内容用分隔线隔开 */
  footer?: ReactNode
  className?: string
}

/**
 * ApprovalCard — 需要用户决策的卡片外壳（权限确认、提问）。
 *
 * 结构与 ContentBlock 同源（rounded-md + border + header 条），
 * 让审批类交互与工具结果在消息流里读起来是同一种东西。
 */
export const ApprovalCard = forwardRef<HTMLDivElement, ApprovalCardProps>(
  ({ header, children, footer, className }, ref) => (
    <div ref={ref} className={cn('rounded-md border border-border-200/40 bg-bg-100 overflow-hidden', className)}>
      <div className="flex items-center gap-2 px-3 h-8 bg-bg-200/40 text-ui-caption">{header}</div>
      {children != null && <div className="px-3 py-2.5 text-ui-caption">{children}</div>}
      {footer && <div className="flex items-center gap-2 px-3 py-2 border-t border-border-200/40">{footer}</div>}
    </div>
  ),
)
ApprovalCard.displayName = 'ApprovalCard'
