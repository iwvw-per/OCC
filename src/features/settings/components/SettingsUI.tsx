import { createContext, useContext, useRef } from 'react'
import type React from 'react'
import { Switch } from '../../../components/ui/Switch'
import { Tabs, TabsList, TabsTrigger } from '../../../components/ui/Tabs'
import { cn } from '../../../utils/cn'

const SettingLabelContext = createContext<string | undefined>(undefined)

export const settingsFieldClass =
  'min-w-0 w-full h-8 px-2.5 text-ui-caption rounded-md bg-transparent text-text-100 placeholder:text-text-400 outline-none border border-border-200 transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30'

export const settingsFieldAreaClass =
  'min-w-0 w-full px-2.5 py-2 text-ui-caption rounded-md bg-transparent text-text-100 placeholder:text-text-400 outline-none border border-border-200 transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30 resize-y leading-relaxed custom-scrollbar'

// ============================================
// Shared Settings UI Primitives
//
// 设计原则：
// - SettingsSection 是唯一的分组容器（标题 + 描述 + 内容）
// - section 之间靠间距区分，不画底部分割线
// - 不再有大框套小框：内部只用 SettingRow / SegmentedControl / 子分组
// - 需要视觉聚合时用 SettingsSubgroup（淡背景圆角，无边框）
// - 行级内容卡片（服务器项、声音事件项等）自带边框，作为列表项使用
// ============================================

/**
 * Toggle switch — 36×20，即时生效。
 * 圆角 full，hover 有 ring 反馈，checked 时 accent 色。
 */
export function Toggle({
  enabled,
  onChange,
  ariaLabel,
  disabled,
}: {
  enabled: boolean
  onChange: () => void
  ariaLabel?: string
  disabled?: boolean
}) {
  const rowLabel = useContext(SettingLabelContext)
  return (
    // 复用 ui/Switch（Radix）保证行为一致；外层包一层拦截 click 冒泡，
    // 避免点击开关同时触发 SettingRow 的整体 onClick。
    <span
      className="inline-flex touch-manipulation"
      onClick={e => {
        e.stopPropagation()
      }}
    >
      <Switch
        checked={enabled}
        onCheckedChange={() => {
          if (disabled) return
          onChange()
        }}
        aria-label={ariaLabel ?? rowLabel}
        disabled={disabled}
      />
    </span>
  )
}

/**
 * Segmented control — 多选一切换器，保留滑块动画。
 *
 * 实现委托给 ui/Tabs 的 slider 变体，避免与基础组件重复实现键盘处理与
 * ARIA 语义。对外保持原有的 options/onChange 签名，调用方无需改动。
 */
export interface SegmentedControlProps<T extends string> {
  value: T
  options: { value: T; label: string; icon?: React.ReactNode }[]
  onChange: (value: T, event?: React.MouseEvent) => boolean | void
  /** 尺寸档位，默认 md（设置页）。侧栏底部主题切换用 lg 以容纳 14px 图标。 */
  size?: 'sm' | 'md' | 'lg'
  /** 是否撑满容器宽度。设置页由外层 max-w 约束，侧栏需要 w-full。 */
  fullWidth?: boolean
  className?: string
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  fullWidth = false,
  className,
}: SegmentedControlProps<T>) {
  const activeIndex = Math.max(0, options.findIndex(o => o.value === value))
  // Radix 的 onValueChange 不带事件，但主题切换需要它做「从点击位置扩散」的
  // 圆形揭示动画（useTheme 在无 event 时降级为无动画）。因此在 pointerdown
  // 时先记下事件，再交给 onChange。
  const pointerEventRef = useRef<React.MouseEvent | undefined>(undefined)

  return (
    <Tabs
      variant="slider"
      size={size}
      value={value}
      className={className}
      data-segmented
      onValueChange={next => {
        const event = pointerEventRef.current
        pointerEventRef.current = undefined
        onChange(next as T, event)
      }}
    >
      <TabsList
        activeIndex={activeIndex}
        itemCount={options.length}
        className={fullWidth ? 'w-full' : undefined}
      >
        {options.map(opt => (
          <TabsTrigger
            key={opt.value}
            value={opt.value}
            aria-label={opt.label}
            onPointerDown={e => {
              pointerEventRef.current = e as unknown as React.MouseEvent
            }}
          >
            {opt.icon}
            <span className="truncate">{opt.label}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

/**
 * Setting row — 标题+描述左侧，控件右侧。
 * 无边框无圆角无背景色，纯行。有 icon 时标题与描述同一列对齐。
 */
export interface SettingRowProps {
  label: React.ReactNode
  description?: React.ReactNode
  icon?: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  className?: string
  disabled?: boolean
  searchContext?: string
}

export function SettingRow({
  label,
  description,
  icon,
  children,
  onClick,
  className,
  disabled,
  searchContext,
}: SettingRowProps) {
  return (
    <div
      data-setting-label={typeof label === 'string' ? label : undefined}
      data-setting-context={searchContext}
      data-setting-row
      className={cn(
        // 卡片内的一行：内边距 + 上分隔线（首行不画）。
        // 行自带边框而非由容器 divide-y，是因为 SettingRow/SettingField 是
        // 独立组件，容器拿不到它们的数量。
        'w-full border-t border-border-200/40 px-4 py-3 first:border-t-0',
        onClick && !disabled ? 'cursor-pointer' : '',
        disabled ? 'opacity-55' : '',
        className,
      )}
      onClick={disabled ? undefined : onClick}
    >
      {/* 控件对「标题 + 描述」整块垂直居中，而不是只对齐标题那一行。
          描述换行成多行时（如设置同步、多服务器模式），只对齐标题会让
          开关显得偏高、与整行的视觉中心脱节。 */}
      <div className="flex items-center justify-between gap-x-6 min-h-[20px]">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          {icon && <span className="mt-0.5 text-text-400 shrink-0">{icon}</span>}
          <div className="min-w-0">
            <div className="text-ui-base font-medium text-text-100 leading-snug">{label}</div>
            {description && (
              <div data-setting-desc className="text-ui-sm text-text-300 leading-relaxed mt-0.5">
                {description}
              </div>
            )}
          </div>
        </div>
        <SettingLabelContext.Provider value={typeof label === 'string' ? label : undefined}>
          <div data-setting-control className="shrink-0 flex items-center self-center">
            {children}
          </div>
        </SettingLabelContext.Provider>
      </div>
    </div>
  )
}

/**
 * Setting field — 标题/描述在上，控件在下（分段器、滑块等）。
 * 有 actions 时与标题同一行居中，描述单独下一行。
 */
export function SettingField({
  label,
  description,
  actions,
  children,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-setting-label={typeof label === 'string' ? label : undefined}
      data-setting-field
      className={cn('border-t border-border-200/40 px-4 py-3 first:border-t-0', className)}
    >
      <div className="flex items-start justify-between gap-3 min-h-[20px]">
        <div className="min-w-0">
          <div className="text-ui-base font-medium text-text-100 leading-snug">{label}</div>
          {description && (
            <div data-setting-desc className="text-ui-sm text-text-300 leading-relaxed mt-0.5">
              {description}
            </div>
          )}
        </div>
        {/* actions 与「标题 + 描述」整块垂直居中，描述换行时不会停在偏上位置 */}
        {actions && <div className="shrink-0 flex items-center gap-1.5 self-center">{actions}</div>}
      </div>
      <div className="mt-2.5">{children}</div>
    </div>
  )
}

/**
 * Settings section — 唯一的分组容器。
 * 标题行（标题 + 可选描述 + 可选 actions）+ 卡片内容。
 *
 * 内容区是卡片（淡底 + 圆角 + 边框），组内各行之间由 CardRows 画细分隔线。
 * 加卡片是为了给分组一个明确的视觉边界：此前标题、描述、各行都是纯文字堆叠，
 * 分组之间只靠空白区分，长页面里找不到结构的起止。
 */
export interface SettingsSectionProps {
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  /**
   * 内容区不加卡片外壳。
   *
   * 默认（false）会给内容套一层「淡底 + 圆角 + 边框」的卡片，配合
   * SettingRow / SettingField 自带的 py-3 与上分隔线，形成截图那种
   * 「分组卡片 + 组内分隔线」的结构。
   *
   * 少数 section 内部是自定义布局（多行键值对、按钮组、告警块等），
   * 自带内边距与分隔线，再套卡片会双重留白，这些用 plain 明确跳过。
   */
  plain?: boolean
}

/**
 * 卡片内的一行：给非 SettingRow / SettingField 的自定义内容用。
 * 与那两者保持相同的内边距与分隔线，使卡片内各行对齐。
 */
export function SettingsCardRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('border-t border-border-200/40 px-4 py-3 first:border-t-0', className)}>
      {children}
    </div>
  )
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
  plain = false,
}: SettingsSectionProps) {
  return (
    <section data-setting-label={title} className={cn('mb-8 last:mb-0', className)}>
      <div className="mb-3">
        {/* 标题与 actions 同一行垂直居中，描述单独在下一行，避免按钮和标题错位 */}
        <div className="flex items-center justify-between gap-3 min-h-[28px]">
          <h2 className="min-w-0 text-ui-base font-semibold text-text-100 leading-snug">{title}</h2>
          {actions && <div className="shrink-0 flex items-center gap-1.5">{actions}</div>}
        </div>
        {description && (
          <p data-setting-desc className="text-ui-sm text-text-300 mt-1 leading-relaxed max-w-[52ch]">
            {description}
          </p>
        )}
      </div>
      {plain ? (
        <div className="flex flex-col gap-3">{children}</div>
      ) : (
        <div className="flex flex-col overflow-hidden rounded-xl border border-border-200/50 bg-bg-100/40">
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * Settings subgroup — section 内的子分组，用于聚合相关设置项。
 * 淡背景圆角，无边框，不与外层 section 形成嵌套视觉。
 */
export function SettingsSubgroup({
  title,
  description,
  children,
  className,
}: {
  title?: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div data-setting-label={title} className={className || ''}>
      {title && (
        <div className="mb-2.5 px-0.5">
          <div className="text-ui-caption font-medium text-text-100">{title}</div>
          {description && (
            <div data-setting-desc className="text-ui-sm text-text-400 mt-0.5 leading-relaxed">
              {description}
            </div>
          )}
        </div>
      )}
      <div className="space-y-2.5">{children}</div>
    </div>
  )
}
