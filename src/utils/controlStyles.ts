// ============================================
// 按钮类控件的共享样式词汇
//
// `interactive.*` 负责交互态（hover/按下/焦点），本文件负责更上层的
// 「控件观感」：不同尺寸、不同语义下的盒子（高度、内边距、圆角、图标尺寸）。
//
// 约定：
// - 业务代码（尤其设置面板、面板工具栏）一律从这里取尺寸，不再手写 h-*/px-*；
// - 需要改变全站控件密度时只改这里；
// - 与 interactive 一样，调用点不要覆盖这里给出的交互态。
// ============================================

export type ControlSize = 'xs' | 'sm' | 'md'

/** 行内小按钮（设置项右侧、卡片角落的操作）。 */
export const controlSize: Record<ControlSize, string> = {
  xs: 'h-6 px-1.5 text-[length:var(--fs-xxs)] rounded-md gap-1',
  sm: 'h-7 px-2 text-[length:var(--fs-xs)] rounded-md gap-1.5',
  md: 'h-8 px-3 text-[length:var(--fs-sm)] rounded-lg gap-2',
}

/** 纯图标按钮的方形盒子（与 controlSize 对齐高度）。 */
export const iconSize: Record<ControlSize, string> = {
  xs: 'h-6 w-6 rounded-md',
  sm: 'h-7 w-7 rounded-md',
  md: 'h-8 w-8 rounded-lg',
}

export type ControlTone = 'default' | 'accent' | 'danger' | 'ghost' | 'subtle'

/** 语义色（不含交互态，交互态由 interactive 提供）。 */
export const controlTone: Record<ControlTone, string> = {
  default: 'text-text-200 border border-border-200/70 bg-bg-100',
  accent: 'text-text-100 border border-accent-main-100/40 bg-accent-main-100/10',
  danger: 'text-danger-100 border border-danger-100/30 bg-bg-100',
  ghost: 'text-text-300 border border-transparent bg-transparent',
  subtle: 'text-text-300 border border-transparent bg-bg-200/50',
}

/** 面板工具栏里「一行图标」的统一容器（等高、等间距）。 */
export const toolbarRow = 'flex items-center gap-1'
