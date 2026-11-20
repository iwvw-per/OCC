import { createContext, forwardRef, useContext } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '../../utils/cn'

/**
 * Tabs - 分段控件/标签切换
 *
 * 基于 Radix Tabs：键盘方向键切换、ARIA role 与焦点管理由原语负责，
 * 样式走项目设计令牌。三种视觉风格：
 *   - segmented（默认）：胶囊分段控件，浅底 + 主文字色
 *   - slider：胶囊分段 + 滑块位移动画（用于设置项等需要更强反馈的场景）
 *   - underline：下划线式，用于内容区顶部导航
 */
export type TabsVariant = 'segmented' | 'slider' | 'underline'
export type TabsSize = 'sm' | 'md' | 'lg'

const listBase: Record<TabsVariant, string> = {
  segmented: 'inline-flex items-center gap-0.5 border border-border-200/60 bg-bg-200/40 p-0.5',
  slider: 'relative isolate inline-flex items-center gap-0 border border-border-200/40 bg-bg-200/60 p-1',
  underline: 'flex items-center gap-1 border-b border-border-200',
}

/**
 * 容器圆角按尺寸取值。
 *
 * 紧凑的 sm 整体只有约 25px 高（11px 文字 + py-1 + p-0.5 + 边框），
 * 若与 md 同用 8px 会占高度 32%，明显偏圆；故降一档取 4px。
 * 内层相应取 2px，满足同心：内层 = 外层 − p-0.5 的 2px。
 *
 * lg 用于装图标的分段控件（如侧栏底部的主题切换）：字号 text-ui-caption、
 * 内边距更大，整体约 34px 高，容器取 6px 更协调。
 */
const listRadius: Record<TabsSize, string> = {
  sm: 'rounded-sm',
  md: 'rounded-lg',
  lg: 'rounded-md',
}

/** 内层 trigger 的圆角，与外层保持同心（外层值 − p-0.5 的 2px） */
const triggerRadius: Record<TabsSize, string> = {
  sm: 'rounded-xs',
  md: 'rounded-md',
  lg: 'rounded-sm',
}

const triggerBase = 'inline-flex items-center gap-1 whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-main-100/40 disabled:opacity-40 disabled:cursor-not-allowed'

const triggerVariant: Record<TabsVariant, { base: string; active: string; inactive: string }> = {
  segmented: {
    // 圆角按尺寸取值，见 triggerRadius
    base: 'font-semibold uppercase tracking-wider border border-transparent',
    // 浅底 + 主文字色：与 TaskRenderer / ProjectSelector 的既有写法一致，
    // 全主题下激活态对比度 >= 9.9:1（原 bg-accent-main-100 + 白字仅 2.1~6.2:1）。
    active: 'bg-accent-main-100/15 text-text-100 border-border-200',
    inactive: 'text-text-500 hover:text-text-100',
  },
  slider: {
    // 激活态由 TabsList 的滑动指示层呈现，trigger 自身只负责文字色。
    // 在 grid 布局下需要自己居中内容。
    base: 'relative z-10 justify-center font-medium',
    active: 'text-text-100',
    inactive: 'text-text-400 hover:text-text-100',
  },
  underline: {
    base: 'rounded-none border-b-2 -mb-px font-medium',
    active: 'border-accent-main-100 text-text-100',
    inactive: 'border-transparent text-text-500 hover:text-text-100',
  },
}

const triggerSize: Record<TabsSize, string> = {
  sm: 'px-2 py-1 text-ui-xs',
  md: 'px-2.5 py-1.5 text-ui-sm',
  lg: 'px-2.5 py-1.5 text-ui-caption',
}

interface TabsProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> {
  variant?: TabsVariant
  size?: TabsSize
}

/**
 * 由 Tabs 下发尺寸与变体，TabsList / TabsTrigger 自动继承。
 *
 * 此前三处需各自传 size/variant，漏传会导致外层与内层圆角不匹配
 * （例如 TabsList 用默认 sm 而 TabsTrigger 传 md，内层圆角反而大于外层）。
 */
const TabsConfigContext = createContext<{ variant: TabsVariant; size: TabsSize }>({
  variant: 'slider',
  size: 'sm',
})

export const Tabs = forwardRef<React.ElementRef<typeof TabsPrimitive.Root>, TabsProps>(
  ({ className, variant = 'slider', size = 'sm', ...props }, ref) => (
    <TabsConfigContext.Provider value={{ variant, size }}>
      <TabsPrimitive.Root
        ref={ref}
        className={cn('flex flex-col', className)}
        data-variant={variant}
        data-size={size}
        {...props}
      />
    </TabsConfigContext.Provider>
  ),
)
Tabs.displayName = 'Tabs'

type TabsListProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
  variant?: TabsVariant
  size?: TabsSize
  /** slider 变体专用：激活项索引与总项数，用于定位滑动指示层。 */
  activeIndex?: number
  itemCount?: number
}

export const TabsList = forwardRef<React.ElementRef<typeof TabsPrimitive.List>, TabsListProps>(
  ({ className, variant, size, activeIndex, itemCount, children, style, ...props }, ref) => {
    const inherited = useContext(TabsConfigContext)
    const resolvedVariant = variant ?? inherited.variant
    const resolvedSize = size ?? inherited.size
    const showSlider =
      resolvedVariant === 'slider' && typeof activeIndex === 'number' && typeof itemCount === 'number' && itemCount > 0
    return (
      <TabsPrimitive.List
        ref={ref}
        className={cn(
          listBase[resolvedVariant],
          resolvedVariant === 'underline' ? undefined : listRadius[resolvedSize],
          showSlider && 'grid',
          className,
        )}
        style={showSlider ? { gridTemplateColumns: `repeat(${itemCount}, minmax(0, 1fr))`, ...style } : style}
        {...props}
      >
        {showSlider && (
          <div
            aria-hidden
            className={cn(
              'absolute top-1 bottom-1 left-1 -z-10 bg-bg-000 shadow-sm transition-transform duration-300 ease-out',
              // 指示层与 trigger 同层，取相同圆角保持视觉一致
              triggerRadius[resolvedSize],
            )}
            style={{
              width: `calc((100% - 8px) / ${itemCount})`,
              transform: `translateX(${activeIndex * 100}%)`,
            }}
          />
        )}
        {children}
      </TabsPrimitive.List>
    )
  },
)
TabsList.displayName = 'TabsList'

type TabsTriggerProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
  variant?: TabsVariant
  size?: TabsSize
}

const triggerActive: Record<TabsVariant, string> = {
  segmented:
    'data-[state=active]:bg-accent-main-100/15 data-[state=active]:text-text-100 data-[state=active]:border-border-200',
  // 悬浮只提亮文字,不铺背景:trigger 在滑块上层(z-10),
  // 铺 hover 背景会盖住下面的白色滑块。
  slider: 'data-[state=active]:text-text-100',
  underline: 'data-[state=active]:border-accent-main-100 data-[state=active]:text-text-100',
}

export const TabsTrigger = forwardRef<React.ElementRef<typeof TabsPrimitive.Trigger>, TabsTriggerProps>(
  ({ className, variant, size, ...props }, ref) => {
    const inherited = useContext(TabsConfigContext)
    const resolvedVariant = variant ?? inherited.variant
    const resolvedSize = size ?? inherited.size
    return (
      <TabsPrimitive.Trigger
        ref={ref}
        className={cn(
          triggerBase,
          triggerVariant[resolvedVariant].base,
          triggerRadius[resolvedSize],
          triggerSize[resolvedSize],
          triggerVariant[resolvedVariant].inactive,
          // Radix 用 data-state 标记激活态，无需在调用方重复传递状态。
          triggerActive[resolvedVariant],
          className,
        )}
        {...props}
      />
    )
  },
)
TabsTrigger.displayName = 'TabsTrigger'

export const TabsContent = forwardRef<React.ElementRef<typeof TabsPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Content ref={ref} className={cn('focus-visible:outline-none', className)} {...props} />
  ),
)
TabsContent.displayName = 'TabsContent'
