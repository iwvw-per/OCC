import { forwardRef } from 'react'
import { cn } from '../../utils/cn'

/**
 * Input - 单行文本输入
 *
 * 样式对齐 settings 的 settingsFieldClass（边框 + 焦点 ring 走 accent 令牌），
 * 让设置页与其它模块使用同一套输入框外观。
 */
export type InputSize = 'sm' | 'md'

const sizeStyles: Record<InputSize, string> = {
  sm: 'h-7 px-2 text-ui-sm',
  md: 'h-8 px-2.5 text-ui-caption',
}

const FIELD_BASE =
  'min-w-0 w-full rounded-md bg-transparent text-text-100 placeholder:text-text-400 outline-none border border-border-200 transition-colors ' +
  'hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30 ' +
  'disabled:opacity-40 disabled:cursor-not-allowed'

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  inputSize?: InputSize
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, inputSize = 'md', ...props }, ref) => (
  <input ref={ref} className={cn(FIELD_BASE, sizeStyles[inputSize], className)} {...props} />
))
Input.displayName = 'Input'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      FIELD_BASE,
      'px-2.5 py-2 text-ui-caption resize-y leading-relaxed custom-scrollbar',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'
