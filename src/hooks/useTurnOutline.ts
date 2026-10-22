// ============================================
// useTurnOutline - 独立轮次大纲的 React 绑定
// ============================================
//
// 把 turnOutlineStore 暴露成可订阅的 hook，并把当前已加载消息里的轮次
// 增量合并进 store（持久化），使侧边轴在历史未加载完时也能显示完整轮次。

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { turnOutlineStore } from '../store/turnOutlineStore'
import { extractTurnOutlineEntries, truncateOutlineLabel, type TurnOutlineEntry } from '../components/outlineIndexModel'
import type { Message } from '../types/message'

const EMPTY: TurnOutlineEntry[] = []

/** 订阅某会话的轮次大纲（自动懒加载持久化数据） */
export function useTurnOutlineEntries(serverId: string, sessionId: string | null): TurnOutlineEntry[] {
  const getSnapshot = useCallback(
    () => (sessionId ? turnOutlineStore.getSnapshot(serverId, sessionId) : EMPTY),
    [serverId, sessionId],
  )
  const subscribe = useCallback((onStoreChange: () => void) => turnOutlineStore.subscribe(onStoreChange), [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 把一批消息里的轮次合并进大纲 store。
 * 只在 messages 引用变化时执行；store 内部按 messageId 去重。
 */
export function useMergeTurnOutline(serverId: string, sessionId: string | null, messages: Message[]): void {
  useEffect(() => {
    if (!sessionId || messages.length === 0) return
    const entries = extractTurnOutlineEntries(messages)
    if (entries.length === 0) return
    turnOutlineStore.merge(serverId, sessionId, entries)
  }, [serverId, sessionId, messages])
}

// ============================================
// 后台补全完整大纲
// ============================================

/**
 * 哪些会话已经尝试过「拉全量轮次」，避免重复请求。
 *
 * 用 Map 而非 Set 记录时间：失败后允许在较长时间后重试（网络恢复、主机上线），
 * 但不能每次挂载都重打 —— 这个请求的体积可能很大（见下方说明）。
 */
const outlineFetchAt = new Map<string, number>()
/** 成功过就长期不再请求；失败则 30 分钟后再试 */
const OUTLINE_RETRY_MS = 30 * 60 * 1000

function outlineKey(serverId: string, sessionId: string): string {
  return `${serverId}::${sessionId}`
}

/**
 * 后台把会话的**全部**轮次补进大纲 store。
 *
 * 为什么需要它：侧边轴原先只从「已加载进内存的消息」推导轮次，历史没拉完时
 * 轴上就只有最近几轮，用户必须一路往上滚轴才补齐 —— 于是「点轴跳到更早的
 * 轮次」对未加载的轮次根本不存在（轴上没有那个点）。
 *
 * ⚠️ 代价（实测，150 轮的会话）：纯文本仅 24KB，但整个响应体 18MB —— v2 的
 * User 消息把内联附件（截图）以 base64 放在 `files[].data`，**没有参数能省略**
 * （X-Lightweight / X-Omit-Files / Prefer 都试过；export?sanitize 会把正文脱敏）。
 *
 * 因此：
 *   1. **绝不放在首屏路径**：延迟到应用空闲；
 *   2. **分页渐进**：每页到达立刻合并，轴马上变长，不必等 18MB 全下完；
 *   3. **可取消**：切走会话立刻 abort，不拖着大响应；
 *   4. **失败静默**，不影响任何功能（大纲只是导航辅助）。
 *
 * ⭐ 例外：走轮次骨架路径时**不需要**这条补全。
 * 骨架本身就是「整段全部轮次 + 用户正文」，`useMergeTurnOutline` 一次就能把
 * 轴上所有点补齐，因此上层会把 `enabled` 置 false，这 18MB 请求根本不会发出。
 */
export function useBackfillTurnOutline(serverId: string, sessionId: string | null, enabled = true): void {
  useEffect(() => {
    if (!sessionId || !enabled) return
    const key = outlineKey(serverId, sessionId)
    const attemptedAt = outlineFetchAt.get(key)
    if (attemptedAt !== undefined && Date.now() - attemptedAt < OUTLINE_RETRY_MS) return

    let cancelled = false
    const controller = new AbortController()

    const toEntries = (turns: { messageId: string; text: string; createdAt: number }[]) =>
      turns
        .filter(turn => turn.text.trim().length > 0)
        .map(turn => ({
          messageId: turn.messageId,
          title: truncateOutlineLabel(
            turn.text.trim().split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '',
            80,
          ),
          createdAt: turn.createdAt,
        }))
        .filter(entry => entry.title.length > 0)

    const run = () => {
      if (cancelled) return
      outlineFetchAt.set(key, Date.now())
      void (async () => {
        try {
          const { fetchSessionTurns } = await import('../api/turnOutline')
          const { complete } = await fetchSessionTurns(sessionId, {
            serverId,
            signal: controller.signal,
            // 每页到达就合并：轴逐步变长，而不是等全部下完才出现。
            onPage: (turns, info) => {
              if (cancelled) return
              const entries = toEntries(turns)
              if (entries.length > 0) turnOutlineStore.merge(serverId, sessionId, entries)
              if (!info.complete && info.page === 1) {
                // 首页已到：放宽重试窗口，允许后续补齐剩余页
                outlineFetchAt.set(key, Date.now() - OUTLINE_RETRY_MS + 60_000)
              }
            },
          })
          // 没翻到最早：允许稍后再补剩下的（仍然走同一套延迟与限频）
          if (!complete) outlineFetchAt.set(key, Date.now() - OUTLINE_RETRY_MS + 60_000)
        } catch {
          // 静默：大纲是导航辅助，失败不影响任何功能；上滑加载仍会增量补齐
        }
      })()
    }

    // 等应用空闲再做：这条请求可能十几 MB，绝不能和首屏抢带宽
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback
    let handle: number | undefined
    if (typeof idle === 'function') {
      handle = idle(run, { timeout: 5000 })
    } else {
      handle = globalThis.setTimeout(run, 2000)
    }

    return () => {
      cancelled = true
      controller.abort()
      const cancel = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback
      if (typeof cancel === 'function' && typeof idle === 'function') cancel(handle as number)
      else globalThis.clearTimeout(handle)
    }
  }, [serverId, sessionId, enabled])
}
