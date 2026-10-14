// ============================================
// messageToolSettle — 工具 part 落定与消息收尾的纯函数
// ============================================
//
// 从 messageStore 抽出的无副作用逻辑：会话结束/工具事件到达时，把仍处于
// running/pending 的 tool part 落定，避免工具卡片永久转圈。这些转换决定了
// 「工具是否卡住」「消息是否定稿」，此前只能经由整个 store 间接测试。

import type { Message, Part, ToolPart } from '../types/message'

/** 单条消息计费上限：超长消息按此截断计费，避免一条巨消息把整段预算吃光。 */
export const MAX_SINGLE_MESSAGE_BYTES = 2 * 1024 * 1024

/**
 * 估算单条消息的内存占用（按序列化长度近似，不精确但足够做预算）。
 *
 * 用 JSON.stringify 的长度而非真实堆占用：堆占用无法廉价测量，且这里只需要
 * 一个与体积强相关的可比量。超长消息按 MAX_SINGLE_MESSAGE_BYTES 截断计费。
 */
export function estimateMessageBytes(message: Message): number {
  try {
    const size = JSON.stringify(message).length
    return Math.min(size, MAX_SINGLE_MESSAGE_BYTES)
  } catch {
    // 存在循环引用等无法序列化的情况：给一个保守的固定估算，避免整段被误裁。
    return 4096
  }
}

/**
 * 计算需要从最旧端裁掉多少条，使消息同时满足条数与体积预算。
 *
 * 只返回裁剪条数，不改动状态。体积从最新向最旧累积，超过预算时把更旧的一并裁掉；
 * 条数超限时至少裁到 maxCount。返回 0 表示无需裁剪。
 */
export function computeTrimCount(
  messages: readonly Message[],
  maxBytes: number,
  maxCount: number,
): number {
  const total = messages.length
  if (total === 0) return 0

  if (total <= maxCount) {
    let bytes = 0
    for (let i = total - 1; i >= 0; i--) {
      bytes += estimateMessageBytes(messages[i])
      if (bytes > maxBytes) return i + 1
    }
    return 0
  }

  let bytes = 0
  let cut = total - maxCount
  for (let i = total - 1; i >= cut; i--) {
    bytes += estimateMessageBytes(messages[i])
    if (bytes > maxBytes) {
      cut = i + 1
      break
    }
  }
  return cut
}


/** part 是否处于未落定状态（running/pending） */
export function isUnsettledToolPart(part: Part): part is ToolPart {
  return part.type === 'tool' && (part.state.status === 'running' || part.state.status === 'pending')
}

/**
 * 把仍处于 running/pending 的工具 part 落定为 interrupted。
 * 用于会话已结束（idle/error）但仍悬空的工具。返回新的 messages 与是否有变更。
 */
export function reconcileInFlightTools(
  messages: Message[],
  now: number,
): { messages: Message[]; changed: boolean } {
  let changed = false
  const next = messages.map(message => {
    let partsChanged = false
    const content = message.content.map(part => {
      if (!isUnsettledToolPart(part)) return part
      partsChanged = true
      changed = true
      const start = part.state.time?.start ?? now
      return {
        ...part,
        state: {
          ...part.state,
          status: 'interrupted' as const,
          metadata: { ...(part.state.metadata ?? {}), interrupted: true },
          time: { ...(part.state.time ?? {}), start, end: now },
        },
      } as ToolPart
    })
    return partsChanged ? { ...message, content } : message
  })
  return { messages: changed ? next : messages, changed }
}

export interface ToolSettleOutcome {
  status: 'completed' | 'error'
  output?: string
  error?: string
  /** 错误时的兜底文案（调用方注入，保持本模块无 i18n 依赖） */
  errorFallback: string
}

/**
 * 按 callID 把某个工具 part 落定为 completed/error。
 * 返回新的 messages 与是否有变更。
 */
export function settleToolByCallID(
  messages: Message[],
  callID: string,
  outcome: ToolSettleOutcome,
  now: number,
): { messages: Message[]; changed: boolean } {
  let changed = false
  const next = messages.map(message => {
    let partsChanged = false
    const content = message.content.map(part => {
      if (part.type !== 'tool' || part.callID !== callID) return part
      if (!isUnsettledToolPart(part)) return part
      partsChanged = true
      changed = true
      const start = part.state.time?.start ?? now
      if (outcome.status === 'error') {
        return {
          ...part,
          state: {
            ...part.state,
            status: 'error' as const,
            error: outcome.error ?? part.state.error ?? outcome.errorFallback,
            time: { ...(part.state.time ?? {}), start, end: now },
          },
        } as ToolPart
      }
      return {
        ...part,
        state: {
          ...part.state,
          status: 'completed' as const,
          output: outcome.output ?? part.state.output ?? '',
          time: { ...(part.state.time ?? {}), start, end: now },
        },
      } as ToolPart
    })
    return partsChanged ? { ...message, content } : message
  })
  return { messages: changed ? next : messages, changed }
}

/**
 * 会话结束时的消息收尾：清 streaming 标记、给未完成消息补 completed。
 * 返回新的 messages 与是否有变更。
 */
export function finalizeStreamingMessages(
  messages: Message[],
  completedAt: number,
): { messages: Message[]; changed: boolean } {
  let changed = false
  const next = messages.map(m => {
    if (!m.isStreaming) return m
    changed = true
    return {
      ...m,
      isStreaming: false,
      info: {
        ...m.info,
        time: {
          ...m.info.time,
          completed: m.info.time.completed ?? completedAt,
        },
      },
    }
  })
  return { messages: changed ? next : messages, changed }
}
