// ============================================
// MessageStore Types
// ============================================

import type { Message, MessageError, Part, TokenUsage } from '../types/message'

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
  /**
   * 会话级累计用量（服务端 `session.usage.updated`）。
   *
   * 压缩会裁掉旧轮次，从可见消息汇总的累计 token/花费会凭空变小；这份值不随
   * 裁剪变化，是累计口径的权威来源。缺省时回退到按消息汇总。
   */
  usage?: { tokens: TokenUsage; cost: number }
  /**
   * 压缩完成时服务端回报的上下文用量（即压缩后的新上下文占用）。
   *
   * 与 `usage` 不同：`usage` 是累计消耗，这个是「压缩后此刻的上下文大小」，
   * 用于让圆环在压缩后立刻掉到正确水位。缺失时按消息文本估算。
   */
  compactionUsage?: { tokens: TokenUsage; cost?: number; at: number }
  /**
   * 来自 `message.list` 的压缩标记（事件可能不发，消息列表才是权威来源）。
   *
   * 该条目的 tokens 是**压缩前**用量，不能直接用；这里保留摘要与近期消息的
   * 字符规模，用于推算压缩后的上下文：旧轮次已被摘要取代，把它们再算进上下文
   * 会让圆环停在压缩前的高水位 —— 这正是「压缩完占用没变」的原因。
   */
  compactionMarker?: { at: number; summaryChars: number; recentChars: number }
  /**
   * 会话在服务端绑定的模型与 agent。
   *
   * 来自 `GET /api/session/{id}` 的 `model` / `agent` 字段。这是「会话绑定
   * 什么模型」的**权威来源**，必须单独保存：
   *
   *   - v2 的 user 消息没有 model 字段（实测只有 time/text），模型记在
   *     assistant 消息上；空会话或首条消息尚未产生时，只能靠这里；
   *   - 本地选择（localStorage）是无痕/新设备上没有的东西，不能作为唯一依据。
   *
   * 不保存它就会表现为「同一个会话在不同设备/无痕窗口里显示不同模型」，
   * 用户看到的是「会话没有绑定模型、被自动分配了」。
   */
  model?: { providerID: string; modelID: string; variant?: string }
  /** 会话绑定的 agent（同上，服务端权威） */
  agent?: string
  /**
   * 最近一次轮次的结论（来自消息列表里的 `type: "idle"` 记录）。
   *
   * 这是「这一轮结束了吗、成功还是失败」的**权威来源**。事件流的
   * `session.execution.succeeded` 一旦丢失（断线重连漏收、隧道抖动、进程重启），
   * 界面上就会永远转圈；而 idle 记录在消息列表里，刷新即可恢复。
   *
   * 所以：事件负责**及时**，idle 负责**正确**。两者都要。
   */
  lastTurn?: {
    /** 轮次结束时间（idle 记录的 time.created） */
    at: number
    outcome: 'succeeded' | 'failed' | 'interrupted'
    error?: string
  }
  /**
   * 轮次骨架统计（历史记录以「轮」为单位拉取时带回）。
   *
   * 骨架路径下每条助手消息只带最终回复正文，过程正文留在服务端；这里的
   * `changedFiles` 是渲染「本轮改动文件」胶囊所需的最小信息（路径 + 增删行数），
   * 无法从消息本身还原（工具 metadata 已被剥掉）。
   */
  turnSkeleton?: Map<string, { changedFiles?: Array<{ path: string; additions?: number; deletions?: number }> }>
  /**
   * 本次加载是否来自「轮次骨架」（整段、含全部轮次）。
   *
   * 骨架天然覆盖全部历史，因此侧边轴的轮次大纲不必再发一次全量补全请求
   * （那条请求在带截图的会话上实测 18MB）。
   */
  loadedFromSkeleton?: boolean
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
  /** 本次加载是否来自「轮次骨架」（整段覆盖全部历史） */
  loadedFromSkeleton: boolean
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
  /** 本次加载是否来自「轮次骨架」（整段覆盖全部历史，无需再补全大纲） */
  loadedFromSkeleton: boolean
  directory: string
  title: string | null
  /** 最近一次已完成压缩的时间戳；有值时消息流末尾展示压缩分隔条 */
  compactedAt?: number
  /** 会话绑定的模型（服务端权威，无痕/新设备据此恢复选择） */
  model?: { providerID: string; modelID: string; variant?: string }
  /** 会话绑定的 agent（服务端权威） */
  agent?: string
  /** 最近一次轮次结论（来自消息列表的 idle 记录，比事件更可靠） */
  lastTurn?: {
    at: number
    outcome: 'succeeded' | 'failed' | 'interrupted'
    error?: string
  }
}
// Re-export Part for convenience
export type { Message, Part }
