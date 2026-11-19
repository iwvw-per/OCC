import { forwardRef } from 'react'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'
import { SpinnerIcon } from '../Icons'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  isLoading?: boolean
  children: React.ReactNode
}

const variantStyles: Record<ButtonVariant, string> = {
  // 按下反馈只用底色加深，不做 scale/translate —— 点击不应改变元素边界
  primary: 'bg-accent-main-000 hover:bg-accent-main-200 active:bg-accent-main-100 text-oncolor-100',
  secondary: 'bg-bg-200 hover:bg-bg-300 active:bg-bg-300 text-text-200',
  ghost: 'bg-transparent hover:bg-bg-200 active:bg-bg-300 text-text-300',
  danger: 'bg-danger-100 hover:bg-danger-200 active:bg-danger-200 text-oncolor-100',
}

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 rounded-md text-ui-sm',
  md: 'h-8 px-3 rounded-lg text-ui-base',
  lg: 'h-10 px-4 rounded-lg text-ui-lg',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = 'primary', size = 'md', isLoading = false, className, children, disabled, type = 'button', ...props },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || isLoading}
        className={cn(
          'inline-flex items-center justify-center gap-2 font-medium',
          'transition-colors duration-150',
          interactive.focusRingCompact,
          interactive.disabled,
          variantStyles[variant],
          sizeStyles[size],
          className,
        )}
        {...props}
      >
        {isLoading && <SpinnerIcon size={14} className="animate-spin" />}
        {children}
      </button>
    )
  },
)

Button.displayName = 'Button'
