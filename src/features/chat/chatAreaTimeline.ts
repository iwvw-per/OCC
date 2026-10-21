// ============================================
// ChatArea 的时间线估算与过程壳统计
//
// 虚拟滚动依赖「行高估算」：过程壳（process shell）在流式进行中默认展开、
// 结束后默认折叠，估算必须与实际渲染高度一致，否则刷新时会先按其估算高度
// 显示再回弹（120 → 36 的假跳动）。
// ============================================

import type { Message } from '../../types/message'
import type { ProcessTimelineItem } from './chatPageModel'


export const ROW_ESTIMATE = 60
export const PROCESS_SHELL_HEADER = 36

export type ProcessShellChild = { message: Message; processContentScope: 'process' | 'inline' }

/** 过程壳 header 统计：工具调用数（折叠时展示，避免展开才知道规模） */
export function processStepCount(children: ProcessShellChild[]): number {
  let count = 0
  for (const child of children) {
    // 压缩态 reasoning/工具输出已清空，用压缩前记录的统计补齐
    if (child.message.isCompressed && child.message.compressedStats) {
      count += child.message.compressedStats.stepCount
      continue
    }
    for (const part of child.message.content) {
      if (part.type === 'tool') count++
    }
  }
  return count
}

/** 过程壳 header 统计：思考段数 */
export function processReasoningCount(children: ProcessShellChild[]): number {
  let count = 0
  for (const child of children) {
    if (child.message.isCompressed && child.message.compressedStats) {
      count += child.message.compressedStats.reasoningCount
      continue
    }
    for (const part of child.message.content) {
      if (part.type === 'reasoning' && part.text?.trim()) count++
    }
  }
  return count
}

export function estimateTimelineItemSize(item: ProcessTimelineItem | undefined): number {
  if (!item) return ROW_ESTIMATE
  if (item.kind === 'message') return ROW_ESTIMATE
  // 进行中默认展开：header + 壳内消息（空回合至少占 header）
  if (item.isActive) {
    const body = Math.max(item.children.length, 1) * ROW_ESTIMATE
    return PROCESS_SHELL_HEADER + body
  }
  // 结束后默认折叠：只估 header + 壳外 final，避免刷新时 120→36 的假高度再回弹
  return PROCESS_SHELL_HEADER + (item.finalMessage ? ROW_ESTIMATE : 0)
}

/** 会话级渲染缓存的 key（过程壳开关会改变行结构，必须分开缓存） */
export function sessionCacheKey(sessionId: string, processCollapseEnabled: boolean): string {
  return `${sessionId}:${processCollapseEnabled ? 'process' : 'flat'}`
}

/**
 * 虚拟行的相等判定。
 *
 * 抽成纯函数便于单测：滚动时 react-virtual 会频繁回写 start/size，若 size
 * 参与比较，每次测量都会把整行重新渲染一遍（长会话滚动卡顿的主因之一）。
 */
export interface RowComparable {
  virtualIndex: number
  virtualStart: number
  item: unknown
  paddingClass: string
  rowYClass: string
  canUndo: boolean | undefined
  allowStreamingLayoutAnimation: boolean
  sessionId: string | null | undefined
  refs: ReadonlyArray<unknown>
}

export function areRowPropsEqual(prev: RowComparable, next: RowComparable): boolean {
  if (prev.virtualIndex !== next.virtualIndex) return false
  if (prev.virtualStart !== next.virtualStart) return false
  if (prev.item !== next.item) return false
  if (prev.paddingClass !== next.paddingClass) return false
  if (prev.rowYClass !== next.rowYClass) return false
  if (prev.canUndo !== next.canUndo) return false
  if (prev.allowStreamingLayoutAnimation !== next.allowStreamingLayoutAnimation) return false
  if (prev.sessionId !== next.sessionId) return false
  if (prev.refs.length !== next.refs.length) return false
  return prev.refs.every((ref, index) => ref === next.refs[index])
}
