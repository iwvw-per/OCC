import { forwardRef } from 'react'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'

type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg'
type IconButtonVariant = 'ghost' | 'solid' | 'danger'

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: IconButtonSize
  variant?: IconButtonVariant
  'aria-label': string
  children: React.ReactNode
}

const sizeStyles: Record<IconButtonSize, string> = {
  // 圆角按规范刻度：size-5/6 为紧凑控件取 rounded-sm(4px)，
  // size-8 取 rounded-md(6px)。原先 xs 用 rounded(4px 的旧别名)、
  // sm 用 rounded-md，两者对 size-5/size-6 而言占比偏大且刻度不统一。
  xs: 'size-5 rounded-sm',
  sm: 'size-6 rounded-sm',
  md: 'size-8 rounded-md',
  lg: 'size-10 rounded-md',
}

const variantStyles: Record<IconButtonVariant, string> = {
  // hover 只用底色加深，不用 ring：
  // ring 在本项目里是「键盘焦点」的专用表达（见 focusRing），若 hover 也加 ring，
  // 鼠标悬停与键盘聚焦将无法区分。原先用 ring 是为了避免 border 撑开尺寸，
  // 但底色本身不占布局，直接加深即可，无需引入第二种 ring 语义。
  ghost: 'bg-transparent text-text-400 hover:bg-bg-200 hover:text-text-100',
  solid: 'bg-accent-main-000 text-oncolor-100 hover:bg-accent-main-200 active:bg-accent-main-100',
  danger: 'bg-transparent text-text-400 hover:bg-danger-100/10 hover:text-danger-100',
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = 'md', variant = 'ghost', className, children, disabled, type = 'button', ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled}
        data-icon-button
        className={cn(
          'inline-flex shrink-0 items-center justify-center transition-colors duration-150',
          // 按下反馈用底色，不用 scale —— 点击不应改变元素边界
          'active:bg-bg-300 disabled:active:bg-transparent',
          interactive.focusRingCompact,
          interactive.disabled,
          sizeStyles[size],
          variantStyles[variant],
          className,
        )}
        {...props}
      >
        {children}
      </button>
    )
  },
)

IconButton.displayName = 'IconButton'
