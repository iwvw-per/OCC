import { forwardRef } from 'react'
import { cn } from '../../utils/cn'

/**
 * ContextMenuItem - 上下文菜单 / 面板菜单中的整行按钮
 *
 * 与 MenuItem 的区别：MenuItem 用于下拉选择菜单（带选中打勾、双行描述、
 * 较大行高）；ContextMenuItem 用于右键菜单与面板内的操作行，行高更紧凑、
 * 无圆角，常带图标与快捷键提示。
 */
export interface ContextMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode
  /** 行尾的快捷键或状态提示 */
  hint?: React.ReactNode
  /** 危险操作（如删除）使用红色文字 */
  tone?: 'default' | 'danger'
}

export const ContextMenuItem = forwardRef<HTMLButtonElement, ContextMenuItemProps>(
  ({ className, icon, hint, tone = 'default', children, disabled, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left',
        'text-ui-caption transition-colors duration-150',
        tone === 'danger'
          ? 'text-danger-100 hover:bg-danger-100/10 active:bg-danger-100/20'
          : 'text-text-200 hover:bg-bg-200 active:bg-bg-300',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-text-200',
        className,
      )}
      {...props}
    >
      {icon && <span className="flex size-4 shrink-0 items-center justify-center text-text-400">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-ui-xs text-text-500">{hint}</span>}
    </button>
  ),
)

ContextMenuItem.displayName = 'ContextMenuItem'
