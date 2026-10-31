// ============================================
// useSessionRunning — 「这一轮是否还在跑」的唯一判据
// ============================================
//
// 此前同一个问题有三个各自为政的答案：
//   1. `messageStore.state.isStreaming`     —— 会话级标志，只由少数路径写
//   2. 末条 assistant 的 isStreaming/completed —— 渲染层判据（assistantHasLiveWork）
//   3. `/session/active` 的 busy/retry       —— 服务端权威快照
//
// 三者可能不同步：收尾路径只清 (1) 时，(2) 仍判「未完成」，界面继续显示处理中；
// 反过来 SSE 收尾事件丢失时 (1)(2) 都停在旧值，(3) 却已经说结束了。
// 各处各读一套，就出现「同一条会话在不同位置表现不一致」。
//
// 这里把三者收敛成一次判定，并明确优先级：**服务端权威 > 本地消息 > 会话标志**。
// 只读本地消息的地方（ChatArea 计时、空壳闸门）也能据此对齐。

import { useCallback, useSyncExternalStore } from 'react'
import { messageStore } from '../store/messageStore'
import { activeSessionStore, useSessionStatus } from '../store/activeSessionStore'
import { messageCompletedAt } from '../store/messagePartMerge'

/**
 * 纯函数版本：给定三路信号，判断这一轮是否仍在进行。
 *
 * @param serverRunning 服务端是否报告 busy/retry（`/session/active` 权威）
 * @param localStreaming 会话级 `state.isStreaming`
 * @param lastAssistant 末条 assistant 消息（可为 undefined）
 */
export function isSessionRunning(input: {
  serverRunning?: boolean
  localStreaming?: boolean
  lastAssistant?: {
    isStreaming?: boolean
    info?: { time?: { created?: number; completed?: number } | null } | null
    content?: ReadonlyArray<{ type?: string; state?: { status?: string } }>
  } | null
}): boolean {
  const { serverRunning, localStreaming, lastAssistant } = input
  /**
   * 服务端说在跑 → 在跑（快照可能比本地旧，优先级最高）。
   *
   * ⚠️ 但 `/api/session/active` 会残留：实测（2026-10-31，opencode 2.x）一个已
   * `succeeded`、`time.idle` 早于现在 10 分钟的会话，仍然被它报成 running。
   * 那条会话的最后一条 assistant 也确实没有 `time.completed`（消息在结束那一帧
   * 之前就断流了），于是「服务端说 running」+「消息未定稿」两边互相印证，
   * 界面就永久停在「处理中」—— 用户看到的就是「回复已经写出来了，却一直处理中」。
   *
   * 所以：**服务端说在跑，但本地末条 assistant 已经定稿**时，说明那条 running
   * 是残留，以消息为准。真正的生成中不可能出现「末条已 completed 且没有在跑的
   * 工具」这种形态 —— 那正是这一轮写完的标志。
   */
  const hasSettledAssistant =
    !!lastAssistant &&
    !lastAssistant.isStreaming &&
    lastAssistant.info?.time?.completed != null &&
    !lastAssistantHasLiveTool(lastAssistant)
  if (serverRunning) return !hasSettledAssistant
  if (!lastAssistant) return Boolean(localStreaming)
  /**
   * 有 assistant 时以**消息本身是否定稿**为准。
   *
   * 这是渲染层实际使用的判据（`assistantHasLiveWork`），也是唯一能反映
   * 「这一轮内容是否已经写完」的信号。会话级标志只作补充：它可能已被
   * 收尾路径清掉，而消息仍未定稿（正是「已完成还显示处理中」的形态）。
   */
  if (lastAssistant.isStreaming) return true
  if (messageCompletedAt(lastAssistant) == null) return true
  return Boolean(localStreaming)
}

/** 末条 assistant 里是否还有在跑/待执行的工具（有 = 这一轮其实还没完） */
function lastAssistantHasLiveTool(message: {
  content?: ReadonlyArray<{ type?: string; state?: { status?: string } }>
}): boolean {
  const content = message.content ?? []
  return content.some(
    part =>
      part.type === 'tool' &&
      (part.state?.status === 'running' || part.state?.status === 'pending'),
  )
}

/** 从 store 现算（非 hook 场景，如事件回调、发送链路） */
export function readSessionRunning(sessionKey: string | null | undefined): boolean {
  if (!sessionKey) return false
  const status = activeSessionStore.getSessionStatus(sessionKey)
  const serverRunning = status?.type === 'busy' || status?.type === 'retry'
  if (serverRunning) return true
  const state = messageStore.getSessionState(sessionKey)
  if (!state) return false
  const lastAssistant = state.messages.filter(m => m.info.role === 'assistant').at(-1)
  return isSessionRunning({
    serverRunning,
    localStreaming: state.isStreaming,
    lastAssistant,
  })
}

/**
 * 订阅版本：合并服务端状态与本地消息变化。
 *
 * 本地消息用 `getSessionChangeVersion` 做变化信号（每帧最多触发一次通知），
 * 避免每帧都遍历 messages 找末条 assistant。
 */
export function useSessionRunning(sessionId: string | null | undefined): boolean {
  const status = useSessionStatus(sessionId ?? null)
  const serverRunning = status?.type === 'busy' || status?.type === 'retry'

  const subscribe = useCallback((cb: () => void) => messageStore.subscribeSession(sessionId ?? '', cb), [sessionId])
  const getSnapshot = useCallback(() => {
    if (!sessionId) return ''
    const version = messageStore.getSessionChangeVersion(sessionId)
    const state = messageStore.getSessionState(sessionId)
    if (!state) return `${version}:0`
    const last = state.messages.filter(m => m.info.role === 'assistant').at(-1)
    const running = isSessionRunning({
      localStreaming: state.isStreaming,
      lastAssistant: last,
    })
    return `${version}:${running ? 1 : 0}`
  }, [sessionId])

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return serverRunning || snapshot.endsWith(':1')
}
