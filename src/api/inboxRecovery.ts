// ============================================
// 断线重连后恢复入队消息（session.inbox.list）
// ============================================
//
// v2 里「用户消息」唯一的实时信号是 `session.inbox.enqueued` 事件。SSE 是
// volatile 的（服务端明确写着「slow consumer overflows and fails the stream,
// and events during disconnection are missed」），断连期间入队的消息就再也不会
// 补发 —— 表现为「另一台设备发的消息在这台设备上不出现」，直到那一轮跑完、
// 消息落进 message.list 才突然冒出来。
//
// `session.inbox.list` 返回「已入队但尚未投递」的工作项，正好能把这个洞补上。
//
// 约束：
// 1. 只在重连时调用（不是轮询）：这是纠错路径，不是主数据源。
// 2. 只补 user 类型：synthetic / compaction / move 是内部条目，不该变成可见消息。
// 3. 已有消息不重复插入（messageStore.upsertRemoteUserMessage 按 id 覆盖）。

import { nativeListInbox } from './v2NativeSession'
import { messageStore } from '../store/messageStore'
import type { QueuedInboxItem } from '../store/messageStoreTypes'
import { activeSessionStore } from '../store/activeSessionStore'
import { makeSessionKey } from '../utils/sessionKey'
import { rawSessionIdOfKey } from '../store/messagePartMerge'
import { logger } from '../utils'

/**
 * 恢复时的并发上限。
 *
 * `Promise.all` 会对**全部**已加载会话一次性铺开(单服务器可达 48 个),而主机
 * Agent 对单条隧道是串行处理的 —— 重连瞬间铺开这么多,只会把紧跟着的其它关键
 * 请求排在它们后面。分批(每批 3 个)保留覆盖,又不制造突发。
 */
const RECOVERY_CONCURRENCY = 3

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 恢复某台服务器上所有「已加载会话」的未投递入队消息。
 *
 * 只处理 store 里已经存在的会话：没打开过的会话没有渲染位置，补进来也看不见，
 * 反而会让 store 里冒出幽灵会话。
 */
export async function recoverPendingInbox(serverId: string): Promise<void> {
  const sessionKeys = messageStore.getLoadedSessionKeysForServer(serverId)
  if (sessionKeys.length === 0) return

  const recoverOne = async (sessionKey: string): Promise<void> => {
      const bareId = rawSessionIdOfKey(sessionKey)
      if (!bareId) return
      try {
        const items = await nativeListInbox(serverId, bareId)
        const queued: QueuedInboxItem[] = []
        for (const item of items) {
          const entry = rec(item)
          if (entry.type !== 'user') continue
          const inboxID = str(entry.id)
          if (!inboxID) continue
          const payload = rec(entry.payload)
          const text = str(payload.text) ?? ''
          const createdAt = num(rec(entry.time).created) ?? Date.now()
          // 队列视角:纯图片消息(text 为空)也要出现在「排队中」,否则用户看不到、
          // 也没法取消它。
          queued.push({ id: inboxID, text, createdAt })
          // 消息本体:空文本且暂不处理附件时没有可渲染内容,跳过(等投递后走正常路径)
          if (!text) continue
          messageStore.upsertRemoteUserMessage(sessionKey, { messageId: inboxID, text, createdAt })
        }
        // 队列以服务端快照为准(断连期间 delivered/cancelled 可能丢失)
        messageStore.setQueuedInbox(sessionKey, queued)
        activeSessionStore.touchSession(makeSessionKey(serverId, bareId))
      } catch (error) {
        logger.warn('[inboxRecovery] failed to recover pending inbox', { sessionKey, error })
      }
  }
  // 分批执行:避免对全部已加载会话同时铺开请求(见 RECOVERY_CONCURRENCY)
  for (let i = 0; i < sessionKeys.length; i += RECOVERY_CONCURRENCY) {
    await Promise.all(sessionKeys.slice(i, i + RECOVERY_CONCURRENCY).map(recoverOne))
  }
}
