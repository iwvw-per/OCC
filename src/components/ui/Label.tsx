import { forwardRef } from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cn } from '../../utils/cn'

/**
 * Label - 表单标签
 *
 * 基于 Radix Label：点击标签聚焦关联控件，htmlFor 关联由原语处理。
 */
export const Label = forwardRef<React.ElementRef<typeof LabelPrimitive.Root>, React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        'flex flex-col gap-1 text-ui-sm text-text-300',
        'peer-disabled:opacity-40',
        className,
      )}
      {...props}
    />
  ),
)
Label.displayName = 'Label'
