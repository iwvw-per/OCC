// ============================================
// MessageStore Types
// ============================================

import type { Message, MessageError, Part } from '../types/message'

export interface RevertState {
  /** 撤销点的消息 ID */
  messageId: string
  /** 撤销历史栈 - 用于多步 redo */
  history: RevertHistoryItem[]
}

export interface RevertHistoryItem {
  messageId: string
  text: string
  attachments: unknown[]
  model?: { providerID: string; modelID: string; variant?: string }
  variant?: string
  agent?: string
}

export interface SessionState {
  /** 所有消息（包括被撤销的） */
  messages: Message[]
  /** 撤销状态 */
  revertState: RevertState | null
  /** 是否正在 streaming */
  isStreaming: boolean
  /** 加载状态 */
  loadState: 'idle' | 'loading' | 'loaded' | 'error'
  /** 空会话加载失败时展示在消息流里的错误 */
  loadError?: MessageError
  /** 是否还有更多历史消息 */
  hasMoreHistory: boolean
  /** 继续向前翻页的游标（服务端 X-Next-Cursor）；缺省表示已到最早一条 */
  historyCursor?: string
  /**
   * 因内存上限被从最旧端裁掉、但尚未补回的条数（内存缺口）。
   *
   * 与 hasMoreHistory 语义不同：hasMoreHistory 表示「服务端还有更早的消息」，
   * 而本字段表示「服务端可能有、但已被本地丢弃」。上滑加载时优先按本字段补拉，
   * 补够后归零；不能用它去置 hasMoreHistory，否则会产生空拉循环。
   */
  trimmedCount?: number
  /** session 目录 */
  directory: string
  /** session 标题 */
  title?: string
  /** 分享链接 */
  shareUrl?: string
  /** 断线重连后是否需要重新全量拉取 */
  isStale: boolean
  /** 最近一次已完成压缩的时间戳（用于消息流末尾的压缩分隔条） */
  compactedAt?: number
}

export interface SendRollbackSnapshot {
  messages: Message[]
  revertState: RevertState | null
}

export interface MessageStoreSnapshot {
  sessionId: string | null
  messages: Message[]
  isStreaming: boolean
  revertState: RevertState | null
  hasMoreHistory: boolean
  /** 是否存在因内存上限被裁掉、尚未补回的历史（内存缺口） */
  hasTrimmedHistory: boolean
  sessionDirectory: string
  sessionTitle: string
  shareUrl: string | undefined
  canUndo: boolean
  canRedo: boolean
  redoSteps: number
  revertedContent: RevertHistoryItem | null
  loadState: SessionState['loadState']
  loadError?: MessageError
}

export interface SessionStateSnapshot {
  messages: Message[]
  isStreaming: boolean
  loadState: SessionState['loadState']
  loadError?: MessageError
  revertState: RevertState | null
  canUndo: boolean
  canRedo: boolean
  redoSteps: number
  revertedContent: RevertHistoryItem | null
  hasMoreHistory: boolean
  /** 是否存在因内存预算被裁掉、尚未补回的历史（内存缺口） */
  hasTrimmedHistory: boolean
  directory: string
  title: string | null
  /** 最近一次已完成压缩的时间戳；有值时消息流末尾展示压缩分隔条 */
  compactedAt?: number
}

// Re-export Part for convenience
export type { Message, Part }
