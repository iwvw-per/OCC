import { CheckIcon } from '../Icons'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'

interface MenuItemProps {
  label: string
  description?: string
  icon?: React.ReactNode
  disabled?: boolean
  selected?: boolean
  selectionRole?: 'menuitemradio' | 'option'
  onClick?: () => void
}

export function MenuItem({
  label,
  description,
  icon,
  disabled = false,
  selected = false,
  selectionRole,
  onClick,
}: MenuItemProps) {
  const selectionProps =
    selectionRole === 'menuitemradio'
      ? { role: selectionRole, 'aria-checked': selected, tabIndex: selected ? 0 : -1 }
      : selectionRole === 'option'
        ? { role: selectionRole, 'aria-selected': selected, tabIndex: selected ? 0 : -1 }
        : {}

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      {...selectionProps}
      className={cn(
        'w-full px-2.5 py-1.5 rounded-lg flex items-start gap-2 text-left bg-transparent border-none select-none',
        'transition-colors duration-150',
        // 禁用态优先于交互态：用 disabled: 前缀而非三元，避免顺序依赖
        interactive.disabled,
        disabled ? 'text-text-500' : cn('cursor-pointer hover:bg-bg-200 active:bg-bg-300', interactive.focusRingCompact),
        selected && !disabled && 'text-text-100',
      )}
    >
      {icon && (
        <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5 text-text-400">{icon}</span>
      )}
      <div className="flex-1 min-w-0">
        <div className={`text-ui-caption ${disabled ? 'text-text-500' : selected ? 'text-text-100' : 'text-text-200'}`}>
          {label}
        </div>
        {description && (
          <div className="text-ui-sm text-text-500 mt-0.5 line-clamp-2" title={description}>
            {description}
          </div>
        )}
      </div>
      {selected && !disabled && (
        <span className="text-accent-secondary-100 flex-shrink-0 mt-0.5">
          <CheckIcon />
        </span>
      )}
    </button>
  )
}
