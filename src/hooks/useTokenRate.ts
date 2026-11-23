// ============================================
// useTokenRate - 最后一轮对话的输出速率（tok/s）
//
// 口径与官方 opencode TUI 一致（packages/tui/src/routes/session/rows.ts
// 的 turnTokensPerSecond）：
//
//     速度 = Σ(output + reasoning) / Σ(streamed − created)
//
// 按**整轮**聚合而不是只看最后一条 assistant 消息：一轮里模型可能被工具
// 打断多次（step），每个 step 都有各自的生成窗口与 token 计数。只看最后一条
// 会把前面几步的 token 丢掉，速度虚高。
//
// 分母用 `streamed`（模型吐完的时刻）而非 `completed`（工具收尾完成）。
// 这一点很关键：v2 的 text part 完全没有 time 字段，早先按 part 时间窗口算，
// 永远拿不到样本，实际一直在用「整条消息时长」兜底 —— 那个口径把 TTFT 和
// 工具执行都算成生成时间，数值系统性偏低。
//
// 流式进行中时，当前这条消息还没有 streamed（尚未吐完），
// 保持显示上一轮的值；轮到它完成、streamed 落点后自动刷新。
// ============================================

import { useEffect, useState } from 'react'
import { messageStore } from '../store'
import { splitTurns, turnThroughput } from './stepThroughput'

/** 流式期间速率最多每 200ms 重算一次(整轮聚合,无需跟每帧 token) */
const TOKEN_RATE_STREAMING_INTERVAL_MS = 200

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

    let timer: ReturnType<typeof setTimeout> | null = null

    const compute = () => {
      const messages = messageStore.getVisibleMessages(sessionId)
      const turns = splitTurns(messages)

      // 正在生成的那一轮里，最后一条 assistant 还没有 streamed，其样本为 null，
      // 聚合结果会缺样本 → 跳过它，继续显示上一轮的稳定值。
      for (let i = turns.length - 1; i >= 0; i--) {
        const rate = turnThroughput(turns[i])
        if (rate == null) continue

        setState(prev => (prev.hasData && prev.tokensPerSec === rate ? prev : { tokensPerSec: rate, hasData: true }))
        return
      }
      setState(prev => (prev.hasData || prev.tokensPerSec !== 0 ? { tokensPerSec: 0, hasData: false } : prev))
    }

    // 流式期间 store 每帧通知一次,但速率是整轮聚合,200ms 粒度足够;
    // 非流式(结束/切换会话)立即结算,避免结束时数字滞后。
    const update = () => {
      if (!messageStore.getIsStreaming(sessionId)) {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        compute()
        return
      }
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        compute()
      }, TOKEN_RATE_STREAMING_INTERVAL_MS)
    }

    const unsubscribe = messageStore.subscribeSession(sessionId, update)
    update()
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [sessionId])

  return state
}
