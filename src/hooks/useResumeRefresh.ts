// ============================================
// useResumeRefresh — 移动端从后台返回时的补拉与反馈
// ============================================
//
// 移动端（iOS/Android）有「墓碑」机制：切到后台后 WebView 被冻结，JS 停止执行，
// SSE 事件不再被处理。返回前台时：
//
//   1. 长连接靠心跳仍显示存活，**不会触发 onReconnected**（连接真的没断，
//      只是没人消费事件），所以已有的「重连补拉」覆盖不到这个场景；
//   2. 冻结期间服务端继续产出消息（agent 还在跑），这些消息只在 SSE 里推过，
//      不落前端内存；
//   3. 于是界面停在离开时那一刻，用户要等很久才「一股脑刷新」。
//
// 这个 hook 负责：回到前台时判断「是否离开得够久」，主动补拉当前会话，
// 并把「正在更新」的状态暴露给 UI，避免用户面对冻结画面不知所措。
//
// 为什么按「离开时长」而不是无条件刷新：桌面端 alt-tab 很频繁，每次切回来
// 都发一次全量请求既费流量又会让滚动位置跳动。只有离开超过阈值才值得补。

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 离开超过这个时长才补拉。
 *
 * 取 30s：短于此的切换通常没产生多少新消息，而移动端切后台几十秒是常态
 * （看通知、回消息）。再短会让频繁切换的桌面用户反复触发。
 */
const RESUME_REFRESH_THRESHOLD_MS = 30_000

export interface ResumeRefreshState {
  /** 正在补拉（UI 可据此显示「正在更新」） */
  refreshing: boolean
  /** 本次补拉拉到了新消息 */
  updated: boolean
}

export interface ResumeRefreshResult extends ResumeRefreshState {
  /** 清除「已更新」提示（UI 展示几秒后调用） */
  clearUpdated: () => void
}

export interface UseResumeRefreshOptions {
  /** 补拉当前会话；返回本次是否带来了新内容 */
  onResume: () => Promise<boolean> | boolean
  /** 是否启用（无会话时关掉，避免空跑） */
  enabled?: boolean
  /** 覆盖默认阈值（测试用） */
  thresholdMs?: number
}

/**
 * 监听「从后台返回」并触发一次补拉。
 *
 * 只监听 `visibilitychange` → visible：`focus` 事件在桌面端切窗口时也会触发，
 * 而我们要的正是「长时间离开后回来」这个语义，visibility 更准确。
 */
export function useResumeRefresh({
  onResume,
  enabled = true,
  thresholdMs = RESUME_REFRESH_THRESHOLD_MS,
}: UseResumeRefreshOptions): ResumeRefreshResult {
  const [state, setState] = useState<ResumeRefreshState>({ refreshing: false, updated: false })
  /** 页面隐藏的时刻；0 表示当前在前台 */
  const hiddenAtRef = useRef(0)
  /** 补拉序号：避免并发补拉互相覆盖 */
  const runIdRef = useRef(0)
  /** 用 ref 持有最新回调，避免它变化导致重新注册监听 */
  const onResumeRef = useRef(onResume)
  // 在 effect 里同步而不是渲染期赋值：渲染期写 ref 违反 react-hooks/refs，
  // 且在并发渲染下可能写入「未提交」的值。
  useEffect(() => {
    onResumeRef.current = onResume
  }, [onResume])

  /** 清除「已更新」提示（UI 展示几秒后调用） */
  const clearUpdated = useCallback(() => {
    setState(prev => (prev.updated ? { ...prev, updated: false } : prev))
  }, [])

  useEffect(() => {
    if (!enabled) return
    if (typeof document === 'undefined') return

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now()
        return
      }

      // 回到前台
      const hiddenAt = hiddenAtRef.current
      hiddenAtRef.current = 0
      if (hiddenAt === 0) return
      // 离开太短：不值得补拉（桌面频繁切窗口）
      if (Date.now() - hiddenAt < thresholdMs) return

      const runId = ++runIdRef.current
      setState({ refreshing: true, updated: false })

      void (async () => {
        let updated = false
        try {
          updated = await onResumeRef.current()
        } catch {
          // 补拉失败不打扰用户：SSE 若恢复会自然补齐，且下次回前台还会再试
          updated = false
        }
        if (runId !== runIdRef.current) return
        setState({ refreshing: false, updated })
      })()
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [enabled, thresholdMs])

  return { ...state, clearUpdated }
}

/** 供 UI 复用的「已更新」提示停留时长 */
export const RESUME_UPDATED_HINT_MS = 4000
