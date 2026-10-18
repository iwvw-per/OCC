// ============================================
// useSessionStatsFor — 指定 session 的统计
// ============================================
//
// 与 useSessionStats 的区别：后者只服务全局聚焦 pane，这里显式接收
// sessionId，供工作状态面板在分屏 / 非聚焦会话下也能读对数据。

import { useCallback, useRef, useSyncExternalStore } from 'react'
import { messageStore } from '../store/messageStore'
import { computeSessionStatsCached, isSameSessionStats } from './sessionStatsCompute'
import type { SessionStats } from './sessionStatsTypes'

/** 流式时最多每 200ms 推一次；结束/非流式立即更新 */
const STREAMING_STATS_INTERVAL_MS = 200

export function useSessionStatsFor(sessionId: string | null, contextLimit: number): SessionStats {
  const cacheRef = useRef<SessionStats | null>(null)

  const getSnapshot = useCallback((): SessionStats => {
    const messages = messageStore.getVisibleMessages(sessionId)
    const next = computeSessionStatsCached(
      messages,
      contextLimit,
      messageStore.getCompactionUsage(sessionId),
      messageStore.getSessionUsage(sessionId),
    )
    const prev = cacheRef.current
    if (prev && isSameSessionStats(prev, next)) return prev
    cacheRef.current = next
    return next
  }, [sessionId, contextLimit])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!sessionId) return () => {}

      let timer: ReturnType<typeof setTimeout> | null = null

      const schedule = () => {
        if (!messageStore.getIsStreaming(sessionId)) {
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          onStoreChange()
          return
        }
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          onStoreChange()
        }, STREAMING_STATS_INTERVAL_MS)
      }

      const unsubscribe = messageStore.subscribeSession(sessionId, schedule)
      return () => {
        unsubscribe()
        if (timer) clearTimeout(timer)
      }
    },
    [sessionId],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
