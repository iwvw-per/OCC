// ============================================
// MessageStore - 消息状态集中管理
// ============================================
//
// 核心设计：
// 1. 每个 session 的消息独立存储在内存中
// 2. SSE 事件直接修改对应 session 的消息（找不到则丢弃）
// 3. Undo/Redo 通过 revertState 实现
// 4. RAF 批量通知 React 组件更新

import i18n from '../i18n'
import type { Message, MessageError, Content, TextContent, TokenUsage } from '../types/message'
import type { ApiMessageWithParts, ApiMessage, ApiPart, ApiSession, Attachment } from '../api/types'
import { logger } from '../utils/logger'
import { isUserUIMessage, toUIMessage, toUIMessageInfo, toUIPart } from '../utils/messageConversion'
import { compressMessageParts } from './turnCompression'
import { sessionActivityStore } from './sessionActivityStore'
import {
  serverIdOfSessionKey,
  rawSessionIdOfKey,
  mergePartPreferLiveText,
  mergePartsPreferLiveText,
  mergeToolPart,
  shouldPreserveLiveParts,
  isServerPartId,
  messageCompletedAt,
} from './messagePartMerge'
import {
  reconcileInFlightTools,
  settleToolByCallID,
  finalizeStreamingMessages,
  computeTrimCount,
} from './messageToolSettle'
import type { RevertState, RevertHistoryItem, SessionState, SendRollbackSnapshot } from './messageStoreTypes'

// Re-export types for consumers
export type { RevertState, RevertHistoryItem, SessionState, SendRollbackSnapshot } from './messageStoreTypes'

type Subscriber = () => void

/**
 * 每个服务器的消息缓存配额。与 ChatArea 的 SESSION_CACHE_LIMIT(16) 对齐，
 * 避免「消息已被丢弃、但虚拟化测量缓存还在」的错配。
 *
 * 按 serverId 分片计数：多服务器模式下，一台服务器的活跃会话不应把另一台的
 * 缓存挤掉（否则在服务器间来回切换会不断重拉）。
 */
const MAX_CACHED_SESSIONS_PER_SERVER = 16
/** 全局硬上限，防止服务器数量很多时内存无界增长（超出时优先淘汰非活动服务器） */
const MAX_CACHED_SESSIONS_TOTAL = 48

/**
 * 单个会话在内存中保留的消息预算。
 *
 * 消息列表已虚拟化，DOM 节点数受控，但 JS 堆里的消息对象不会自动释放：
 * 长会话会把整段历史常驻。这里给出硬上限，超出时从最旧端裁剪。
 *
 * 上限用**体积**而非条数，原因：轻量投影后单条消息从 ~25KB 降到 ~0.8KB（30 倍），
 * 条数上限会让「投影后本来很小的会话」被误裁 —— 实测 749 条的投影会话只有
 * ~618KB，却因为超过 500 条被裁掉最前面 249 条，导致首屏看不到最早几轮。
 * 按体积记账后，投影会话可以完整保留，而未投影的重会话仍受同等内存约束。
 *
 * 防退化：按条数兜底，避免「大量极小消息」把数组本身撑爆（每条仍是对象，
 * 有固定开销）。两个限制取先命中者。
 */
const MAX_SESSION_MESSAGE_BYTES = 12 * 1024 * 1024
const MAX_SESSION_MESSAGE_COUNT = 20_000
/** D5：单会话乱序 delta 待回放键上限（超出丢最旧，防无界增长） */
const MAX_PENDING_DELTAS = 256

/**
 * 用量总量（各字段之和）。
 *
 * 服务端的累计用量单调递增，所以「总量更大」等价于「更新」，可以据此判断
 * 兜底数据是否值得覆盖现有值（见 recordSessionUsageFallback）。
 */
function tokenUsageTotal(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  )
}

class MessageStore {
  private sessions = new Map<string, SessionState>()
  /**
   * 原始 sessionId → 权威复合 key 的映射。
   *
   * 同一后端可能被以多个 serverId 前缀连接（本机 `local` 与隧道
   * `aiagent:inst_xxx` 指向同一 opencode 实例），同一条会话会以不同前缀推事件。
   * 这里把「首次出现的 key」定为权威 bucket，后续任何前缀的事件都归并进去，
   * 从而避免「UI 订阅的 bucket 收不到事件、事件写进了另一个 bucket」。
   */
  private rawSessionToKey = new Map<string, string>()
  /**
   * D8：raw sessionId → 曾以之出现过的事件前缀 serverId 集合。
   *
   * 同一后端被多前缀连接时（`local` 与 `aiagent:inst_x`），权威 bucket 只归属
   * 首次出现的那个前缀。若按权威 key 的前缀做「标记 stale / 配额计数 / 淘汰」，
   * 另一前缀的重连就不会命中该会话。这里记录所有关联前缀，供按 serverId 的操作
   * 正确匹配（宁可多算一个 server，也不漏标）。
   */
  private rawSessionServers = new Map<string, Set<string>>()
  private subscribers = new Set<Subscriber>()
  private sessionSubscribers = new Map<string, Map<Subscriber, number>>()
  private sessionVersions = new Map<string, number>()
  private allSessionsVersion = 0
  private changeVersion = 0
  private sessionAccessTime = new Map<string, number>()
  /** 被分屏 pane 保护的 sessionId 集合，evict 时跳过 */
  private protectedSessions = new Set<string>()
  private pendingNotify = false
  private pendingNotifyAllSessions = false
  private pendingSessionNotifyIds = new Set<string>()
  private rafId: number | null = null
  // delta 批量化：只追踪真正变化的 part，避免同消息内稳定 part 的 memo 引用失效
  private dirtyPartsBySession = new Map<string, Map<string, Set<string>>>()
  /**
   * id→索引缓存，消除高频事件路径上的线性 find。
   *
   * 缓存绑定在 state.messages / message.content 的**数组引用**上：只有引用变了才
   * 重建（每帧 flush 最多一次），同一帧内的多个 delta 共用同一份索引，把每个
   * token 的 O(m)+O(p) 扫描降为 O(1)。
   */
  private messageIndexCache = new Map<string, { messages: Message[]; byId: Map<string, number> }>()
  private partIndexCache = new Map<string, Map<string, { parts: Content[]; byId: Map<string, number> }>>()
  /**
   * delta 乱序缓冲（D5）。
   *
   * part.delta 依赖 part 已由 part.updated 建立；SSE 乱序（delta 先于
   * part.updated）时旧实现直接丢弃 token，且无自愈路径，表现为流式文本缺一段。
   * 这里按 (权威 sessionKey, messageID, partID, field) 暂存尚无法应用的 delta，
   * 待该 part 建立后由 flushPendingDeltas 回放。
   *
   * 有界：单会话缓冲上限，超出时丢最旧的，避免异常流量下无界增长。
   */
  private pendingDeltas = new Map<string, Map<string, string>>()
  /**
   * D7：每会话的「结束信号世代」。finalizeSession（idle/error）时递增。
   * 发送路径在 await sendMessageAsync 返回后读取该世代，若与发起时不同，
   * 说明本轮在请求返回前已结束，不再置 streaming（否则留下永久 Working 态）。
   */
  private idleGeneration = new Map<string, number>()
  /**
   * D19：乐观本地消息的 id 集合（乐观发送 / 排队追问的占位）。
   *
   * 此前靠 `id.startsWith('msg-local-')` 识别乐观消息，但真实乐观 id 是
   * `msg_<uuid>`（服务端 canonical 消息也是 `msg_` 前缀），该判定永不命中，
   * 相关清理分支是死代码。改用显式集合：乐观写入时登记，被 canonical 消息
   * 精确命中（复用同一 id）或按文本替换时移除。
   */
  private optimisticMessageIds = new Set<string>()
  /**
   * 会话被淘汰/清除时的观察者。
   *
   * 为什么需要它：会话状态（含 `usage` / `contextUsage` / `compactionMarker`）
   * 全在内存里，淘汰即丢失；而补这些数据的模块（`api/contextBackfill`）用
   * 「每会话只补一次」的 Set 去重。若淘汰后不通知它，会话重新打开时会被
   * 去重挡掉，圆环永久退化成字符估算 —— 直到整页刷新。
   *
   * 只通知「state 真的被丢掉」的路径（evict / clearSession / clearAll），
   * 不动「仍在内存里」的会话。
   */
  private sessionEvictListeners = new Set<(sessionKey: string) => void>()

  /**
   * 订阅「会话状态被丢弃」事件。回调收到复合 key（`serverId::sessionId`）。
   * 返回取消订阅函数。
   */
  onSessionEvicted(fn: (sessionKey: string) => void): () => void {
    this.sessionEvictListeners.add(fn)
    return () => this.sessionEvictListeners.delete(fn)
  }

  private notifySessionEvicted(sessionKey: string): void {
    this.sessionEvictListeners.forEach(fn => {
      try {
        fn(sessionKey)
      } catch {
        // 观察者异常不能影响淘汰本身
      }
    })
  }

  // ============================================
  // Subscription & Notification
  // ============================================

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  subscribeSession(sessionId: string, fn: Subscriber): () => void {
    // UI 订阅的 key 优先成为权威 bucket：若该会话尚无 bucket，由第一个订阅者
    // 认领，之后任意前缀推来的事件都归并到此，避免「订阅的 key 收不到事件」。
    sessionId = this.resolveKey(sessionId, true)
    let subscribers = this.sessionSubscribers.get(sessionId)
    if (!subscribers) {
      subscribers = new Map()
      this.sessionSubscribers.set(sessionId, subscribers)
    }
    subscribers.set(fn, this.getSessionVersion(sessionId))
    return () => {
      subscribers.delete(fn)
      if (subscribers.size === 0) this.sessionSubscribers.delete(sessionId)
    }
  }

  private getSessionVersion(sessionId: string) {
    sessionId = this.resolveKey(sessionId)
    return Math.max(this.sessionVersions.get(sessionId) ?? 0, this.allSessionsVersion)
  }

  /** 公开的版本读取：供 React 快照缓存判断某 session 是否已变化 */
  getSessionChangeVersion(sessionId: string): number {
    return this.getSessionVersion(sessionId)
  }

  private markPendingSessionNotifications(sessionIds?: Iterable<string> | 'all') {
    if (sessionIds === 'all') {
      this.changeVersion += 1
      this.allSessionsVersion = this.changeVersion
      this.pendingNotifyAllSessions = true
      this.pendingSessionNotifyIds.clear()
      return
    }
    if (!sessionIds || this.pendingNotifyAllSessions) return
    for (const sessionId of sessionIds) {
      this.changeVersion += 1
      this.sessionVersions.set(sessionId, this.changeVersion)
      this.pendingSessionNotifyIds.add(sessionId)
    }
  }

  private notify(sessionIds?: Iterable<string> | 'all') {
    this.markPendingSessionNotifications(sessionIds)
    if (this.pendingNotify) return
    this.pendingNotify = true

    if (typeof requestAnimationFrame !== 'undefined') {
      this.rafId = requestAnimationFrame(() => {
        this.pendingNotify = false
        this.rafId = null
        this.flushDirtyMessages()
        this.subscribers.forEach(fn => fn())
        this.flushSessionSubscribers()
      })
    } else {
      this.pendingNotify = false
      this.flushDirtyMessages()
      this.subscribers.forEach(fn => fn())
      this.flushSessionSubscribers()
    }
  }

  private flushSessionSubscribers() {
    if (this.pendingNotifyAllSessions) {
      this.pendingNotifyAllSessions = false
      this.pendingSessionNotifyIds.clear()
      this.sessionSubscribers.forEach((subscribers, sessionId) => {
        this.flushSubscribersForSession(sessionId, subscribers)
      })
      return
    }

    if (this.pendingSessionNotifyIds.size === 0) return
    const sessionIds = Array.from(this.pendingSessionNotifyIds)
    this.pendingSessionNotifyIds.clear()
    for (const sessionId of sessionIds) {
      const subscribers = this.sessionSubscribers.get(sessionId)
      if (subscribers) this.flushSubscribersForSession(sessionId, subscribers)
    }
  }

  private flushSubscribersForSession(sessionId: string, subscribers: Map<Subscriber, number>) {
    const version = this.getSessionVersion(sessionId)
    subscribers.forEach((seenVersion, fn) => {
      if (seenVersion === version) return
      subscribers.set(fn, version)
      fn()
    })
  }

  /**
   * 将 delta 期间 mutable 修改过的消息做一次不可变快照。
   * 这样一帧内多个 delta 只产生一次数组拷贝，未变化的 part 继续复用引用。
   *
   * 只遍历脏消息（按 id 索引定位），不再对整表 map；只在确有变化时才复制
   * messages 数组，未脏消息与其 parts 引用原样保留。
   */
  private flushDirtyMessages() {
    if (this.dirtyPartsBySession.size === 0) return

    for (const [sessionId, dirtyPartsByMessage] of this.dirtyPartsBySession) {
      const state = this.sessions.get(sessionId)
      if (!state) continue

      const byId = this.getMessageIndex(sessionId, state)
      let newMessages: Message[] | null = null

      for (const [messageId, dirtyPartIds] of dirtyPartsByMessage) {
        const msgIndex = byId.get(messageId)
        if (msgIndex === undefined) continue

        const message = (newMessages ?? state.messages)[msgIndex]
        if (!message) continue

        const partIndex = this.getPartIndex(sessionId, messageId, message.content)
        let partsChanged = false
        const newContent = message.content.slice()
        for (const partId of dirtyPartIds) {
          const partIndexInMessage = partIndex.get(partId)
          if (partIndexInMessage === undefined) continue
          newContent[partIndexInMessage] = { ...message.content[partIndexInMessage] }
          partsChanged = true
        }
        if (!partsChanged) continue

        if (!newMessages) newMessages = state.messages.slice()
        newMessages[msgIndex] = { ...message, content: newContent }
      }

      if (newMessages) {
        state.messages = newMessages
      }
    }

    this.dirtyPartsBySession.clear()
  }

  private notifyImmediate(sessionIds?: Iterable<string> | 'all') {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.markPendingSessionNotifications(sessionIds)
    this.pendingNotify = false
    this.flushDirtyMessages()
    this.subscribers.forEach(fn => fn())
    this.flushSessionSubscribers()
  }

  // ============================================
  // Getters
  // ============================================

  getSessionState(sessionId: string): SessionState | undefined {
    return this.sessions.get(this.resolveKey(sessionId))
  }

  /**
   * 列出**当前内存里所有**会话的复合 key。
   *
   * 供周期对账使用（如用量纠错）：只对账真正在内存里的会话，避免为从未打开过
   * 的会话建档（那会让侧栏冒出幽灵项）。
   */
  getAllSessionKeys(): string[] {
    return [...this.sessions.keys()]
  }

  /**
   * 列出某台服务器上**已加载进内存**的会话 key（复合 key）。
   *
   * 供重连后的纠错路径使用（如补拉未投递的入队消息）：只处理已经存在的会话，
   * 否则会在 store 里给没打开过的会话建档，侧栏冒出幽灵条目。
   */
  getLoadedSessionKeysForServer(serverId: string): string[] {
    const keys: string[] = []
    for (const key of this.sessions.keys()) {
      const separator = key.indexOf('::')
      if (separator < 0) continue
      if (key.slice(0, separator) === serverId) keys.push(key)
    }
    return keys
  }

  getVisibleMessages(sessionId: string | null): Message[] {
    if (!sessionId) return []
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return []

    const { messages, revertState } = state
    if (!revertState) return messages

    const revertIndex = messages.findIndex(m => m.info.id === revertState.messageId)
    return revertIndex === -1 ? messages : messages.slice(0, revertIndex)
  }

  getIsStreaming(sessionId: string | null): boolean {
    if (!sessionId) return false
    return this.sessions.get(this.resolveKey(sessionId))?.isStreaming ?? false
  }

  getRevertState(sessionId: string | null): RevertState | null {
    if (!sessionId) return null
    return this.sessions.get(this.resolveKey(sessionId))?.revertState ?? null
  }

  getHasMoreHistory(sessionId: string | null): boolean {
    if (!sessionId) return false
    return this.sessions.get(this.resolveKey(sessionId))?.hasMoreHistory ?? false
  }

  getHistoryCursor(sessionId: string | null): string | undefined {
    if (!sessionId) return undefined
    return this.sessions.get(this.resolveKey(sessionId))?.historyCursor
  }

  /**
   * 内存缺口：被裁剪掉、尚未补回的条数。
   *
   * 用于 loadMoreHistory 判断「是否有本地缺口需要补」，与 hasMoreHistory
   * （服务端是否还有更早）区分开，避免用缺口去驱动空拉循环。
   */
  getTrimmedCount(sessionId: string | null): number {
    if (!sessionId) return 0
    return this.sessions.get(this.resolveKey(sessionId))?.trimmedCount ?? 0
  }

  /**
   * 把内存缺口标记为「已确认无法补回」并清零。
   *
   * 当 loadMoreHistory 从最旧一条向前翻页却拿不到任何更早内容（说明它本就是会话
   * 第一条，缺口是误记），用它清掉 trimmedCount，否则 hasTrimmedHistory 恒真会让
   * ChatArea 在顶部反复空拉。
   */
  clearTrimmedGap(sessionId: string | null): void {
    if (!sessionId) return
    const state = this.sessions.get(this.resolveKey(sessionId))
    if (!state || !state.trimmedCount) return
    state.trimmedCount = 0
    this.notify([this.resolveKey(sessionId)])
  }

  getSessionDirectory(sessionId: string | null): string {
    if (!sessionId) return ''
    return this.sessions.get(this.resolveKey(sessionId))?.directory ?? ''
  }

  getSessionTitle(sessionId: string | null): string {
    if (!sessionId) return ''
    return this.sessions.get(this.resolveKey(sessionId))?.title ?? ''
  }

  getShareUrl(sessionId: string | null): string | undefined {
    if (!sessionId) return undefined
    return this.sessions.get(this.resolveKey(sessionId))?.shareUrl
  }

  getLoadState(sessionId: string | null): SessionState['loadState'] {
    if (!sessionId) return 'idle'
    return this.sessions.get(this.resolveKey(sessionId))?.loadState ?? 'idle'
  }

  isSessionStale(sessionId: string): boolean {
    return this.sessions.get(this.resolveKey(sessionId))?.isStale ?? false
  }

  // ============================================
  // Session Management
  // ============================================

  /**
   * 返回 session 的 message id→index 映射，绑定当前 messages 数组引用。
   * 引用未变时直接复用；变了才重建（每帧最多一次）。
   */
  private getMessageIndex(sessionId: string, state: SessionState): Map<string, number> {
    const cached = this.messageIndexCache.get(sessionId)
    if (cached && cached.messages === state.messages) return cached.byId
    const byId = new Map<string, number>()
    for (let i = 0; i < state.messages.length; i++) {
      byId.set(state.messages[i].info.id, i)
    }
    this.messageIndexCache.set(sessionId, { messages: state.messages, byId })
    // messages 变更时顺带清理已不在会话内的 part 索引，避免长会话滚动时无界增长
    const perMessage = this.partIndexCache.get(sessionId)
    if (perMessage && perMessage.size > byId.size * 2) {
      for (const messageId of perMessage.keys()) {
        if (!byId.has(messageId)) perMessage.delete(messageId)
      }
    }
    return byId
  }

  /** 返回某条消息内 part id→index 映射，绑定当前 parts 数组引用。 */
  private getPartIndex(sessionId: string, messageId: string, parts: Content[]): Map<string, number> {
    let perMessage = this.partIndexCache.get(sessionId)
    if (!perMessage) {
      perMessage = new Map()
      this.partIndexCache.set(sessionId, perMessage)
    }
    const cached = perMessage.get(messageId)
    if (cached && cached.parts === parts) return cached.byId
    const byId = new Map<string, number>()
    for (let i = 0; i < parts.length; i++) {
      byId.set(parts[i].id, i)
    }
    perMessage.set(messageId, { parts, byId })
    return byId
  }

  /**
   * 把任意前缀的复合 key 归并到该会话的权威 bucket。
   *
   * 权威 bucket = 该 raw sessionId 首次出现的 key（通常是用户打开会话时 UI 用的那个）。
   * 之后其它前缀（同一后端的另一条连接）推来的事件都写入同一份 state，
   * UI 读任意前缀都能看到。返回 undefined 表示该 raw sessionId 尚无 bucket
   * 且调用方要求不新建（get 语义）。
   */
  private resolveKey(sessionId: string, create = false): string {
    const raw = rawSessionIdOfKey(sessionId)
    const serverId = serverIdOfSessionKey(sessionId)
    if (serverId) {
      let servers = this.rawSessionServers.get(raw)
      if (!servers) {
        servers = new Set<string>()
        this.rawSessionServers.set(raw, servers)
      }
      servers.add(serverId)
    }
    const existing = this.rawSessionToKey.get(raw)
    if (existing) return existing
    if (!create) return sessionId
    this.rawSessionToKey.set(raw, sessionId)
    return sessionId
  }

  /**
   * D8：该权威 key 是否与指定 serverId 关联（含多前缀归并的其它前缀）。
   * 无 serverId 前缀的旧 key 视为任意 server 都匹配，避免漏标。
   */
  private sessionBelongsToServer(sessionKey: string, serverId: string): boolean {
    if (serverIdOfSessionKey(sessionKey) === serverId) return true
    const servers = this.rawSessionServers.get(rawSessionIdOfKey(sessionKey))
    if (!servers) return serverIdOfSessionKey(sessionKey) === ''
    return servers.has(serverId)
  }

  private ensureSession(sessionId: string): SessionState {
    sessionId = this.resolveKey(sessionId, true)
    this.sessionAccessTime.set(sessionId, Date.now())

    let state = this.sessions.get(sessionId)
    if (!state) {
      this.evictOldSessions(serverIdOfSessionKey(sessionId))
      state = {
        messages: [],
        revertState: null,
        isStreaming: false,
        loadState: 'idle',
        hasMoreHistory: false,
        historyCursor: undefined,
        trimmedCount: 0,
        directory: '',
        title: undefined,
        loadError: undefined,
        shareUrl: undefined,
        isStale: false,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * 记一条用户消息的活动锚点（侧栏排序用）。非 user 消息或时间缺失时跳过。
   * 目录取会话当前已知的 directory，serverId 从复合 key 解析。
   */
  private recordUserMessageAnchor(
    sessionId: string,
    info: { role?: string; time?: { created?: number } },
    directory?: string,
  ): void {
    if (info.role !== 'user') return
    const created = info.time?.created
    if (!created) return
    const state = this.sessions.get(sessionId)
    sessionActivityStore.recordActivity(
      rawSessionIdOfKey(sessionId),
      created,
      directory ?? state?.directory,
      serverIdOfSessionKey(sessionId),
    )
  }

  /** 整段消息里取最大的用户消息时间，作为该会话的锚点（冷启动播种/刷新）。 */
  private recordUserAnchorFromMessages(sessionId: string, directory?: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    let max = 0
    for (const message of state.messages) {
      if (message.info.role !== 'user') continue
      const created = message.info.time?.created ?? 0
      if (created > max) max = created
    }
    if (!max) return
    sessionActivityStore.recordActivity(
      rawSessionIdOfKey(sessionId),
      max,
      directory ?? state.directory,
      serverIdOfSessionKey(sessionId),
    )
  }

  private evictOldSessions(protectServerId?: string) {
    const countFor = (serverId: string) => {
      let count = 0
      for (const id of this.sessions.keys()) {
        // D8：按关联前缀计数，避免多前缀会话被漏算 / 误算到其它服务器
        if (this.sessionBelongsToServer(id, serverId)) count += 1
      }
      return count
    }

    const evictable = (id: string): boolean => {
      if (this.protectedSessions.has(id)) return false
      if (this.sessions.get(id)?.isStreaming) return false
      // D17：仍有 UI 订阅者的会话不淘汰。TaskRenderer / 子会话面板等通过
      // useSessionState 订阅但不在 protectedSessions 里，淘汰会让查看中的内容突然清空。
      const subscribers = this.sessionSubscribers.get(id)
      if (subscribers && subscribers.size > 0) return false
      return true
    }

    /** 在给定 serverId 范围内淘汰最久未访问的会话；不传则跨所有服务器 */
    const evictOldest = (serverId?: string): boolean => {
      let oldestId: string | null = null
      let oldestTime = Infinity
      for (const [id, time] of this.sessionAccessTime) {
        if (serverId !== undefined && !this.sessionBelongsToServer(id, serverId)) continue
        if (!evictable(id)) continue
        if (time < oldestTime) {
          oldestTime = time
          oldestId = id
        }
      }
      if (!oldestId) return false
      logger.log('[MessageStore] Evicting old session:', oldestId)
      this.forgetOptimisticMessagesOf(oldestId)
      this.sessions.delete(oldestId)
      this.sessionAccessTime.delete(oldestId)
      this.dirtyPartsBySession.delete(oldestId)
      this.pendingDeltas.delete(oldestId)
      this.idleGeneration.delete(oldestId)
      this.messageIndexCache.delete(oldestId)
      this.partIndexCache.delete(oldestId)
      this.rawSessionToKey.delete(rawSessionIdOfKey(oldestId))
      this.rawSessionServers.delete(rawSessionIdOfKey(oldestId))
      // 状态连同 usage/contextUsage 一起丢了：通知依赖它们的模块可以重新补
      this.notifySessionEvicted(oldestId)
      return true
    }

    // 1) 目标服务器超配额：只在该服务器内淘汰，不波及其它服务器
    if (protectServerId) {
      while (countFor(protectServerId) >= MAX_CACHED_SESSIONS_PER_SERVER) {
        if (!evictOldest(protectServerId)) break
      }
    }

    // 2) 全局硬上限：跨服务器淘汰最久未访问者
    while (this.sessions.size >= MAX_CACHED_SESSIONS_TOTAL) {
      if (!evictOldest()) break
    }
  }

  /** 保护 sessionId 不被 evict（分屏 pane 使用） */
  protectSession(sessionId: string) {
    this.protectedSessions.add(sessionId)
  }

  /** 取消保护（pane 关闭或切换 session 时调用） */
  unprotectSession(sessionId: string) {
    this.protectedSessions.delete(sessionId)
  }

  /**
   * 单会话消息条数上限：超出时从最旧端裁剪。
   *
   * 裁剪会丢掉内存里最旧的消息。为了让被裁历史仍可恢复，裁剪发生时记录
   * `trimmedCount`：上滑时据此走「按条数重拉一页」的路径把缺口补回来。
   *
   * 注意这里**不再**无条件置 `hasMoreHistory = true`。原因是「一次拉全」的
   * 轻量路径（getSessionLightweightMessages）本就会返回整段会话，裁剪只是丢
   * 内存副本、服务端并没有更早的内容。若此处强行置 true 且清空游标，
   * `loadMoreHistory` 的无游标分支会用「当前条数的一半」重拉**最新**一页 ——
   * 拉回的内容与内存完全重叠，去重后 unique 为 0，没有任何更早历史被补回；
   * 而 `prependMessages` 又会按该页的 hasMore 覆盖状态，于是「上滑 → 空拉 →
   * 仍报还有 → 再上滑」自我维持，表现为「加载历史记录」指示条反复出现。
   *
   * 因此改为：裁剪只标记缺口；是否「还有更早历史」仍由服务端语义决定
   * （调用方传入的 hasMoreHistory 或后续 prependMessages 的返回值）。
   * `loadMoreHistory` 通过 `trimmedCount` 识别缺口并优先补拉。
   *
   * revertState 指向的消息若被裁掉，会一并清空，避免撤销点悬空。
   */
  private capSessionMessages(state: SessionState) {
    const cut = computeTrimCount(state.messages, MAX_SESSION_MESSAGE_BYTES, MAX_SESSION_MESSAGE_COUNT)
    if (cut > 0) this.trimFromOldest(state, cut)
  }

  /**
   * 从最旧端裁掉 `cut` 条，并记录缺口。
   *
   * 只丢内存副本：被裁内容仍在服务端，`trimmedCount` 让上层能识别缺口并按需补拉。
   * 这里**不**置 `hasMoreHistory` —— 语义是「服务端是否还有更早」，与「本地有缺口」
   * 是两回事；混用会导致「上滑 → 空拉 → 仍报还有」的死循环。
   */
  private trimFromOldest(state: SessionState, cut: number) {
    if (cut <= 0) return
    const kept = state.messages.slice(cut)
    if (state.revertState) {
      const revert = state.revertState
      const revertIndex = kept.findIndex(m => m.info.id === revert.messageId)
      if (revertIndex === -1) state.revertState = null
    }
    state.messages = kept
    // 记录被裁掉的条数，供 loadMoreHistory 识别「内存缺口」并按缺口补拉。
    state.trimmedCount = (state.trimmedCount ?? 0) + cut
    // 裁剪后原游标指向被裁窗口之后，继续用它只会拉到与内存重叠的区间；
    // 清空让补拉走「按缺口重拉最新一页」的路径。
    state.historyCursor = undefined
  }

  updateSessionMetadata(
    sessionId: string,
    options: {
      hasMoreHistory?: boolean
      historyCursor?: string
      directory?: string
      title?: string
      loadState?: SessionState['loadState']
      shareUrl?: string
      loadError?: MessageError
      compactedAt?: number
      compactionMarker?: { at: number; summaryChars: number; recentChars: number }
      /** 会话绑定的模型（服务端权威） */
      model?: { providerID: string; modelID: string; variant?: string }
      /** 会话绑定的 agent（服务端权威） */
      agent?: string
      /** 最近一次轮次结论（消息列表的 idle 记录） */
      lastTurn?: SessionState['lastTurn']
      /** 轮次骨架统计（改动文件清单等） */
      turnSkeleton?: SessionState['turnSkeleton']
    },
  ) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return

    if (options.hasMoreHistory !== undefined) state.hasMoreHistory = options.hasMoreHistory
    // 用 in 判断：historyCursor 显式传 undefined 表示「已到最早一条」，必须清空旧游标
    if ('historyCursor' in options) state.historyCursor = options.historyCursor
    if (options.directory !== undefined) state.directory = options.directory
    if (options.title !== undefined) state.title = options.title
    if (options.loadState !== undefined) state.loadState = options.loadState
    if (options.loadError !== undefined) state.loadError = options.loadError
    if (options.shareUrl !== undefined) state.shareUrl = options.shareUrl
    if (options.compactedAt !== undefined) state.compactedAt = options.compactedAt
    if (options.compactionMarker !== undefined) state.compactionMarker = options.compactionMarker
    if (options.model !== undefined) state.model = options.model
    if (options.agent !== undefined) state.agent = options.agent
    if (options.lastTurn !== undefined) state.lastTurn = options.lastTurn
    if (options.turnSkeleton !== undefined) state.turnSkeleton = options.turnSkeleton

    this.notify([sessionId])
  }

  /**
   * 写入轮次骨架统计（历史以「轮」为单位拉取时带回的改动文件清单等）。
   *
   * 与 updateSessionMetadata 分开是因为它的调用点在 setMessages 之后：
   * setMessages 会重建 state，先写会被覆盖掉。
   */
  setTurnSkeleton(
    sessionId: string,
    turns: Map<string, { changedFiles?: Array<{ path: string; additions?: number; deletions?: number }> }>,
  ): void {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.turnSkeleton = turns
    state.loadedFromSkeleton = true
    this.notify([sessionId])
  }

  /**
   * 合并一批骨架轮次统计（上滑继续加载更早骨架页时调用）。
   *
   * 与 `setTurnSkeleton` 的区别：整段加载是覆盖，分页续取是累加 ——
   * 用覆盖会把先前已加载轮次的改动文件清单全部丢掉。
   */
  mergeTurnSkeleton(
    sessionId: string,
    turns: Map<string, { changedFiles?: Array<{ path: string; additions?: number; deletions?: number }> }>,
  ): void {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.turnSkeleton = new Map([...(state.turnSkeleton ?? []), ...turns])
    state.loadedFromSkeleton = true
    this.notify([sessionId])
  }

  upsertLocalMessage(message: Message, directory?: string) {
    const sessionKey = this.resolveKey(message.info.sessionID, true)
    const state = this.ensureSession(sessionKey)
    const existingIndex = state.messages.findIndex(item => item.info.id === message.info.id)

    if (existingIndex >= 0) {
      state.messages = [...state.messages.slice(0, existingIndex), message, ...state.messages.slice(existingIndex + 1)]
    } else {
      state.messages = [...state.messages, message].sort((a, b) => {
        const aCreated = a.info.time?.created ?? 0
        const bCreated = b.info.time?.created ?? 0
        return aCreated - bCreated
      })
      this.capSessionMessages(state)
    }

    // 乐观发送的本地占位也是用户消息：立即抬高锚点，新会话即时置顶。
    // 新建会话的 state.directory 可能尚未回填，故显式传入目录。
    this.recordUserMessageAnchor(sessionKey, message.info, directory)
    this.optimisticMessageIds.add(message.info.id)
    this.notify([sessionKey])
  }

  /**
   * 写入一条来自其它端（或本端回环）的用户消息。
   *
   * v2 的实时事件流没有 message.updated，用户消息的唯一信号是
   * `session.inbox.enqueued`（带 inboxID = 客户端生成的 messageID 与文本）。
   * 这里把它落成与历史拉取同构的用户消息（`${id}-text` part），使：
   *   - 其它端在 agent 处理前就能看到这条消息（此前完全看不到 → 像被吞掉）；
   *   - 本端乐观占位按同一 id 被原地替换，不产生重复；
   *   - 后续 agent 回复按 id 关联 parentID 时顺序正确。
   *
   * 与 upsertLocalMessage 的区别：这里不把 id 记入 optimisticMessageIds ——
   * 它来自服务端事件，是权威消息而不是待替换的占位。
   */
  upsertRemoteUserMessage(
    sessionId: string,
    input: { messageId: string; text: string; createdAt: number; directory?: string },
  ) {
    const sessionKey = this.resolveKey(sessionId, true)
    const state = this.ensureSession(sessionKey)
    // 复合 key 的权威 bucket 与 API 里的原始 sessionID 不同：消息 info/part 上都应
    // 用复合 key，UI 与 store 内部一致（历史拉取走 toUIMessage 时也由 store 统一）。
    const rawSessionID = sessionKey
    const existingIndex = state.messages.findIndex(item => item.info.id === input.messageId)
    const existing = existingIndex >= 0 ? state.messages[existingIndex] : undefined

    // 正文来源优先级：服务端已建好的 canonical part > 事件里的文本。
    // inbox.enqueued 可能晚于 message.part.updated 到达（重连补发），此时已有
    // `prt_` 开头的权威 part，不能被这里的本地形式 `${id}-text` 覆盖。
    const hasCanonicalText =
      !!existing && existing.content.some(part => part.type === 'text' && isServerPartId(part.id))
    const content: Content[] =
      existing && hasCanonicalText
        ? existing.content
        : [
            {
              id: `${input.messageId}-text`,
              type: 'text',
              text: input.text,
              synthetic: false,
              sessionID: rawSessionID,
              messageID: input.messageId,
            } as TextContent,
          ]
    const message: Message = existing
      ? {
          ...existing,
          content,
          // 时间以服务端事件时间为准：跨端排序必须同基准。本地乐观消息的
          // `Date.now()` 只是本机时钟，两端差几秒就会让同一轮消息顺序不一致。
          info: { ...existing.info, time: { ...existing.info.time, created: input.createdAt } },
        }
      : {
          info: {
            id: input.messageId,
            sessionID: rawSessionID,
            role: 'user',
            time: { created: input.createdAt },
            agent: '',
            model: { providerID: '', modelID: '' },
          } as Message['info'],
          content,
          isStreaming: false,
        }

    if (existingIndex >= 0) {
      state.messages = [...state.messages.slice(0, existingIndex), message, ...state.messages.slice(existingIndex + 1)]
    } else {
      state.messages = [...state.messages, message].sort((a, b) => {
        const aCreated = a.info.time?.created ?? 0
        const bCreated = b.info.time?.created ?? 0
        return aCreated - bCreated
      })
      this.capSessionMessages(state)
    }

    // 这条消息的 id 不再是「待替换的乐观占位」：服务端已确认它入队。
    this.optimisticMessageIds.delete(input.messageId)
    this.recordUserMessageAnchor(sessionKey, message.info, input.directory)
    this.notify([sessionKey])
  }

  removeMessage(sessionId: string, messageId: string) {    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    const nextMessages = state.messages.filter(message => message.info.id !== messageId)
    if (nextMessages.length === state.messages.length) return
    state.messages = nextMessages
    this.optimisticMessageIds.delete(messageId)
    this.notify([sessionId])
  }

  /**
   * 记录会话级累计用量（服务端 `session.usage.updated`）。
   *
   * 压缩裁掉旧轮次后，按可见消息汇总的累计值会变小；服务端这份不受裁剪影响。
   * 只在会话已存在时写入——为不存在的会话建档会让侧栏冒出幽灵项。
   */
  recordSessionUsage(sessionId: string, tokens: TokenUsage, cost: number) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    const prev = state.usage
    if (
      prev &&
      prev.cost === cost &&
      prev.tokens.input === tokens.input &&
      prev.tokens.output === tokens.output &&
      prev.tokens.reasoning === tokens.reasoning &&
      prev.tokens.cache.read === tokens.cache.read &&
      prev.tokens.cache.write === tokens.cache.write
    ) {
      return
    }
    state.usage = { tokens, cost }
    this.notify([sessionId])
  }

  /**
   * 用服务端快照兜底会话累计用量（`session` 接口 / `session.context` 汇总）。
   *
   * 为什么需要兜底：`usage` 的实时来源是 `session.usage.updated`，而它是
   * **ephemeral**（不落盘）。断线重连、切设备、刷新页面之后这个事件不会再补发，
   * 于是统计会一直停在「按已加载消息累加」的口径上 —— 而首屏只加载 50 条，
   * 真实上下文可能有 300+ 条，数字会小一个数量级。
   *
   * 合并策略是**取较大值**而不是「有值就不覆盖」：
   * 服务端的累计用量单调递增（实测同一会话连续两次读取，值不变或更大），
   * 所以「更大的那份一定更新」。旧实现「已有值就 return」的问题是：一旦某次
   * SSE 丢了 usage 事件、写进了一个偏小的值，后续任何一次对账都纠正不回来，
   * 数字会永久停在偏小值上。
   */
  recordSessionUsageFallback(sessionId: string, tokens: TokenUsage, cost: number) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    const prev = state.usage
    if (prev && tokenUsageTotal(prev.tokens) >= tokenUsageTotal(tokens)) return
    state.usage = { tokens, cost }
    this.notify([sessionId])
  }

  /**
   * 记录上下文占用快照（`session.context` 里最后一条带 tokens 的 assistant）。
   *
   * 用于补「骨架投影不带 tokens」的洞：进入会话时消息里没有实测用量，
   * 圆环只能按字符估算，看起来「只有发一条消息后才对」。
   *
   * 覆盖策略：只在还没有快照时写，或新快照更新时覆盖。消息级实测值
   * 永远优先（见 computeSessionStats 的取值顺序），所以这里不需要与
   * `usage` / `compactionUsage` 争优先级。
   */
  recordContextUsageSnapshot(sessionId: string, tokens: TokenUsage, cost: number, at?: number) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    const nextAt = at ?? Date.now()
    // 已有更新的快照就不回退（乱序/重复补数据）
    if (state.contextUsage && state.contextUsage.at > nextAt) return
    state.contextUsage = { tokens, cost, at: nextAt }
    this.notify([sessionId])
  }

  /**
   * 记录压缩完成后的上下文规模。
   *
   * 圆环能在压缩后立刻掉下来的关键。v2 的压缩事件里 `tokens` 是**压缩前**用量，
   * 不能直接显示；真实构成是「摘要 + 保留的近期消息」，由 summaryChars /
   * recentChars 表达。同时把 compactedAt 前移，消息流末尾的压缩分隔条才有依据。
   */
  recordCompactionResult(
    sessionId: string,
    options: { summaryChars?: number; recentChars?: number; tokens?: TokenUsage; cost?: number; at?: number },
  ) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    const at = options.at ?? Date.now()
    if (options.summaryChars !== undefined || options.recentChars !== undefined) {
      state.compactionMarker = {
        at,
        summaryChars: options.summaryChars ?? 0,
        recentChars: options.recentChars ?? 0,
      }
    }
    // 兼容旧调用方（只有 tokens 的场景，如 v1 风格事件）
    if (options.tokens) {
      state.compactionUsage = { tokens: options.tokens, cost: options.cost, at }
    }
    if (state.compactedAt === undefined || at > state.compactedAt) state.compactedAt = at
    this.notify([sessionId])
  }

  getSessionUsage(sessionId: string | null): SessionState['usage'] {
    if (!sessionId) return undefined
    return this.sessions.get(this.resolveKey(sessionId))?.usage
  }

  getCompactionUsage(sessionId: string | null): SessionState['compactionUsage'] {
    if (!sessionId) return undefined
    return this.sessions.get(this.resolveKey(sessionId))?.compactionUsage
  }

  getCompactionMarker(sessionId: string | null): SessionState['compactionMarker'] {
    if (!sessionId) return undefined
    return this.sessions.get(this.resolveKey(sessionId))?.compactionMarker
  }

  getContextUsageSnapshot(sessionId: string | null): SessionState['contextUsage'] {
    if (!sessionId) return undefined
    return this.sessions.get(this.resolveKey(sessionId))?.contextUsage
  }

  /**
   * 按消息 id 回填权威用量（来自 `session.context`）。
   *
   * 为什么需要它：走 aiagent 网关时首屏是「轮次骨架」投影，assistant 消息上的
   * `tokens` / `time.streamed` / `model` 被整段剥掉。后果是三处同时失效：
   *
   *   - 上下文圆环按字符估算（偏小数倍）
   *   - 轮次统计的输出 token / 缓存命中率 / TPS 全是「—」或 0
   *   - 底部 TPS 算不出生成窗口
   *
   * 这些值无法从任何前端可见数据反推（字符数估不出 token，part 没有时间戳），
   * 只能由 `session.context` 按 id 回填。骨架里回复用的是真实消息 id，所以能对上。
   *
   * 保守策略：只补**缺失或为 0** 的字段，绝不覆盖已有的非零实测值 ——
   * 完整拉取到的消息本身是权威的，回填数据（可能稍旧）不得覆盖它。
   */
  applyUsageBackfill(
    sessionId: string,
    snapshots: Map<string, { tokens: TokenUsage; cost: number; created?: number; streamed?: number; completed?: number }>,
  ) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state || snapshots.size === 0) return

    let changed = false
    const messages = state.messages.map(message => {
      const snapshot = snapshots.get(message.info.id)
      if (!snapshot || message.info.role !== 'assistant') return message

      const current = message.info.tokens
      const currentTotal =
        (current?.input ?? 0) +
        (current?.output ?? 0) +
        (current?.reasoning ?? 0) +
        (current?.cache?.read ?? 0) +
        (current?.cache?.write ?? 0)
      // 已有实测值：完整消息比回填数据权威，不动
      if (currentTotal > 0) return message

      const time = message.info.time ?? {}
      /**
       * 判断时间是否是「轮次时间」而非这条消息自己的时间。
       *
       * 骨架投影把 created 与 completed 都写成轮次起点（两者相等），streamed
       * 则完全缺失。这个等号会让统计代码判定为「尚未结算」并整条跳过 —— 于是
       * 即使 tokens 补上了，输出 token / 缓存命中率 / TPS 依然是空。
       *
       * 用 `created === completed` 而不是 `isCompressed` 判断：后者依赖
       * lightweight 标记，经过 store 往返可能丢失，而时间关系是数据本身的特征。
       */
      const isSyntheticTime =
        typeof time.created === 'number' &&
        typeof time.completed === 'number' &&
        time.completed <= time.created
      const nextTime = isSyntheticTime
        ? {
            created: snapshot.created ?? time.created,
            ...(snapshot.streamed != null ? { streamed: snapshot.streamed } : {}),
            ...(snapshot.completed != null ? { completed: snapshot.completed } : {}),
          }
        : {
            ...time,
            ...(time.streamed == null && snapshot.streamed != null ? { streamed: snapshot.streamed } : {}),
            ...(time.completed == null && snapshot.completed != null ? { completed: snapshot.completed } : {}),
          }
      changed = true
      return {
        ...message,
        info: {
          ...message.info,
          tokens: snapshot.tokens,
          cost: snapshot.cost || message.info.cost,
          time: nextTime,
        },
      } as typeof message
    })

    if (!changed) return
    state.messages = messages
    this.notify([sessionId])
  }

  markAllSessionsStale() {
    let updated = false
    for (const state of this.sessions.values()) {
      if (state.loadState !== 'loaded' || state.isStale) continue
      state.isStale = true
      updated = true
    }
    if (updated) this.notify('all')
  }

  /**
   * 只失效指定服务器的会话。重连是按 serverId 独立的，不该波及其它服务器的缓存。
   * sessionId key 形如 `${serverId}::${sessionId}`。
   */
  markServerSessionsStale(serverId: string) {
    let updated = false
    for (const [sessionId, state] of this.sessions) {
      // D8：按关联前缀匹配，多前缀归并的会话也能被正确标记
      if (!this.sessionBelongsToServer(sessionId, serverId)) continue
      if (state.loadState !== 'loaded' || state.isStale) continue
      state.isStale = true
      updated = true
    }
    if (updated) this.notify('all')
  }

  /**
   * 只失效单个会话（seq 缺口修复用）。
   *
   * 与 markServerSessionsStale 的区别：缺口是按 aggregate（会话）判定的，
   * 一台服务器上通常只有一个会话丢了事件，没必要把整台的缓存全部作废。
   */
  markSessionStale(sessionKey: string): boolean {
    const key = this.resolveKey(sessionKey)
    const state = this.sessions.get(key)
    if (!state || state.isStale) return false
    state.isStale = true
    this.notify([key])
    return true
  }

  /**
   * 该会话是否还有未定稿的 assistant 消息。
   *
   * 供运行态对账判断「服务端说结束了、本地还挂着一条没完的消息」——
   * 这种残留只靠内存里的信号清不掉，需要重拉消息尾部。
   */
  hasUnsettledAssistant(sessionKey: string): boolean {
    const state = this.sessions.get(this.resolveKey(sessionKey))
    if (!state) return false
    const last = state.messages.filter(m => m.info.role === 'assistant').at(-1)
    if (!last) return false
    return last.isStreaming || messageCompletedAt(last) == null
  }

  setLoadState(sessionId: string, loadState: SessionState['loadState']) {
    sessionId = this.resolveKey(sessionId, true)
    const state = this.ensureSession(sessionId)
    state.loadState = loadState
    if (loadState !== 'error') state.loadError = undefined
    this.notify([sessionId])
  }

  /**
   * 这一轮在本地是否「拼完整了」。
   *
   * 判据是**最后一个用户回合**里，assistant 消息全部定稿、且没有仍在流式的
   * part。v2 的正文是增量拼装出来的（`text.delta` / `tool.progress` 都是
   * ephemeral，丢了不补发），所以「本地有消息」不等于「本地内容完整」。
   *
   * 供轮次定稿时决定要不要跟服务端对一次：返回 false 就说明这一轮可能停在
   * 中途，需要重拉。
   */
  isLastTurnComplete(sessionId: string): boolean {
    const state = this.sessions.get(this.resolveKey(sessionId))
    if (!state || state.messages.length === 0) return false
    const messages = state.messages
    let lastUserIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === 'user') {
        lastUserIndex = i
        break
      }
    }
    // 没有用户回合（历史续段）：以末条 assistant 是否定稿为准
    const turnMessages = lastUserIndex === -1 ? messages : messages.slice(lastUserIndex + 1)
    const assistants = turnMessages.filter(m => m.info.role === 'assistant')
    if (assistants.length === 0) return false
    const allSettled = assistants.every(m => !m.isStreaming && messageCompletedAt(m) != null)
    if (!allSettled) return false
    /**
     * 消息定稿了，运行期建的 part 也可能没定稿。
     *
     * v2 的正文与推理是增量拼装的：`text.started` 建 part，`text.ended` 才补
     * `time.end`。而 `delta` 是 ephemeral（不重放、丢了检测不出来），`ended`
     * 也是单条事件，丢了同样不会重发。缺 `time.end` 的后果是连锁的：
     * `handlePartDelta` 靠它丢弃迟到增量，没有它就一直往 part 里追加 ——
     * 停止后内容还在流，两个端最后拼出不同结果。
     *
     * ⚠️ 判据只能是「**有** time 但**没有** end」。
     *
     * 历史快照里的 text part 根本不带 `time`（见 v2/message.ts 的
     * adaptAssistantParts），按「缺 end」判会把每个正常轮次都算成不完整，
     * 收敛点就会每轮都重拉一次。带 time 说明它是事件流建的，才该有 end。
     */
    for (const message of assistants) {
      for (const part of message.content) {
        if (part.type !== 'text' && part.type !== 'reasoning') continue
        const time = (part as { time?: { start?: number; end?: number } }).time
        if (time && time.end == null) return false
      }
    }
    return true
  }

  setLoadError(sessionId: string, error: MessageError) {
    sessionId = this.resolveKey(sessionId, true)
    const state = this.ensureSession(sessionId)
    state.loadState = 'error'
    state.loadError = error
    this.notify([sessionId])
  }

  // ============================================
  // Message CRUD
  // ============================================

  setMessages(
    sessionId: string,
    apiMessages: ApiMessageWithParts[],
    options?: {
      directory?: string
      title?: string
      hasMoreHistory?: boolean
      historyCursor?: string
      revertState?: ApiSession['revert'] | null
      shareUrl?: string
      compactedAt?: number
      compactionMarker?: { at: number; summaryChars: number; recentChars: number }
    },
  ) {
    sessionId = this.resolveKey(sessionId, true)
    const state = this.ensureSession(sessionId)
    const previousMessages = state.messages
    const previousById = new Map(previousMessages.map(message => [message.info.id, message]))

    state.messages = apiMessages.map(apiMessage => {
      const next = toUIMessage(apiMessage)
      const previous = previousById.get(next.info.id)
      // 定稿（completed）强制采用服务端；仅流式/未完成时不回退更长 live
      if (!previous || !shouldPreserveLiveParts(previous, next)) return next
      return {
        ...next,
        content: mergePartsPreferLiveText(previous.content, next.content),
        isStreaming: previous.isStreaming || next.isStreaming,
      }
    })
    state.loadState = 'loaded'
    state.loadError = undefined
    state.hasMoreHistory = options?.hasMoreHistory ?? false
    state.historyCursor = options?.historyCursor
    state.directory = options?.directory ?? ''
    if (options?.title !== undefined) state.title = options.title
    state.shareUrl = options?.shareUrl
    state.compactedAt = options?.compactedAt
    if (options?.compactionMarker !== undefined) state.compactionMarker = options.compactionMarker
    state.isStale = false

    // D5：HTTP 快照是权威全量，此前因乱序暂存的 delta 已被快照覆盖，丢弃以免重复回放
    this.pendingDeltas.delete(sessionId)

    // 整段替换：先归零缺口，再由 capSessionMessages 按本次实际裁剪量重新记账。
    state.trimmedCount = 0
    this.capSessionMessages(state)

    // 冷启动/刷新播种：整段加载后取最大用户消息时间作为锚点基线（单调，不会降级）。
    this.recordUserAnchorFromMessages(sessionId, options?.directory)

    // Revert 状态
    if (options?.revertState?.messageID) {
      const revertIndex = state.messages.findIndex(m => m.info.id === options.revertState!.messageID)
      if (revertIndex !== -1) {
        const revertedUserMessages = state.messages.slice(revertIndex).filter(isUserUIMessage)
        state.revertState = {
          messageId: options.revertState.messageID,
          history: revertedUserMessages.map(m => {
            return {
              messageId: m.info.id,
              text: this.extractUserText(m),
              attachments: this.extractUserAttachments(m),
              model: m.info.model,
              variant: m.info.model.variant,
              agent: m.info.agent,
            }
          }),
        }
      } else {
        // 撤销点已被裁剪掉（消息不在内存窗口内），清空以免悬空
        state.revertState = null
      }
    } else {
      state.revertState = null
    }

    // Streaming 检测
    const lastMsg = state.messages[state.messages.length - 1]
    if (lastMsg?.info.role === 'assistant') {
      const isLastMsgStreaming = !lastMsg.info.time?.completed
      state.isStreaming = isLastMsgStreaming
      if (isLastMsgStreaming) {
        const lastIndex = state.messages.length - 1
        state.messages[lastIndex] = { ...state.messages[lastIndex], isStreaming: true }
      }
    } else {
      state.isStreaming = false
    }

    this.notify([sessionId])
  }

  /**
   * 上滑加载历史：把更早的一页前插。
   *
   * 这里有意不调用 capSessionMessages —— 用户主动上滑就是为了看更早的内容，
   * 刚拉回来就裁掉会让上滑「拉不动」。单会话条数上限只在 append/SSE 增长路径
   * 作为内存兜底，历史加载路径的规模由用户滚动行为决定。
   */
  prependMessages(
    sessionId: string,
    apiMessages: ApiMessageWithParts[],
    hasMore: boolean,
    historyCursor?: string,
    options?: { compactedAt?: number; compaction?: SessionState['compactionMarker'] },
  ) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return

    const newMessages = apiMessages.map(toUIMessage)

    // 去重
    const existingIds = new Set(state.messages.map(m => m.info.id))
    const unique = newMessages.filter(m => !existingIds.has(m.info.id))

    if (unique.length > 0) {
      state.messages = [...unique, ...state.messages]
    }
    // 内存缺口被补上多少就扣减多少：本次真正新增的条数即补回的条数。
    // 空拉（unique 为 0）时缺口不变，但也不会因此把 hasMoreHistory 置真而
    // 触发下一轮空拉 —— 缺口为 0 时 loadMoreHistory 的进入条件自然不成立。
    if (state.trimmedCount) {
      state.trimmedCount = Math.max(0, state.trimmedCount - unique.length)
    }
    state.hasMoreHistory = hasMore
    state.historyCursor = historyCursor
    if (options?.compactedAt !== undefined) state.compactedAt = options.compactedAt
    if (options?.compaction !== undefined) state.compactionMarker = options.compaction

    this.notify([sessionId])
  }

  /**
   * 压缩较早轮次的过程内容。
   *
   * 只保留最近 `keepRecentTurns` 个用户轮次的完整过程；更早轮次的 assistant
   * 消息清空 reasoning 与工具大输出，只留渲染/统计所需的最小投影，并打上
   * `isCompressed` 标记。展开对应过程折叠块时按需回拉完整 parts。
   *
   * 只压缩已定稿（非流式、有 completed）的消息，避免误伤当前进行中的回合。
   * 返回是否发生实际变化，供调用方决定是否通知。
   */
  compressHistoricalTurns(sessionId: string, keepRecentTurns: number): boolean {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return false

    // 找轮次边界：每条 user 消息开启一个新轮次
    const turnStartIndexes: number[] = []
    for (let i = 0; i < state.messages.length; i++) {
      if (state.messages[i].info.role === 'user') turnStartIndexes.push(i)
    }
    if (turnStartIndexes.length <= keepRecentTurns) return false

    // 最近 keepRecentTurns 轮的起点，之前的所有消息都属可压缩区。
    // keepRecentTurns <= 0 时全部压缩；否则下标落在 [1, length) 内，安全。
    const compressBefore =
      keepRecentTurns <= 0 ? state.messages.length : turnStartIndexes[turnStartIndexes.length - keepRecentTurns]

    let changed = false
    const nextMessages = state.messages.slice()
    for (let i = 0; i < compressBefore; i++) {
      const message = nextMessages[i]
      if (message.info.role !== 'assistant') continue
      if (message.isStreaming || messageCompletedAt(message) == null) continue
      if (message.isCompressed) continue

      const { content, reasoningCount, stepCount } = compressMessageParts(message.content)
      nextMessages[i] = {
        ...message,
        content,
        isCompressed: true,
        compressedStats: { reasoningCount, stepCount },
      }
      changed = true
    }

    if (changed) {
      state.messages = nextMessages
      this.notify([sessionId])
    }
    return changed
  }

  /**
   * 用回拉到的完整消息替换内存中对应的压缩消息。
   *
   * 只替换 id 命中且当前仍存在的消息；替换后清掉 isCompressed 标记，使展开的
   * 折叠块恢复完整过程。不改动顺序，也不新增消息（回拉可能带回同轮其它消息，
   * 由调用方按需处理）。
   */
  hydrateMessages(sessionId: string, apiMessages: ApiMessageWithParts[]): boolean {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state || apiMessages.length === 0) return false

    const byId = new Map(apiMessages.map(message => [message.info.id, message]))
    let changed = false
    const nextMessages = state.messages.slice()

    for (let i = 0; i < nextMessages.length; i++) {
      const message = nextMessages[i]
      const incoming = byId.get(message.info.id)
      if (!incoming || !message.isCompressed) continue
      nextMessages[i] = {
        ...toUIMessage(incoming),
        isStreaming: message.isStreaming,
      }
      changed = true
    }

    if (changed) {
      state.messages = nextMessages
      this.notify([sessionId])
    }
    return changed
  }

  /**
   * 用「该轮完整消息」替换骨架轮次（展开骨架的「已处理」块时调用）。
   *
   * 与 `hydrateMessages` 的区别：
   * - hydrateMessages 是**原地替换**同 id 的压缩消息（老轮次压缩只是剥字段，消息还在）；
   * - 骨架路径把一整轮 40 条消息压成了 2 条，回拉时要**整段替换**并补回被丢掉
   *   的中间消息，否则展开后仍只有「用户 + 回复」。
   *
   * 定位方式：用该轮首条 user 消息 id 找到数组中的区间 [start, end)，
   * 其中 end 是下一条 user 消息（或数组末尾），替换区间内全部消息。
   */
  replaceTurnMessages(
    sessionId: string,
    turnUserMessageId: string,
    turnMessages: ApiMessageWithParts[],
  ): boolean {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state || turnMessages.length === 0) return false

    const messages = state.messages
    const startIndex = messages.findIndex(m => m.info.id === turnUserMessageId)
    if (startIndex === -1) return false

    let endIndex = messages.length
    for (let i = startIndex + 1; i < messages.length; i++) {
      if (messages[i].info.role === 'user') {
        endIndex = i
        break
      }
    }

    const previousById = new Map(messages.map(message => [message.info.id, message]))
    const replacement = turnMessages.map(message => ({
      ...toUIMessage(message),
      // 保留区间内原消息的流式标记（历史轮次正常都不在流式）
      isStreaming: previousById.get(message.info.id)?.isStreaming ?? false,
    }))

    state.messages = [...messages.slice(0, startIndex), ...replacement, ...messages.slice(endIndex)]
    this.notify([sessionId])
    return true
  }

  clearAll() {
    // 先收集再清空：通知需要原始的复合 key 列表
    const droppedKeys = [...this.sessions.keys()]
    this.sessions.clear()
    this.sessionAccessTime.clear()
    this.dirtyPartsBySession.clear()
    this.pendingDeltas.clear()
    this.idleGeneration.clear()
    this.messageIndexCache.clear()
    this.partIndexCache.clear()
    this.rawSessionToKey.clear()
    this.rawSessionServers.clear()
    this.optimisticMessageIds.clear()
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.pendingNotify = false
    droppedKeys.forEach(key => this.notifySessionEvicted(key))
    this.notifyImmediate('all')
  }

  clearSession(sessionId: string) {
    sessionId = this.resolveKey(sessionId)
    this.forgetOptimisticMessagesOf(sessionId)
    this.sessions.delete(sessionId)
    this.sessionAccessTime.delete(sessionId)
    this.dirtyPartsBySession.delete(sessionId)
    this.pendingDeltas.delete(sessionId)
    this.idleGeneration.delete(sessionId)
    this.messageIndexCache.delete(sessionId)
    this.partIndexCache.delete(sessionId)
    // 只清掉映射到本 key 的 raw 项；其它前缀若仍持有权威 key 则不动
    const raw = rawSessionIdOfKey(sessionId)
    if (this.rawSessionToKey.get(raw) === sessionId) {
      this.rawSessionToKey.delete(raw)
      this.rawSessionServers.delete(raw)
    }
    this.notifySessionEvicted(sessionId)
    this.notify([sessionId])
  }

  /** D19：移除某会话下所有乐观消息 id 标记（会话被清 / 淘汰时调用） */
  private forgetOptimisticMessagesOf(sessionKey: string): void {
    const state = this.sessions.get(sessionKey)
    if (!state) return
    for (const message of state.messages) {
      this.optimisticMessageIds.delete(message.info.id)
    }
  }

  setShareUrl(sessionId: string, url: string | undefined) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.shareUrl = url
    this.notify([sessionId])
  }

  // ============================================
  // SSE Event Handlers
  // ============================================

  handleMessageUpdated(apiMsg: ApiMessage) {
    const sessionKey = this.resolveKey(apiMsg.sessionID, true)
    const state = this.ensureSession(sessionKey)
    // 用户消息到达/更新：抬高会话与目录锚点（侧栏排序依据）
    this.recordUserMessageAnchor(sessionKey, apiMsg)
    // Replace an optimistic user row when the server's canonical message arrives.
    // Matching on text keeps this safe when the async prompt response has no message id.
    if (apiMsg.role === 'user') {
      const incomingText = Array.isArray(
        (apiMsg as unknown as { parts?: Array<{ type?: string; text?: string }> }).parts,
      )
        ? (apiMsg as unknown as { parts: Array<{ type?: string; text?: string }> }).parts
            .filter(part => part.type === 'text')
            .map(part => part.text ?? '')
            .join('')
        : undefined
      if (incomingText !== undefined) {
        const optimisticIndex = state.messages.findIndex(message => {
          // D19：用显式乐观 id 集合识别，而非永不命中的 msg-local- 前缀
          if (!this.optimisticMessageIds.has(message.info.id) || message.info.role !== 'user') return false
          return message.content.some(part => part.type === 'text' && part.text === incomingText)
        })
        if (optimisticIndex >= 0) {
          this.optimisticMessageIds.delete(state.messages[optimisticIndex].info.id)
          state.messages = state.messages.filter((_, index) => index !== optimisticIndex)
        }
      }
    }
    const existingIndex = state.messages.findIndex(m => m.info.id === apiMsg.id)

    if (existingIndex >= 0) {
      const oldMessage = state.messages[existingIndex]
      // D19：canonical 消息精确命中乐观占位（服务端复用了同一 id），清掉乐观标记
      if (apiMsg.role === 'user') this.optimisticMessageIds.delete(apiMsg.id)
      // 合并而非整体替换：v2 的 step.ended/step.failed 只带部分字段（tokens/cost/error），
      // 若整体替换会把 step.started 落下的 modelID/providerID/agent 清空。
      //
      // time 单独做深合并：v2 把一条 assistant 消息的时间拆成多个事件发
      // （step.started→created、step.streamed→streamed、step.ended→completed）。
      // 浅合并会用后来的 `{streamed}` / `{completed}` 把 created 整个顶掉，
      // 于是速度统计拿不到起点、分母退化成 0。
      const incomingInfo = toUIMessageInfo(apiMsg)
      const mergedTime =
        oldMessage.info.time || incomingInfo.time
          ? { ...oldMessage.info.time, ...incomingInfo.time }
          : undefined
      const newMessage: Message = {
        ...oldMessage,
        info: {
          ...oldMessage.info,
          ...incomingInfo,
          ...(mergedTime ? { time: mergedTime } : {}),
        } as Message['info'],
      }
      state.messages = [
        ...state.messages.slice(0, existingIndex),
        newMessage,
        ...state.messages.slice(existingIndex + 1),
      ]
    } else {
      const newMsg: Message = {
        info: toUIMessageInfo(apiMsg),
        content: [],
        isStreaming: apiMsg.role === 'assistant',
      }
      state.messages = [...state.messages, newMsg]
      this.capSessionMessages(state)
      if (apiMsg.role === 'assistant') {
        state.isStreaming = true
      }
    }

    this.notify([sessionKey])
    // D5：消息建立后，回放此前因乱序而暂存的 delta
    this.flushPendingDeltas(sessionKey)
  }

  handlePartUpdated(apiPart: ApiPart & { sessionID: string; messageID: string }) {
    const sessionKey = this.resolveKey(apiPart.sessionID)
    const state = this.sessions.get(sessionKey)
    if (!state) return

    let msgIndex = this.getMessageIndex(sessionKey, state).get(apiPart.messageID)
    if (msgIndex === undefined && apiPart.type === 'text') {
      const text = (apiPart as ApiPart & { text?: string }).text
      const optimisticIndex =
        typeof text === 'string'
          ? state.messages.findIndex(
              message =>
                this.optimisticMessageIds.has(message.info.id) &&
                message.info.role === 'user' &&
                message.content.some(part => part.type === 'text' && part.text === text),
            )
          : -1
      if (optimisticIndex >= 0) {
        const optimistic = state.messages[optimisticIndex]
        // D19：乐观占位被 canonical part 认领（id 改写为服务端 id），清掉乐观标记
        this.optimisticMessageIds.delete(optimistic.info.id)
        state.messages = [
          ...state.messages.slice(0, optimisticIndex),
          { ...optimistic, info: { ...optimistic.info, id: apiPart.messageID } },
          ...state.messages.slice(optimisticIndex + 1),
        ]
        this.messageIndexCache.delete(sessionKey)
        msgIndex = optimisticIndex
      }
    }
    if (msgIndex === undefined) return

    const oldMessage = state.messages[msgIndex]
    let newContent = [...oldMessage.content]
    const existingPartIndex = this.getPartIndex(sessionKey, apiPart.messageID, oldMessage.content).get(apiPart.id)
    const incoming = toUIPart(apiPart)
    // v2 content 模型只有 text/reasoning/tool：v1 专有 part（file/agent/step-* 等）折叠为空
    if (!incoming) return

    if (existingPartIndex !== undefined) {
      const existing = newContent[existingPartIndex]
      // tool part：v2 分片事件（input.started 带名 → called 带 input）需合并保留工具名。
      // 其它 part：未定稿时兼容前缀不回退；已 completed 强制服务端定稿。
      if (incoming.type === 'tool') {
        newContent[existingPartIndex] = mergeToolPart(existing, incoming)
      } else {
        newContent[existingPartIndex] = shouldPreserveLiveParts(oldMessage)
          ? mergePartPreferLiveText(existing, incoming)
          : incoming
      }
    } else {
      // 服务端 canonical part 的 id 以 `prt` 开头；乐观消息的 part id 为本地形式
      // （如 `${messageId}:text`）。同一消息内出现服务端 part 时，先清掉同类型的本地
      // 占位 part，避免正文重复（乐观文本 + 服务端文本）。
      if (isServerPartId(apiPart.id)) {
        newContent = newContent.filter(part => isServerPartId(part.id) || part.type !== incoming.type)
      }
      newContent.push(incoming)
    }

    const newMessage = { ...oldMessage, content: newContent }
    state.messages = [...state.messages.slice(0, msgIndex), newMessage, ...state.messages.slice(msgIndex + 1)]
    this.notify([sessionKey])
    // D5：part 建立后，回放此前因乱序而暂存的 delta
    this.flushPendingDeltas(sessionKey)
  }

  handlePartDelta(data: { sessionID: string; messageID: string; partID: string; field: string; delta: string }) {
    const sessionKey = this.resolveKey(data.sessionID)
    const state = this.sessions.get(sessionKey)
    if (!state) return

    const msgIndex = this.getMessageIndex(sessionKey, state).get(data.messageID)
    if (msgIndex === undefined) {
      // D5：消息尚未建立（delta 先于 message.updated 到达），暂存待回放
      this.bufferPendingDelta(sessionKey, data)
      return
    }
    const msg = state.messages[msgIndex]

    const partIndex = this.getPartIndex(sessionKey, data.messageID, msg.content).get(data.partID)
    if (partIndex === undefined) {
      // D5：part 尚未建立（delta 先于 part.updated 到达），暂存待回放
      this.bufferPendingDelta(sessionKey, data)
      return
    }
    const part = msg.content[partIndex]

    if (!(data.field === 'text' && 'text' in part)) return // Mutable 修改：直接拼接 text，不做不可变拷贝。
    // 一帧内可能收到多个 delta，只有最后的状态会被 React 看到。
    // flushDirtyMessages() 会在 notify 的 rAF 回调中统一生成新引用。

    // D-dup：part 已被 text.ended 定稿（带 end 时间）后，迟到的 delta 不再追加。
    // text.ended 携带完整文本并覆盖 part.text；若随后再有乱序/重发的 delta 被
    // 拼到完整文本后面，就会「完整文本 + 迟到增量」导致句子重复。已定稿的 part
    // 以服务端完整文本为准，丢弃后续增量。
    const partTime = (part as { time?: { end?: number } }).time
    if (partTime && typeof partTime.end === 'number') return
    ;(part as { text: string }).text += data.delta

    let dirtyPartsByMessage = this.dirtyPartsBySession.get(sessionKey)
    if (!dirtyPartsByMessage) {
      dirtyPartsByMessage = new Map<string, Set<string>>()
      this.dirtyPartsBySession.set(sessionKey, dirtyPartsByMessage)
    }
    let dirtyPartIds = dirtyPartsByMessage.get(data.messageID)
    if (!dirtyPartIds) {
      dirtyPartIds = new Set<string>()
      dirtyPartsByMessage.set(data.messageID, dirtyPartIds)
    }
    dirtyPartIds.add(data.partID)
    this.notify([sessionKey])
  }

  /** D5：把无法立即应用的 delta 暂存到该会话的待回放缓冲（有界） */
  private bufferPendingDelta(
    sessionKey: string,
    data: { messageID: string; partID: string; field: string; delta: string },
  ) {
    if (data.field !== 'text') return
    let bySession = this.pendingDeltas.get(sessionKey)
    if (!bySession) {
      bySession = new Map<string, string>()
      this.pendingDeltas.set(sessionKey, bySession)
    }
    const key = `${data.messageID}\0${data.partID}\0${data.field}`
    bySession.set(key, (bySession.get(key) ?? '') + data.delta)
    // 有界：单会话最多保留 MAX_PENDING_DELTAS 条待回放键，超出丢最旧的
    while (bySession.size > MAX_PENDING_DELTAS) {
      const oldest = bySession.keys().next()
      if (oldest.done) break
      bySession.delete(oldest.value)
    }
  }

  /**
   * D5：part 建立后回放该会话此前暂存的 delta。
   * 由 handlePartUpdated 在成功写入 part 后调用。只回放已能定位到 part 的条目，
   * 其余继续保留（其依赖的 part 可能稍后到达）。
   */
  private flushPendingDeltas(sessionKey: string) {
    const bySession = this.pendingDeltas.get(sessionKey)
    if (!bySession || bySession.size === 0) return
    const state = this.sessions.get(sessionKey)
    if (!state) return

    const messageIndex = this.getMessageIndex(sessionKey, state)
    const remaining = new Map<string, string>()
    let appliedAny = false

    for (const [key, delta] of bySession) {
      const [messageID, partID, field] = key.split('\0')
      if (field !== 'text') continue
      const msgIndex = messageIndex.get(messageID)
      if (msgIndex === undefined) {
        remaining.set(key, delta)
        continue
      }
      const msg = state.messages[msgIndex]
      const partIndex = this.getPartIndex(sessionKey, messageID, msg.content).get(partID)
      if (partIndex === undefined) {
        remaining.set(key, delta)
        continue
      }
      const part = msg.content[partIndex]
      if (!('text' in part)) continue
      // 与 handlePartDelta 同一条规则：已定稿（带 time.end）的 part 不再追加迟到增量。
      // 回放路径原先缺这一检查，于是「text.ended 到达后仍有在途 delta」时，
      // 这些增量会在回放阶段被补到完整文本后面 —— 表现为停止后内容还在往里流。
      const partTime = (part as { time?: { end?: number } }).time
      if (partTime && typeof partTime.end === 'number') continue
      ;(part as { text: string }).text += delta
      let dirtyPartsByMessage = this.dirtyPartsBySession.get(sessionKey)
      if (!dirtyPartsByMessage) {
        dirtyPartsByMessage = new Map<string, Set<string>>()
        this.dirtyPartsBySession.set(sessionKey, dirtyPartsByMessage)
      }
      let dirtyPartIds = dirtyPartsByMessage.get(messageID)
      if (!dirtyPartIds) {
        dirtyPartIds = new Set<string>()
        dirtyPartsByMessage.set(messageID, dirtyPartIds)
      }
      dirtyPartIds.add(partID)
      appliedAny = true
    }

    if (remaining.size === 0) this.pendingDeltas.delete(sessionKey)
    else this.pendingDeltas.set(sessionKey, remaining)
    if (appliedAny) this.notify([sessionKey])
  }

  handlePartRemoved(data: { partID: string; messageID: string; sessionID: string }) {
    const sessionKey = this.resolveKey(data.sessionID)
    const state = this.sessions.get(sessionKey)
    if (!state) return

    const msgIndex = this.getMessageIndex(sessionKey, state).get(data.messageID)
    if (msgIndex === undefined) return

    const oldMessage = state.messages[msgIndex]
    if (!oldMessage.content.some(p => p.id === data.partID)) return

    const newMessage = { ...oldMessage, content: oldMessage.content.filter(p => p.id !== data.partID) }
    state.messages = [...state.messages.slice(0, msgIndex), newMessage, ...state.messages.slice(msgIndex + 1)]
    this.notify([sessionKey])
  }

  /**
   * 会话已结束（idle/error）时，把仍处于 running/pending 的 tool part 落定为
   * interrupted。
   *
   * 后端 bash 工具子进程卡死或事件丢失时，服务端可能永远不补发该 part 的
   * message.part.updated，工具卡片就会永久转圈——即使会话状态已变 idle、侧栏
   * 状态点已熄灭。这里以会话结束信号为准做一次对账，把悬空的 part 收尾。
   *
   * 只改内存副本：服务端后续若补发权威 completed/error，会被 handlePartUpdated
   * 正常覆盖。running 态的输出已在 metadata.output 中，标记 interrupted 后由
   * 渲染层继续展示（registry 的 interruptedOutput 分支）。
   */
  private reconcileInFlightTools(state: SessionState, now: number): boolean {
    const { messages, changed } = reconcileInFlightTools(state.messages, now)
    if (changed) state.messages = messages
    return changed
  }

  /** 会话结束的公共收尾：清 streaming、补 completed、对账悬空工具。 */
  private finalizeSession(sessionId: string) {
    sessionId = this.resolveKey(sessionId)
    // D7：记录该会话收到结束信号的世代。发送路径在 await 返回后据此判断
    // 「本轮是否已在请求返回前就结束」，避免把已结束的会话重新置为 streaming。
    this.idleGeneration.set(sessionId, (this.idleGeneration.get(sessionId) ?? 0) + 1)
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.isStreaming = false
    const completedAt = Date.now()
    const { messages, changed } = finalizeStreamingMessages(state.messages, completedAt)
    if (changed) state.messages = messages
    this.reconcileInFlightTools(state, completedAt)
    this.notify([sessionId])
  }

  handleSessionIdle(sessionId: string) {
    this.finalizeSession(sessionId)
  }

  handleSessionError(sessionId: string) {
    this.finalizeSession(sessionId)
  }

  /**
   * 按 callID 落定某个工具 part（next.* 事件流的防御性对账）。
   *
   * 正常情况下工具终态由 message.part.updated 承载；若后端改用
   * session.next.tool.success/failed 或 session.next.shell.ended 描述结束，
   * 这里保证仍处于 running/pending 的对应 part 不会悬空。已有权威终态的
   * part 不覆盖（避免用不完整信息盖掉服务端结果）。
   */
  settleToolByCallID(
    sessionId: string,
    callID: string,
    outcome: { status: 'completed' | 'error'; output?: string; error?: string; metadata?: Record<string, unknown> },
  ): void {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return

    const now = Date.now()
    const { messages, changed } = settleToolByCallID(
      state.messages,
      callID,
      {
        status: outcome.status,
        output: outcome.output,
        error: outcome.error,
        metadata: outcome.metadata,
        errorFallback: i18n.t('message:toolPart.toolFailed'),
      },
      now,
    )
    if (changed) {
      state.messages = messages
      this.notify([sessionId])
    }
  }

  /**
   * 把工具执行中的进度 metadata 合到对应 part 上。
   *
   * 只在 part 当前是 running/pending 时更新：`session.tool.progress` 是
   * ephemeral 事件，可能与 `tool.success` 乱序到达；无条件覆盖会把已完成的
   * 工具改回「运行中」，表现为「跑完了又转回去」。
   *
   * metadata 是合并而非替换（{...old, ...new}）：不同进度事件可能各带一部分
   * 信息（先给 shellID，后给阶段/百分比）。
   */
  applyToolProgress(sessionId: string, callID: string, metadata?: Record<string, unknown>): void {
    if (!metadata || Object.keys(metadata).length === 0) return
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return

    /**
     * 只替换命中的那一条消息，其余保留引用。
     *
     * progress 事件在长命令期间每秒可能来多条，而会话可能有几千条消息。
     * 若每次都 `state.messages.map(...)` 全量重建，React 会认为整条会话都变了，
     * 每秒触发一次全量重渲染 —— 正是「一边跑命令一边滚动就卡」的成因。
     * 这里改成「定位命中消息 → 只换那一条」，未命中的消息对象引用不变，
     * 虚拟列表与 memo 化的消息行都能直接跳过。
     */
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const message = state.messages[i]
      let hitIndex = -1
      for (let j = 0; j < message.content.length; j += 1) {
        const part = message.content[j]
        if (part.type !== 'tool') continue
        const toolPart = part as Extract<typeof part, { type: 'tool' }>
        if ((toolPart as { callID?: string }).callID !== callID) continue
        const status = (toolPart.state as { status?: string })?.status
        if (status !== 'running' && status !== 'pending') continue
        hitIndex = j
        break
      }
      if (hitIndex === -1) continue

      const hitPart = message.content[hitIndex] as Extract<typeof message.content[number], { type: 'tool' }>
      const prevState = hitPart.state as unknown as Record<string, unknown>
      const nextContent = message.content.slice()
      nextContent[hitIndex] = {
        ...hitPart,
        state: {
          ...prevState,
          metadata: { ...((prevState.metadata as Record<string, unknown> | undefined) ?? {}), ...metadata },
        },
      } as (typeof message.content)[number]

      const nextMessages = state.messages.slice()
      nextMessages[i] = { ...message, content: nextContent }
      state.messages = nextMessages
      this.notify([sessionId])
      return
    }
  }

  // ============================================
  // Undo/Redo
  // ============================================

  truncateAfterRevert(sessionId: string) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state || !state.revertState) return

    const revertIndex = state.messages.findIndex(m => m.info.id === state.revertState!.messageId)
    if (revertIndex !== -1) {
      state.messages = state.messages.slice(0, revertIndex)
    }
    state.revertState = null
    this.notify([sessionId])
  }

  createSendRollbackSnapshot(sessionId: string): SendRollbackSnapshot | null {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state?.revertState) return null

    return {
      messages: state.messages.map(m => ({ ...m, content: [...m.content] })),
      revertState: {
        ...state.revertState,
        history: state.revertState.history.map(item => ({ ...item, attachments: [...item.attachments] })),
      },
    }
  }

  restoreSendRollback(sessionId: string, snapshot: SendRollbackSnapshot) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.messages = snapshot.messages.map(m => ({ ...m, content: [...m.content] }))
    state.revertState = snapshot.revertState
      ? {
          ...snapshot.revertState,
          history: snapshot.revertState.history.map(item => ({ ...item, attachments: [...item.attachments] })),
        }
      : null
    state.isStreaming = false
    this.notify([sessionId])
  }

  setRevertState(sessionId: string, revertState: RevertState | null) {
    sessionId = this.resolveKey(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.revertState = revertState
    this.notify([sessionId])
  }

  getLastUserMessageId(sessionId: string | null): string | null {
    const messages = this.getVisibleMessages(sessionId)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === 'user') return messages[i].info.id
    }
    return null
  }

  canUndo(sessionId: string | null): boolean {
    if (!sessionId) return false
    const state = this.sessions.get(this.resolveKey(sessionId))
    if (!state || state.isStreaming) return false
    return this.getVisibleMessages(sessionId).some(m => m.info.role === 'user')
  }

  canRedo(sessionId: string | null): boolean {
    if (!sessionId) return false
    const state = this.sessions.get(this.resolveKey(sessionId))
    if (!state || state.isStreaming) return false
    return (state.revertState?.history.length ?? 0) > 0
  }

  getRedoSteps(sessionId: string | null): number {
    if (!sessionId) return 0
    const state = this.sessions.get(this.resolveKey(sessionId))
    return state?.revertState?.history.length ?? 0
  }

  getCurrentRevertedContent(sessionId: string | null): RevertHistoryItem | null {
    if (!sessionId) return null
    const state = this.sessions.get(this.resolveKey(sessionId))
    const revertState = state?.revertState ?? null
    if (!revertState || revertState.history.length === 0) return null
    return revertState.history[0]
  }

  // ============================================
  // Streaming Control
  // ============================================

  setStreaming(sessionId: string, isStreaming: boolean, expectedIdleGeneration?: number) {
    sessionId = this.resolveKey(sessionId, true)
    // D7：置 streaming 前校验结束世代。若本轮在请求返回前已 idle（世代已变），
    // 不再置 true，避免已结束的会话永久显示 Working。
    if (
      isStreaming &&
      expectedIdleGeneration !== undefined &&
      (this.idleGeneration.get(sessionId) ?? 0) !== expectedIdleGeneration
    ) {
      return
    }
    const state = isStreaming ? this.ensureSession(sessionId) : this.sessions.get(sessionId)
    if (!state) return
    state.isStreaming = isStreaming
    this.notify([sessionId])
  }

  /** D7：读取会话的结束世代（发送前记录，await 后比对） */
  getIdleGeneration(sessionId: string): number {
    return this.idleGeneration.get(this.resolveKey(sessionId)) ?? 0
  }

  /**
   * 按**权威轮次记录**（消息列表里的 `type: "idle"`）落定流式态。
   *
   * 事件流负责「及时」：`session.execution.succeeded` 一到就收尾。但事件是
   * **易失**的 —— 断线重连期间的事件直接丢失（见服务端 `/api/event` 的描述：
   * "Volatile by contract: a slow consumer overflows and fails the stream, and
   * events during disconnection are missed"），隧道抖动、进程重启同理。
   *
   * 一旦收尾事件丢了，界面就会永远显示「生成中」：发送按钮变停止键、项目行
   * 一直转圈、消息永远半透明。而 idle 记录写在消息列表里，刷新即可恢复。
   *
   * 所以这里提供「按记录校正」的入口：只要有一条 idle 记录不早于最后一条
   * assistant 消息，就说明那一轮在服务端已经结束。
   *
   * ⚠️ 两个调用方的权威强度不同，不能共用同一套判据：
   *   - `/session/active` 全量对账（传 authoritativeIdleAt）：服务端**此刻**
   *     不把它列为运行中，就是已结束。可以直接落定。
   *   - 加载时的 `lastTurn`（不传）：那只是**上一次**读到的历史记录，可能比
   *     当前这一轮旧。此时必须保留「本地仍在流式」的否决权，否则会把正在跑的
   *     轮次误判成结束（界面突然从 Working 跳成 Worked，随后又被新 delta 打回）。
   *
   * @returns 是否真的改变了状态（供调用方决定是否要额外通知）
   */
  settleByAuthoritativeIdle(sessionId: string, authoritativeIdleAt?: number): boolean {
    sessionId = this.resolveKey(sessionId, true)
    const state = this.sessions.get(sessionId)
    if (!state) return false
    /**
     * 权威 idle 时间优先用调用方传入的（来自 `/session/active` 的实时对账），
     * 其次才是加载时记下的 `lastTurn`。
     *
     * 为什么需要外部传入：`lastTurn` 只在 loadSession 时写一次，之后不随 SSE
     * 更新。若只靠它，运行期发生「收尾事件丢失」时这里永远拿到旧值，判定
     * 会一直返回 false，界面就卡在「生成中」—— 正是这条兜底要解决的问题。
     */
    const idleAt = authoritativeIdleAt ?? state.lastTurn?.at
    if (idleAt === undefined) return false
    /**
     * 判据不能只看会话级的 `state.isStreaming`。
     *
     * 会话级标志与消息级状态是两套：`finalizeSession` / `setStreaming` 只清前者，
     * 而渲染层判「这一轮还在跑」看的是末条 assistant 的 `isStreaming` 与
     * `time.completed`（见 chatPageModel 的 assistantHasLiveWork）。只清会话级
     * 标志时，消息仍算未完成 → 界面继续显示「处理中」、过程块不收起。
     * 所以这里以**末条 assistant 是否仍未定稿**为准。
     */
    const lastAssistant = state.messages.filter(m => m.info.role === 'assistant').at(-1)
    if (!lastAssistant) return false
    const pendingMessage = lastAssistant.isStreaming || messageCompletedAt(lastAssistant) == null
    if (!pendingMessage) return false

    const lastAssistantAt = lastAssistant.info.time?.created ?? 0
    // idle 必须不早于最后一条 assistant：否则那是「上一轮」的结论，
    // 新一轮可能刚开始，不能据此落定。
    if (idleAt < lastAssistantAt) return false
    /**
     * 还要压住「本轮用户消息晚于 idle」的情形。
     *
     * 新一轮刚发出、助手还没吐第一个 token 时，末条 assistant 仍是上一轮的，
     * 上面那条时间校验会通过 —— 但 idle 显然属于上一轮。用本轮用户消息的时间
     * 兜住它，避免把刚开始的轮次误判成已结束。
     *
     * 注意不能改用「本地 isStreaming 为真就不落定」：那正是本次要修的形态 ——
     * 会话级标志与消息级状态可能不同步，卡死的轮次恰恰是标志已清、消息未定稿。
     */
    const lastUserAt = state.messages.filter(m => m.info.role === 'user').at(-1)?.info.time?.created ?? 0
    if (idleAt < lastUserAt) return false

    state.isStreaming = false
    /**
     * 把末条 assistant 定稿。
     *
     * 只清 isStreaming 是不够的：`messageCompletedAt` 仍为 undefined，渲染层
     * 依旧按「未完成」处理（显示处理中、正文带光标）。用权威 idle 时间补上
     * completed —— 那正是这一轮在服务端结束的时刻。
     */
    const completedAt = Math.max(idleAt, lastAssistantAt)
    const { messages, changed } = finalizeStreamingMessages(state.messages, completedAt)
    if (changed) state.messages = messages
    const lastIndex = state.messages.length - 1
    const lastMessage = state.messages[lastIndex]
    if (
      lastMessage?.info.role === 'assistant' &&
      messageCompletedAt(lastMessage) == null
    ) {
      state.messages = [
        ...state.messages.slice(0, lastIndex),
        {
          ...lastMessage,
          isStreaming: false,
          info: { ...lastMessage.info, time: { ...lastMessage.info.time, completed: completedAt } },
        },
      ]
    }
    // 会话已结束：把仍悬空的工具一并落定（独立于 SSE 事件，见方法注释）
    this.reconcileInFlightTools(state, completedAt)
    this.notify([sessionId])
    return true
  }

  // ============================================
  // Private Helpers
  // ============================================
  private extractUserText(message: Message): string {
    return message.content
      .filter((p): p is TextContent => p.type === 'text' && !p.synthetic)
      .map(p => p.text)
      .join('\n')
  }

  private extractUserAttachments(message: Message): Attachment[] {
    return message.info.role === 'user' ? (message.info.attachments ?? []) : []
  }
}

export const messageStore = new MessageStore()
