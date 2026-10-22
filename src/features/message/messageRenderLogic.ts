// ============================================
// 消息渲染纯逻辑
//
// 与 MessageRenderer.tsx 分离：该文件只导出组件，本文件放类型与纯函数，
// 满足 Fast Refresh 对「组件文件只导出组件」的要求。
//
// v2 content[] 模型下只有 text / reasoning / tool 三种，没有 v1 的
// step-start/step-finish/snapshot/patch/subtask 等基础设施 part，
// 因此分组逻辑只做「连续工具折叠为 tool-group」与「尾部最终 text 拆分」。
// ============================================

import {
  isToolContent,
  isVisibleReasoningContent,
  isVisibleTextContent,
  type Message,
  type Content,
  type ToolContent,
} from '../../types/message'
import { messageCompletedAt } from '../../store/messagePartMerge'

/**
 * 过程内容范围：
 * - all: 完整渲染
 * - process: 只渲染过程部分
 * - final: 只渲染尾部最终 text
 * - inline: 完整渲染（已在外层过程块内）
 */
export type ProcessContentScope = 'all' | 'process' | 'final' | 'inline'

export type RenderItem =
  | { type: 'single'; content: Content }
  | { type: 'tool-group'; contents: ToolContent[] }

export type ProcessSplit = {
  processItems: RenderItem[]
  finalItems: RenderItem[]
  hasProcess: boolean
  hasFinal: boolean
}

/**
 * `groupContentsForRender` 的结果缓存。
 *
 * 同一个 `content` 数组在一次渲染里会被问很多次：`messageHasProcessContent`、
 * `messageHasFinalContent`、`buildProcessTimeline`、`AssistantMessageView` 的
 * useMemo 各算一遍。长会话（实测 7000 条消息）里这会把分组工作重复十几倍。
 *
 * 用 WeakMap 以 content 数组为键：content 是不可变快照（store 每帧只在脏消息上
 * 换新数组），所以「同一数组 ⇒ 同一分组结果」成立，且数组被回收时缓存自动释放。
 */
const groupedContentsCache = new WeakMap<Content[], RenderItem[]>()

export function groupContentsForRender(contents: Content[]): RenderItem[] {
  const cached = groupedContentsCache.get(contents)
  if (cached) return cached
  const result = groupContentsForRenderUncached(contents)
  groupedContentsCache.set(contents, result)
  return result
}

function groupContentsForRenderUncached(contents: Content[]): RenderItem[] {
  const result: RenderItem[] = []
  let toolGroup: ToolContent[] = []

  const flushToolGroup = () => {
    if (toolGroup.length === 0) return
    result.push({ type: 'tool-group', contents: toolGroup })
    toolGroup = []
  }

  for (let i = 0; i < contents.length; i++) {
    const content = contents[i]

    // 跳过不渲染的 content
    if (content.type === 'text' && !isVisibleTextContent(content)) continue
    if (content.type === 'reasoning' && !isVisibleReasoningContent(content)) continue

    if (isToolContent(content)) {
      toolGroup.push(content)
    } else {
      flushToolGroup()
      result.push({ type: 'single', content })
    }
  }

  flushToolGroup()
  return result
}

/**
 * 把 render items 拆成「过程」和「最终回答」。
 * 最终回答 = 消息中最后一段连续 text。
 * reasoning / tool 永远进过程。
 */
export function splitProcessRenderItems(items: RenderItem[]): ProcessSplit {
  if (items.length === 0) {
    return { processItems: [], finalItems: [], hasProcess: false, hasFinal: false }
  }
  // groupContentsForRender 的结果是缓存的，同一数组会被反复拆分 → 结果也缓存
  const cached = splitRenderItemsCache.get(items)
  if (cached) return cached
  const split = splitProcessRenderItemsUncached(items)
  splitRenderItemsCache.set(items, split)
  return split
}

/** 见 splitProcessRenderItems：以（已缓存的）render items 数组为键 */
const splitRenderItemsCache = new WeakMap<RenderItem[], ProcessSplit>()

function splitProcessRenderItemsUncached(items: RenderItem[]): ProcessSplit {
  if (items.length === 0) {
    return { processItems: [], finalItems: [], hasProcess: false, hasFinal: false }
  }

  let lastTextIdx = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === 'single' && item.content.type === 'text') {
      lastTextIdx = i
      break
    }
    break
  }

  if (lastTextIdx < 0) {
    return {
      processItems: items,
      finalItems: [],
      hasProcess: items.length > 0,
      hasFinal: false,
    }
  }

  let textRunStart = lastTextIdx
  while (textRunStart > 0) {
    const prev = items[textRunStart - 1]
    if (prev.type === 'single' && prev.content.type === 'text') {
      textRunStart -= 1
      continue
    }
    break
  }

  const finalItems = items.slice(textRunStart)
  const processItems = items.slice(0, textRunStart)

  return {
    processItems,
    finalItems,
    hasProcess: processItems.length > 0,
    hasFinal: finalItems.length > 0,
  }
}

/** 流式未完成时不拆 final：中间 text 后面还可能跟 tool */
export function messageStillStreamingProcess(message: Message): boolean {
  if (message.info.role !== 'assistant') return false
  return !!message.isStreaming || messageCompletedAt(message) == null
}

/**
 * 是否有可收进过程块的内容（tool / reasoning 等，不含尾部最终 text）。
 *
 * ⭐ 轮次骨架路径：骨架里过程正文已被剥掉，助手消息只剩最终回复正文，
 * 但该轮确实有 N 步工具调用 / M 段思考（记录在 `compressedStats`）。
 * 这种情况仍应挂「已处理」折叠块 —— 否则用户既看不到过程规模，也没有
 * 展开回拉的入口，等于把「过程可以看」这个能力藏掉了。
 */
export function messageHasProcessContent(message: Message): boolean {
  if (message.info.role !== 'assistant') return false
  if (messageStillStreamingProcess(message)) return true
  const items = groupContentsForRender(message.content)
  if (items.length === 0) {
    // 纯骨架轮：内容为空，但过程规模 > 0 → 仍需折叠块承载 header 与展开入口
    return hasSkeletonProcess(message)
  }
  return splitProcessRenderItems(items).hasProcess || hasSkeletonProcess(message)
}

/** 骨架轮是否记录了过程规模（工具调用 / 思考段） */
function hasSkeletonProcess(message: Message): boolean {
  if (!message.isCompressed || !message.compressedStats) return false
  return message.compressedStats.stepCount > 0 || message.compressedStats.reasoningCount > 0
}

/** 是否有应留在折叠块外的最终 text（仅消息已结束后才拆） */
export function messageHasFinalContent(message: Message): boolean {
  if (message.info.role !== 'assistant') return false
  if (messageStillStreamingProcess(message)) return false
  return splitProcessRenderItems(groupContentsForRender(message.content)).hasFinal
}
