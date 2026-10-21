// ============================================
// 输入框的尺寸预算与高度常量
//
// 从 InputBox.tsx 抽出。输入框要同时容纳：工具栏、附件轨道、textarea、
// 底部提示行，并在窄屏/收起态下让位。这里集中给出各类高度约束，
// 让「长什么样」和「占多少像素」分开维护。
// ============================================

export const TEXTAREA_MIN_HEIGHT = 24
export const TEXTAREA_VERTICAL_CHROME = 24
export const INPUT_TOOLBAR_FALLBACK_HEIGHT = 36
export const INPUT_FOOTER_FALLBACK_HEIGHT = 32
export const COMPOSER_MIN_HEIGHT = 144
export const COMPOSER_DESKTOP_MAX_HEIGHT = 420
export const COMPOSER_COMPACT_MAX_HEIGHT = 320

/** 收起态药丸高度（px）：与 ChatFab 收起态等高（--chat-fab-collapsed-size = 36px），
 * 两者并排时视觉上是一组。内容 28px + 上下 padding 3px + 上下边框 1px。 */
export const COLLAPSED_BOX_HEIGHT = 36
/** 收起态药丸宽度与圆角。必须由 JS 在打开过渡（data-morphing）的同一帧写入，
 * 不能放 CSS [data-collapsed]：否则中间任何一次布局读取触发样式重算时，宽度会在
 * 过渡尚未 armed 时被定型，表现为横向瞬间收窄、纵向才走动画（快速滚动时明显）。 */
export const COLLAPSED_BOX_WIDTH = 132
export const COLLAPSED_BOX_RADIUS = 24
/** 变形收尾的兜底时长：真正的收尾信号是 transitionend，这个定时器只防
 * 「几何值未变、没有过渡」时状态卡死。必须明显大于 --chat-morph-dur(520ms)，
 * 否则主线程繁忙时会在过渡完成前摘掉 data-morphing，几何直接瞬跳。 */
export const MORPH_FALLBACK_MS = 900

export const MAX_DROPPED_FILE_SIZE = 20 * 1024 * 1024
export const MAX_DROPPED_FILE_SIZE_LABEL = `${MAX_DROPPED_FILE_SIZE / (1024 * 1024)}MB`

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** pane 可视高度：优先取 pane 根节点，退化为窗口高度。 */
export function getComposerPaneHeight(anchor: HTMLElement | null): number {
  const paneRoot = anchor?.closest<HTMLElement>('[data-chat-pane-root]')
  const paneHeight = paneRoot?.getBoundingClientRect().height
  if (paneHeight && paneHeight > 0) return paneHeight
  return window.innerHeight || 800
}

/**
 * 输入区最大高度：按 pane 高度的比例，同时受硬上限与「至少给对话留 96px」约束。
 * 紧凑模式（分屏/窄屏）比例略高，因为此时对话区本身更矮。
 */
export function getComposerMaxHeight(paneHeight: number, isCompact: boolean): number {
  const ratio = isCompact ? 0.44 : 0.4
  const hardMax = isCompact ? COMPOSER_COMPACT_MAX_HEIGHT : COMPOSER_DESKTOP_MAX_HEIGHT
  const availableMax = Math.max(COMPOSER_MIN_HEIGHT, paneHeight - 96)
  return clamp(Math.floor(paneHeight * ratio), COMPOSER_MIN_HEIGHT, Math.min(hardMax, availableMax))
}
