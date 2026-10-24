// ============================================
// todoSyncBridge - 把消息流的变化投影到 todoStore
// ============================================
//
// v2 没有 todo 的数据通道（无 todo.updated 事件、无查询端点），todo 只存在于
// agent 的 `todowrite` 工具调用里。这里订阅 messageStore，任何一次消息变化
// （历史加载完成 / 流式新 part 到达）都重新投影一次「最后一条 todowrite」。
//
// 为什么挂在 messageStore 的订阅上，而不是在 UI 里投影：
//   - 流式期间新 part 由 store 驱动，UI 只读 store —— 在 UI 投影会漏掉
//     「用户没打开待办面板」的情况（而工作状态面板/输入框角标要显示进度）。
//   - 历史加载与 SSE 增量走的是同一条 notify 路径，一个订阅点全覆盖。
//
// 投影是幂等的：内容没变时不写入，避免流式期间每个 token 都触发重渲染。

import { messageStore } from '../store/messageStore'
import { paneLayoutStore } from '../store/paneLayoutStore'
import { syncTodosFromMessages } from './todoSource'

/** 已订阅的会话 key → 取消订阅函数 */
const bridges = new Map<string, () => void>()

/**
 * 为一个会话建立投影桥。重复调用是幂等的。
 *
 * `sessionKey` 必须是带服务器前缀的复合 key（与 useTodos 读取口径一致）。
 */
export function attachTodoBridge(sessionKey: string | null): void {
  if (!sessionKey || bridges.has(sessionKey)) return

  const project = () => {
    const messages = messageStore.getVisibleMessages(sessionKey)
    if (messages.length === 0) return
    syncTodosFromMessages(sessionKey, messages)
  }

  const unsubscribe = messageStore.subscribeSession(sessionKey, project)
  bridges.set(sessionKey, unsubscribe)
  // 立即投影一次：桥接建立时消息可能已经加载好了（订阅只保证后续变化）
  project()
}

/** 解除某个会话的投影桥（会话关闭/切换时调用） */
export function detachTodoBridge(sessionKey: string | null): void {
  if (!sessionKey) return
  const unsubscribe = bridges.get(sessionKey)
  if (!unsubscribe) return
  unsubscribe()
  bridges.delete(sessionKey)
}

/**
 * 为当前聚焦会话建立投影桥。
 *
 * 由 ChatPane 在挂载/切会话时调用：聚焦会话是唯一会持续产生新 todowrite 的
 * 会话，其余会话的历史在打开时投影一次即可（打开即成为聚焦会话）。
 */
export function attachTodoBridgeForFocusedSession(): void {
  const sessionKey = paneLayoutStore.getFocusedSessionId()
  attachTodoBridge(sessionKey)
}

/** 测试用：清空所有桥 */
export function resetTodoBridges(): void {
  for (const unsubscribe of bridges.values()) unsubscribe()
  bridges.clear()
}
