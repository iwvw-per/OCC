// ============================================
// 对话内容列宽
//
// 对话消息列与输入框必须使用同一组宽度/内边距，否则输入框比消息列宽，
// 视觉上「错位」；调节宽窄时两者也要一起变。
//
// 宽度轴收敛为一个 CSS 变量 --chat-content-width，由 ChatWidthControls
// 在对话容器上发布：用户拖拽偏好优先，否则按可用列宽自适应。消息行、输入框
// 以及贴在输入框上的两个对话框都消费同一个变量，拖拽时无需任何 JS 同步。
// ============================================

/** 共享宽度轴：定义在对话容器上，子节点全部继承 */
export const CHAT_CONTENT_WIDTH_VAR = '--chat-content-width'

/** 未发布变量时的兜底宽度（分屏/首帧） */
export const CHAT_CONTENT_WIDTH_FALLBACK = '60rem'

/** 拖拽下限（px） */
export const CHAT_CONTENT_MIN = 640

/** 无偏好时的自适应下限与上限（px） */
export const CHAT_CONTENT_ADAPTIVE_MIN = 680
export const CHAT_CONTENT_ADAPTIVE_MAX = 920

/** 两侧为拖拽手柄预留的总宽度（px），各 24px */
export const CHAT_CONTENT_EDGE_BUDGET = 48

/** 消费轴的最大宽度内联样式，供消息列 / 输入框 / 对话框统一使用 */
export const chatContentMaxWidthStyle = {
  maxWidth: `var(${CHAT_CONTENT_WIDTH_VAR}, ${CHAT_CONTENT_WIDTH_FALLBACK})`,
} as const

/**
 * 解析在当前列宽下应显示的宽度。
 *
 * 有偏好时钳制到 [CHAT_CONTENT_MIN, column - EDGE_BUDGET]；否则按列宽自适应
 * clamp(680, column*0.64, 920)。窗口变化只影响显示值，不覆写已存偏好。
 */
export function resolveChatContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CHAT_CONTENT_MIN, columnWidth - CHAT_CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CHAT_CONTENT_MIN), max)
  return Math.max(CHAT_CONTENT_ADAPTIVE_MIN, Math.min(columnWidth * 0.64, CHAT_CONTENT_ADAPTIVE_MAX))
}

/**
 * 拖拽结束时把「拖拽产生的显示宽度」换算成要持久化的偏好宽度。
 *
 * 关键：不能直接把显示宽度存成偏好。窗口变窄时显示值被钳制到
 * [CHAT_CONTENT_MIN, column - EDGE_BUDGET]，若把钳制后的值存进去，用户在窄窗口上的
 * 任何一次微调都会把大窗口上设的更宽偏好永久改小，回到大窗口也恢复不回来。
 *
 * 这里按「显示位移」换算偏好：偏好变化量 = 钳制后显示宽度 - 拖拽起始显示宽度。
 *  - 正常窗口（未钳制）：偏好 = 起始偏好 + 指针位移，与原行为一致；
 *  - 窄窗口（已钳制）：向外拖被窗口上限挡住，偏好不变；向内拖才按位移缩小。
 * 因此窄窗口上的轻微拖动不会再摧毁大窗口的宽偏好。
 */
export function preferenceFromDrag(
  columnWidth: number,
  startPreference: number,
  startDisplay: number,
  rawDisplay: number,
): number {
  const clampedDisplay = resolveChatContentWidth(columnWidth, rawDisplay)
  return Math.max(CHAT_CONTENT_MIN, startPreference + (clampedDisplay - startDisplay))
}

/** 消息列的水平内边距类（紧凑视图收窄） */
export function getContentPaddingClass(isCompact: boolean): string {
  return isCompact ? 'px-3' : 'px-5'
}
