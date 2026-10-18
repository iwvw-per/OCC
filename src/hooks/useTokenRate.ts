// ============================================
// useTokenRate - 最后一轮对话的输出速率（tok/s）
//
// 取最后一条「已完成」助手消息，按单个请求的实际输出速度计算：
//   tokens.output / 合并后的文本 part 时间窗口
// 只统计输出 token，不含 reasoning（推理另计，混进来会让这个数字反映思考速度
// 而不是输出速度）；分母也只算文本 part 的生成时间，排除推理与工具调用等待。
// part 缺少时间窗口时退回整条消息时长。SSE 流没有逐 chunk token 计数，
// 当前轮生成期间保持显示上一轮的值，完成后随 message.updated 自动刷新。
// ============================================

import { useEffect, useState } from 'react'
import { messageStore } from '../store'
import { messageCompletedAt } from '../store/messagePartMerge'

export interface TokenRateState {
  tokensPerSec: number
  /** 是否存在可计算的已完成轮次 */
  hasData: boolean
}

export function useTokenRate(sessionId: string | null): TokenRateState {
  const [state, setState] = useState<TokenRateState>({ tokensPerSec: 0, hasData: false })

  useEffect(() => {
    if (!sessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 无会话时重置为初始值
      setState({ tokensPerSec: 0, hasData: false })
      return
    }

    const update = () => {
      const messages = messageStore.getVisibleMessages(sessionId)
      // 从最新往回找最后一条已完成（有结束时间与 token 计数）的助手消息；
      // 正在流式生成的那条还没有 completed，天然跳过，保持显示上一轮的值
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.info.role !== 'assistant') continue
        const info = message.info
        const created = info.time?.created
        const completed = messageCompletedAt(message)
        if (!created || !completed || completed <= created) continue

        // 速率 = 输出 token / 文本生成时间：只算 text part 的时间窗口，
        // 不含 reasoning（推理另计）与工具调用等待——混进来会把输出速度摊薄
        const tokens = info.tokens?.output ?? 0
        const intervals: { start: number; end: number }[] = []
        for (const part of message.content) {
          if (part.type !== 'text') continue
          const start = part.time?.start
          const end = part.time?.end
          if (!start || !end || end <= start) continue
          intervals.push({ start, end })
        }

        let tokensPerSec = 0
        if (intervals.length > 0) {
          intervals.sort((a, b) => a.start - b.start)
          let totalMs = 0
          let segmentStart = intervals[0].start
          let segmentEnd = intervals[0].end
          for (let j = 1; j < intervals.length; j++) {
            const interval = intervals[j]
            if (interval.start <= segmentEnd) {
              segmentEnd = Math.max(segmentEnd, interval.end)
            } else {
              totalMs += segmentEnd - segmentStart
              segmentStart = interval.start
              segmentEnd = interval.end
            }
          }
          totalMs += segmentEnd - segmentStart
          if (totalMs > 0) tokensPerSec = tokens / (totalMs / 1000)
        } else {
          // part 缺少时间窗口时的兜底：整条消息时长
          tokensPerSec = tokens / ((completed - created) / 1000)
        }

        // 订阅挂在整条 session 上（流式期间每帧触发；messageStore 已按 RAF 批量）。
        // 但流式增量不改变「最后一条已完成消息」的结果，值未变时不 setState，
        // 避免每帧一次无意义的重渲染。
        setState(prev => (prev.hasData && prev.tokensPerSec === tokensPerSec ? prev : { tokensPerSec, hasData: true }))
        return
      }
      setState(prev => (prev.hasData || prev.tokensPerSec !== 0 ? { tokensPerSec: 0, hasData: false } : prev))
    }

    const unsubscribe = messageStore.subscribeSession(sessionId, update)
    update()
    return unsubscribe
  }, [sessionId])

  return state
}
