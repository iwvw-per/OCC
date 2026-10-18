// ============================================
// 设置面板的通用行结构
//
// 设置页里大量「标题 + 说明 + 右侧控件」的重复布局与「行内小按钮」，
// 统一到这里，避免每个设置组件各写一套间距与尺寸。
// ============================================

import type { ReactNode } from 'react'
import { cn } from '../../../utils/cn'
import { interactive } from '../../../utils/interaction'
import { controlSize, controlTone, type ControlSize, type ControlTone } from '../../../utils/controlStyles'

export interface SettingsRowProps {
  title: ReactNode
  description?: ReactNode
  /** 右侧控件（开关、下拉、按钮） */
  children?: ReactNode
  /** 长说明：控件换到下一行（说明占满宽度，更易读） */
  stacked?: boolean
  className?: string
}

/** 一行设置项：左侧标题/说明，右侧控件。 */
export function SettingsRow({ title, description, children, stacked = false, className }: SettingsRowProps) {
  return (
    <div
      className={cn(
        'py-3',
        stacked ? 'flex flex-col gap-2' : 'flex items-start justify-between gap-4',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[length:var(--fs-sm)] font-medium text-text-100">{title}</div>
        {description && (
          <div className="mt-0.5 text-[length:var(--fs-xs)] text-text-400 leading-relaxed">{description}</div>
        )}
      </div>
      {children && (
        <div className={cn('flex items-center gap-2', stacked ? '' : 'shrink-0')}>{children}</div>
      )}
    </div>
  )
}

export interface SettingsInlineButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: ControlSize
  tone?: ControlTone
}

/**
 * 设置项里的小按钮（如「刷新」「重置」）。
 *
 * 统一尺寸与语义色，交互态交给 interactive，避免各面板手写 h-6/px-2 等组合。
 */
export function SettingsInlineButton({
  size = 'sm',
  tone = 'default',
  className,
  type = 'button',
  children,
  ...props
}: SettingsInlineButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center font-medium transition-colors duration-150',
        controlSize[size],
        controlTone[tone],
        interactive.row,
        interactive.focusRingCompact,
        interactive.disabled,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
