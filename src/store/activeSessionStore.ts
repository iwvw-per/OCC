// ============================================
// ActiveSessionStore - 追踪所有 session 的活跃状态
// ============================================
//
// 职责单一：只管 session 是否活跃、在等什么
//
// 数据来源：
// 1. GET /session/status → 全量 session 状态
// 2. GET /permission + GET /question → 补充等待中的 session
// 3. SSE session.status / permission.asked / question.asked 事件
// 4. applyOptimisticBusy → 点击发送/执行命令时的本地乐观置忙（可超时回收）
//
// 与 notificationStore 完全独立，不互相依赖

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import i18n from '../i18n'
import type { SessionStatus, SessionStatusMap } from '../types/api/session'

// ============================================
// Types
// ============================================

export interface PendingRequest {
  requestId: string
  sessionId: string
  type: 'permission' | 'question'
  description?: string
}

export interface ActiveSessionEntry {
  sessionId: string
  status: SessionStatus
  title?: string
  directory?: string
  /** session 当前等待的用户操作 */
  pendingAction?: {
    type: 'permission' | 'question'
    description?: string
  }
  /**
   * 该条 busy 的判定来源：'pending' = 仍有未回复的权限/问答请求（服务端已 idle，
   * 但请求还悬着）；'server' = 服务端报告 busy/retry；'local' = 仅有本地乐观标记。
   *
   * 项目行据此区分「还在跑」与「等着你回」：pending 不是运行，显示为彩色等待点，
   * 避免一个从没被点开过的权限请求让折叠的目录一直转圈。
   */
  source: 'server' | 'pending' | 'local'
}

/**
 * 本地乐观置忙的条目在「没有任何事件佐证」时的存活上限。
 *
 * 点击发送瞬间、服务端 status 到达之前会先本地置 busy（按钮立即变成停止）。
 * 若这一轮其实没有真正开跑（请求失败、命令只改本地状态），又恰好没有任何
 * status/idle 事件来收尾，这条条目就会永远留下，折叠的项目行一直显示运行中。
 * 超时后清掉；真正的 busy 会不断收到事件（message/part/tool），从而持续续期。
 */
export const OPTIMISTIC_BUSY_TTL_MS = 2 * 60 * 1000

interface SessionMetaEntry {
  sessionId: string
  title?: string
  directory?: string
}

interface ActiveSessionState {
  statusMap: SessionStatusMap
  initialized: boolean
}

type Subscriber = () => void

function isSameBusySessions(a: ActiveSessionEntry[], b: ActiveSessionEntry[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (left.sessionId !== right.sessionId) return false
    if (left.title !== right.title || left.directory !== right.directory) return false
    if (left.pendingAction?.type !== right.pendingAction?.type) return false
    if (left.pendingAction?.description !== right.pendingAction?.description) return false
    if (left.source !== right.source) return false
    if (left.status.type !== right.status.type) return false
    if (left.status.type === 'retry' && right.status.type === 'retry') {
      if (
        left.status.attempt !== right.status.attempt ||
        left.status.message !== right.status.message ||
        left.status.next !== right.status.next
      ) {
        return false
      }
    }
  }
  return true
}

// ============================================
// Store
// ============================================

class ActiveSessionStore {
  private state: ActiveSessionState = {
    statusMap: {},
    initialized: false,
  }
  private subscribers = new Set<Subscriber>()

  // session 元信息缓存（title, directory）
  private sessionMeta = new Map<string, { title?: string; directory?: string }>()

  // 未回复的 permission/question 请求 — requestId → PendingRequest
  private pendingRequests = new Map<string, PendingRequest>()

  // 服务端已报告 idle，但因有未回复请求而暂缓移出的 session
  private deferredIdleSessions = new Set<string>()

  /**
   * 纯本地乐观置忙（尚无服务端 status 佐证）的 session → 最后一次被佐证的时间。
   *
   * 有该标记的条目在 recomputeDerived 中会被加上空闲超时：超过
   * OPTIMISTIC_BUSY_TTL_MS 没有任何事件就清掉，避免「点了发送但这一轮没真正
   * 开跑」的会话永远让折叠的项目行转圈。收到服务端 status / 任何事件时刷新。
   */
  private optimisticBusyAt = new Map<string, number>()

  /** 有服务端 status（busy/retry，或服务端快照里列出）佐证的 session */
  private serverBusySessions = new Set<string>()

  // 派生数据缓存
  private cachedBusySessions: ActiveSessionEntry[] = []
  private cachedBusyCount: number = 0

  subscribe = (callback: Subscriber): (() => void) => {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  private notify() {
    this.recomputeDerived()
    this.subscribers.forEach(cb => {
      cb()
    })
  }

  private recomputeDerived() {
    // 先把 pending 按 sessionId 建索引：原实现对每个 busy session 都线性扫一遍
    // pendingRequests，整体 O(busy × pending)。建一次索引后查询为 O(1)，
    // 整体降为 O(busy + pending)。
    const pendingBySession = new Map<string, PendingRequest>()
    for (const req of this.pendingRequests.values()) {
      if (!pendingBySession.has(req.sessionId)) pendingBySession.set(req.sessionId, req)
    }

    // 纯本地乐观的 busy 条目超过空闲上限就回收：没有服务端 status 佐证，
    // 也没有任何事件为它续期，说明这一轮并没有真正在跑。
    if (this.optimisticBusyAt.size > 0) {
      const now = Date.now()
      let changed = false
      const nextMap = { ...this.state.statusMap }
      for (const [sessionId, at] of this.optimisticBusyAt) {
        if (now - at <= OPTIMISTIC_BUSY_TTL_MS) continue
        this.optimisticBusyAt.delete(sessionId)
        if (nextMap[sessionId] && !this.hasServerEvidence(sessionId)) {
          delete nextMap[sessionId]
          changed = true
        }
      }
      if (changed) this.state = { ...this.state, statusMap: nextMap }
    }

    const entries = Object.entries(this.state.statusMap)
      .filter(([, status]) => status.type === 'busy' || status.type === 'retry')
      .map(([sessionId, status]) => {
        const meta = this.sessionMeta.get(sessionId)
        // 从索引查 pending action
        const pending = pendingBySession.get(sessionId)
        // 优先级：服务端 status > 仍有 pending 请求 > 纯本地乐观标记。
        // pending 优先于 local：等待用户回复的会话不应被当成「正在跑」。
        const source: ActiveSessionEntry['source'] = this.serverBusySessions.has(sessionId)
          ? 'server'
          : pending
            ? 'pending'
            : 'local'
        return {
          sessionId,
          status,
          title: meta?.title,
          directory: meta?.directory,
          pendingAction: pending ? { type: pending.type, description: pending.description } : undefined,
          source,
        } as ActiveSessionEntry
      })
    // 内容不变时复用旧数组引用，避免 useBusySessions 订阅方因引用抖动重渲染
    if (!isSameBusySessions(this.cachedBusySessions, entries)) {
      this.cachedBusySessions = entries
    }
    this.cachedBusyCount = entries.length
  }

  /** 该 session 是否已有服务端/事件佐证的 busy（而非纯本地乐观标记） */
  private hasServerEvidence(sessionId: string): boolean {
    return this.serverBusySessions.has(sessionId) || this.hasPendingForSession(sessionId)
  }

  /** 记录/刷新「该 session 有服务端或事件佐证」的标记，并停止乐观超时计时 */
  private markEvidence(sessionId: string) {
    this.serverBusySessions.add(sessionId)
    this.optimisticBusyAt.delete(sessionId)
  }

  private hasPendingForSession(sessionId: string): boolean {
    for (const req of this.pendingRequests.values()) {
      if (req.sessionId === sessionId) return true
    }
    return false
  }

  getSnapshot = (): ActiveSessionState => this.state
  getBusySessionsSnapshot = (): ActiveSessionEntry[] => this.cachedBusySessions
  getBusyCountSnapshot = (): number => this.cachedBusyCount

  /**
   * 取单个 session 的 status 引用。
   * statusMap 未命中时返回 undefined，两者引用都稳定，
   * 供 useSessionStatus 作为 useSyncExternalStore 的 getSnapshot。
   */
  getSessionStatus(sessionId: string): SessionStatus | undefined {
    return this.state.statusMap[sessionId]
  }

  /**
   * 取单个 session 的活跃条目。
   * cachedBusySessions 内容不变时数组引用稳定，且 recomputeDerived 复用旧数组，
   * 因此未命中（undefined）与命中（同一元素引用）都满足 useSyncExternalStore 的稳定引用契约。
   */
  getBusySessionEntry(sessionId: string): ActiveSessionEntry | undefined {
    return this.cachedBusySessions.find(entry => entry.sessionId === sessionId)
  }

  private applyStatusSnapshot(statusMap: SessionStatusMap, baseMap: SessionStatusMap): SessionStatusMap {
    const nextMap = { ...baseMap }

    for (const [sessionId, status] of Object.entries(statusMap)) {
      if (status.type === 'idle') {
        delete nextMap[sessionId]
        continue
      }

      nextMap[sessionId] = status.type === 'retry' ? { ...status } : { type: 'busy' }
    }

    return nextMap
  }

  // ============================================
  // 初始化：从 API 拉取全量状态
  // ============================================

  /**
   * 全量初始化。
   *
   * 传入 serverId 时按「服务器作用域」替换：只清掉该服务器名下的条目，保留其它
   * 服务器。多台服务器同时首次连接会各自调用本方法，若不带 serverId 则每次都以
   * 空表为基线整表覆盖，后完成者会把其它服务器的 Working 条目清空（D1）。
   * 不带 serverId 时为全局替换，仅用于单服务器 / 测试场景。
   */
  initialize(statusMap: SessionStatusMap, serverId?: string) {
    const base = serverId ? this.statusMapExceptServer(serverId) : {}
    this.recordServerEvidence(statusMap)
    this.state = {
      statusMap: this.applyStatusSnapshot(statusMap, base),
      initialized: true,
    }
    this.notify()
  }

  /** 把快照里的非 idle 条目记为「服务端佐证」，并停止它们的乐观超时 */
  private recordServerEvidence(statusMap: SessionStatusMap) {
    for (const [sessionId, status] of Object.entries(statusMap)) {
      if (status.type === 'idle') {
        this.serverBusySessions.delete(sessionId)
        continue
      }
      this.markEvidence(sessionId)
    }
  }

  /** 取出不属于指定服务器的 status 条目（保留其它服务器状态） */
  private statusMapExceptServer(serverId: string): SessionStatusMap {
    const prefix = `${serverId}::`
    const base: SessionStatusMap = {}
    for (const [key, status] of Object.entries(this.state.statusMap)) {
      if (!key.startsWith(prefix)) base[key] = status
    }
    return base
  }

  // ============================================
  // 范围刷新：返回值不是全量状态，只更新这次明确返回的 session
  // ============================================

  mergeStatusRefresh(statusMap: SessionStatusMap) {
    this.recordServerEvidence(statusMap)
    this.state = {
      statusMap: this.applyStatusSnapshot(statusMap, this.state.statusMap),
      initialized: true,
    }
    this.notify()
  }

  /**
   * 用某台服务器的权威全量状态替换它名下的所有条目。
   *
   * 服务端 /session/status（不带 directory）返回该实例所有 busy/retry 会话，
   * idle 的缺席即代表已结束。mergeStatusRefresh 只增不删，无法清掉后台冻结期间
   * 残留的陈旧 busy 条目；回前台对齐时必须整台替换，同时保留其它服务器的状态。
   * 该服务器仍有未回复 pending 的会话予以保留，避免把等待中的条目误清。
   */
  replaceServerStatus(serverId: string, statusMap: SessionStatusMap) {
    const prefix = `${serverId}::`
    // 该服务器的旧佐证整体作废，再按本次快照重建
    for (const sessionId of [...this.serverBusySessions]) {
      if (sessionId.startsWith(prefix)) this.serverBusySessions.delete(sessionId)
    }
    for (const sessionId of [...this.optimisticBusyAt.keys()]) {
      if (sessionId.startsWith(prefix)) this.optimisticBusyAt.delete(sessionId)
    }
    this.recordServerEvidence(statusMap)
    const nextMap: SessionStatusMap = {}
    for (const [key, status] of Object.entries(this.state.statusMap)) {
      if (!key.startsWith(prefix)) nextMap[key] = status
    }
    const replaced = this.applyStatusSnapshot(statusMap, nextMap)
    // 仍有未回复 pending 的会话要保留，否则等待用户操作的条目会被误清
    for (const sessionId of this.pendingRequestSessionIds()) {
      if (!sessionId.startsWith(prefix)) continue
      if (!replaced[sessionId]) {
        replaced[sessionId] = { type: 'busy' }
        this.serverBusySessions.delete(sessionId)
      }
    }
    this.state = { statusMap: replaced, initialized: true }
    this.notify()
  }

  private pendingRequestSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const req of this.pendingRequests.values()) ids.add(req.sessionId)
    return ids
  }

  // ============================================
  // 初始化：从 /permission + /question API 补充
  // ============================================

  initializePendingRequests(
    permissions: Array<{ id: string; sessionID: string; permission: string; patterns?: string[] }>,
    questions: Array<{ id: string; sessionID: string; questions?: Array<{ header?: string }> }>,
    serverId?: string,
  ) {
    // 带 serverId 时只保留其它服务器的 pending，避免多台服务器并发初始化时
    // 后者清掉前者的待处理请求（D1）。不带时全局清空（单服务器 / 测试）。
    const base = serverId ? this.pendingRequestsExceptServer(serverId) : new Map<string, PendingRequest>()
    const deferred = serverId ? this.deferredIdleExceptServer(serverId) : new Set<string>()
    this.applyPendingSnapshot(permissions, questions, base, deferred)
  }

  private pendingRequestsExceptServer(serverId: string): Map<string, PendingRequest> {
    const prefix = `${serverId}::`
    const base = new Map<string, PendingRequest>()
    for (const [id, req] of this.pendingRequests) {
      if (!req.sessionId.startsWith(prefix)) base.set(id, req)
    }
    return base
  }

  private deferredIdleExceptServer(serverId: string): Set<string> {
    const prefix = `${serverId}::`
    const base = new Set<string>()
    for (const id of this.deferredIdleSessions) {
      if (!id.startsWith(prefix)) base.add(id)
    }
    return base
  }

  // ============================================
  // 范围刷新：保留这次范围外已知的 pending request
  // ============================================

  mergePendingRequests(
    permissions: Array<{ id: string; sessionID: string; permission: string; patterns?: string[] }>,
    questions: Array<{ id: string; sessionID: string; questions?: Array<{ header?: string }> }>,
  ) {
    this.applyPendingSnapshot(permissions, questions, new Map(this.pendingRequests), new Set(this.deferredIdleSessions))
  }

  private applyPendingSnapshot(
    permissions: Array<{ id: string; sessionID: string; permission: string; patterns?: string[] }>,
    questions: Array<{ id: string; sessionID: string; questions?: Array<{ header?: string }> }>,
    pendingRequests: Map<string, PendingRequest>,
    deferredIdleSessions: Set<string>,
  ) {
    let changed = false
    const newMap = { ...this.state.statusMap }

    for (const p of permissions) {
      const desc = p.patterns?.length ? `${p.permission}: ${p.patterns[0]}` : p.permission
      pendingRequests.set(p.id, {
        requestId: p.id,
        sessionId: p.sessionID,
        type: 'permission',
        description: desc,
      })
      if (!newMap[p.sessionID] || newMap[p.sessionID].type === 'idle') {
        newMap[p.sessionID] = { type: 'busy' }
        deferredIdleSessions.add(p.sessionID)
        // 由 pending 撑起的 busy 不是服务端在跑（见 addPendingRequest）
        this.serverBusySessions.delete(p.sessionID)
        changed = true
      }
    }

    for (const q of questions) {
      const desc = q.questions?.[0]?.header || i18n.t('chat:activeSession.waitingForInput')
      pendingRequests.set(q.id, {
        requestId: q.id,
        sessionId: q.sessionID,
        type: 'question',
        description: desc,
      })
      if (!newMap[q.sessionID] || newMap[q.sessionID].type === 'idle') {
        newMap[q.sessionID] = { type: 'busy' }
        deferredIdleSessions.add(q.sessionID)
        // 由 pending 撑起的 busy 不是服务端在跑（见 addPendingRequest）
        this.serverBusySessions.delete(q.sessionID)
        changed = true
      }
    }

    this.pendingRequests = pendingRequests
    this.deferredIdleSessions = deferredIdleSessions

    if (changed) {
      this.state = { ...this.state, statusMap: newMap }
    }
    this.notify()
  }

  // ============================================
  // SSE 事件：permission/question asked → 注册 pending
  // ============================================

  addPendingRequest(requestId: string, sessionId: string, type: 'permission' | 'question', description?: string) {
    this.pendingRequests.set(requestId, { requestId, sessionId, type, description })
    // 确保 session 在 busy 列表
    if (!this.state.statusMap[sessionId] || this.state.statusMap[sessionId].type === 'idle') {
      const newMap = { ...this.state.statusMap, [sessionId]: { type: 'busy' as const } }
      this.deferredIdleSessions.add(sessionId)
      // 这条 busy 只由「未回复请求」撑着，不是服务端在跑：不能算服务端佐证，
      // 否则后续再也没有任何事件会把它清掉。
      this.serverBusySessions.delete(sessionId)
      this.optimisticBusyAt.delete(sessionId)
      this.state = { ...this.state, statusMap: newMap }
    }
    this.notify()
  }

  // ============================================
  // SSE 事件：permission/question replied → 移除 pending
  // ============================================

  resolvePendingRequest(requestId: string) {
    const req = this.pendingRequests.get(requestId)
    if (!req) return
    this.pendingRequests.delete(requestId)

    // 检查该 session 是否还有其他 pending，没有且 deferred 就移出 busy
    if (this.deferredIdleSessions.has(req.sessionId) && !this.hasPendingForSession(req.sessionId)) {
      this.deferredIdleSessions.delete(req.sessionId)
      const newMap = { ...this.state.statusMap }
      delete newMap[req.sessionId]
      // 该条目只是「服务端已 idle、等这个请求」的临时占位：请求处理完就彻底移除，
      // 否则它会以「无服务端佐证」的 busy 一直留在项目行上转圈。
      this.serverBusySessions.delete(req.sessionId)
      this.optimisticBusyAt.delete(req.sessionId)
      this.state = { ...this.state, statusMap: newMap }
    }
    this.notify()
  }

  /**
   * 按权威快照对账指定 session 的 pending（D9）。
   *
   * 组件层（usePermissionHandler / useChatSession）的 refresh 只更新自己的
   * 组件 state，从不回写本 store，导致服务端已不再返回的请求长期残留：Working
   * 列表的 pendingAction 常亮、deferredIdleSessions 里的会话永远无法转 idle。
   * 这里以「服务端全量快照」为准，清掉这些 session 名下不在权威集合里的 pending。
   *
   * sessionIds：要参与对账的会话（复合 key）；authoritativeIds：服务端当前仍存在的
   * 请求 id 集合。只清属于 sessionIds 的条目，不误伤其它会话。
   */
  reconcilePendingRequests(sessionIds: ReadonlySet<string>, authoritativeIds: ReadonlySet<string>) {
    let changed = false
    for (const [requestId, req] of [...this.pendingRequests]) {
      if (!sessionIds.has(req.sessionId)) continue
      if (authoritativeIds.has(requestId)) continue
      this.pendingRequests.delete(requestId)
      changed = true
    }
    if (!changed) return
    // 清理后：仍有未回复 pending 的 deferred 会话保留，其余若已 deferred 则移出 busy
    for (const sessionId of [...this.deferredIdleSessions]) {
      if (!this.hasPendingForSession(sessionId)) {
        this.deferredIdleSessions.delete(sessionId)
        const newMap = { ...this.state.statusMap }
        delete newMap[sessionId]
        this.serverBusySessions.delete(sessionId)
        this.optimisticBusyAt.delete(sessionId)
        this.state = { ...this.state, statusMap: newMap }
      }
    }
    this.notify()
  }

  // ============================================
  // SSE 事件：session status 更新
  // ============================================

  updateStatus(sessionId: string, status: SessionStatus): boolean {
    const newMap = { ...this.state.statusMap }
    let cleared = false

    if (status.type === 'idle') {
      // 服务端明确 idle：旧的服务端佐证作废，未回复的 pending 仍保留条目
      this.serverBusySessions.delete(sessionId)
      this.optimisticBusyAt.delete(sessionId)
      if (this.hasPendingForSession(sessionId)) {
        this.deferredIdleSessions.add(sessionId)
      } else {
        this.deferredIdleSessions.delete(sessionId)
        delete newMap[sessionId]
        cleared = true
      }
    } else if (status.type === 'retry') {
      this.deferredIdleSessions.delete(sessionId)
      this.markEvidence(sessionId)
      newMap[sessionId] = { ...status }
    } else {
      this.deferredIdleSessions.delete(sessionId)
      this.markEvidence(sessionId)
      newMap[sessionId] = { type: 'busy' }
    }

    this.state = { ...this.state, statusMap: newMap }
    this.notify()
    return cleared
  }

  /**
   * 本地乐观置忙：点击发送 / 执行命令时立刻把会话标成 busy，让停止按钮即时可用。
   *
   * 这类条目不来自服务端，因此单独计时（OPTIMISTIC_BUSY_TTL_MS）：期间收到任何
   * 服务端 status 或会话事件（见 touchSession）都会被提升为「有佐证」，不会再超时；
   * 一直没有任何佐证的条目会被回收，避免项目行永远显示「正在运行」。
   */
  applyOptimisticBusy(sessionId: string) {
    if (this.serverBusySessions.has(sessionId)) return
    this.optimisticBusyAt.set(sessionId, Date.now())
    if (this.state.statusMap[sessionId]?.type === 'busy') {
      this.notify()
      return
    }
    this.state = {
      ...this.state,
      statusMap: { ...this.state.statusMap, [sessionId]: { type: 'busy' } },
    }
    this.notify()
  }

  /**
   * 会话产生了真实活动（消息/part/工具事件）：证明它确实在跑。
   *
   * 这里必须同时 markEvidence：只刷新乐观计时是不够的 —— 条目会一直停在
   * source='local'，超过 OPTIMISTIC_BUSY_TTL_MS 就被回收。表现为「会话正在跑，
   * 项目行却不转圈；跑完之后反而冒出状态点」。发送消息时我们只做本地乐观置忙，
   * 服务端不一定每次都补 session.status，因此消息/工具事件才是更常见的佐证。
   */
  touchSession(sessionId: string) {
    if (this.serverBusySessions.has(sessionId)) return
    if (!this.state.statusMap[sessionId]) return
    this.markEvidence(sessionId)
    this.notify()
  }

  removeSession(sessionId: string) {
    let changed = false
    let nextMap = this.state.statusMap

    if (nextMap[sessionId]) {
      nextMap = { ...nextMap }
      delete nextMap[sessionId]
      changed = true
    }

    for (const [requestId, request] of this.pendingRequests) {
      if (request.sessionId !== sessionId) continue
      this.pendingRequests.delete(requestId)
      changed = true
    }

    if (this.deferredIdleSessions.delete(sessionId)) changed = true
    if (this.sessionMeta.delete(sessionId)) changed = true
    if (this.serverBusySessions.delete(sessionId)) changed = true
    if (this.optimisticBusyAt.delete(sessionId)) changed = true

    if (!changed) return
    this.state = { ...this.state, statusMap: nextMap }
    this.notify()
  }

  /**
   * 没有任何 SSE 事件佐证的乐观条目会被回收。由 global events 的低频心跳调用。
   * 返回是否真的回收了条目（用于避免无意义重渲染）。
   */
  expireStaleOptimisticEntries(now = Date.now()): boolean {
    if (this.optimisticBusyAt.size === 0) return false
    let expired = false
    const nextMap = { ...this.state.statusMap }
    for (const [sessionId, at] of [...this.optimisticBusyAt]) {
      if (now - at <= OPTIMISTIC_BUSY_TTL_MS) continue
      if (this.hasServerEvidence(sessionId)) continue
      this.optimisticBusyAt.delete(sessionId)
      if (nextMap[sessionId]) {
        delete nextMap[sessionId]
        expired = true
      }
    }
    if (expired) {
      this.state = { ...this.state, statusMap: nextMap }
      this.notify()
    }
    return expired
  }

  // ============================================
  // Session 元信息管理
  // ============================================

  setSessionMeta(sessionId: string, title?: string, directory?: string) {
    const existing = this.sessionMeta.get(sessionId)
    const newTitle = title ?? existing?.title
    const newDir = directory ?? existing?.directory
    if (newTitle !== existing?.title || newDir !== existing?.directory) {
      this.sessionMeta.set(sessionId, { title: newTitle, directory: newDir })
      this.notify()
    }
  }

  setSessionMetaBulk(entries: SessionMetaEntry[]) {
    let changed = false

    for (const entry of entries) {
      const existing = this.sessionMeta.get(entry.sessionId)
      const newTitle = entry.title ?? existing?.title
      const newDir = entry.directory ?? existing?.directory

      if (newTitle !== existing?.title || newDir !== existing?.directory) {
        this.sessionMeta.set(entry.sessionId, { title: newTitle, directory: newDir })
        changed = true
      }
    }

    if (changed) {
      this.notify()
    }
  }

  getSessionMeta(sessionId: string) {
    return this.sessionMeta.get(sessionId)
  }

  getBusySessions(): ActiveSessionEntry[] {
    return this.cachedBusySessions
  }

  get busyCount(): number {
    return this.cachedBusyCount
  }
}

// ============================================
// Singleton & React Hooks
// ============================================

export const activeSessionStore = new ActiveSessionStore()

export function useActiveSessionStore() {
  return useSyncExternalStore(activeSessionStore.subscribe, activeSessionStore.getSnapshot)
}

export function useBusySessions(): ActiveSessionEntry[] {
  return useSyncExternalStore(activeSessionStore.subscribe, activeSessionStore.getBusySessionsSnapshot)
}

/**
 * 只返回「确实在跑」的会话：排除仅因未回复权限/问答而停在 busy 的条目。
 *
 * 项目行的运行中图标用它，避免一个从没被点开过的权限请求让折叠的目录
 * 一直转圈（它并没有在运行，只是在等你回复）。
 */
export function useRunningSessions(): ActiveSessionEntry[] {
  const busy = useBusySessions()
  return useMemo(() => busy.filter(entry => entry.source !== 'pending'), [busy])
}

export function useBusyCount(): number {
  return useSyncExternalStore(activeSessionStore.subscribe, activeSessionStore.getBusyCountSnapshot)
}

/**
 * 按 sessionId 查活跃状态，不活跃时返回 undefined。
 *
 * 说明：仍使用 store 级别的 subscribe（任意 session 变化都会触发本 hook 回调），
 * 但 getSnapshot 返回的是 cachedBusySessions 中已缓存的元素引用，未命中时为 undefined，
 * 两者引用都稳定，因此 useSyncExternalStore 不会因引用抖动导致额外渲染。
 * 若后续要彻底避免无关 session 变化带来的回调开销，可在 store 内增加按 sessionId 的订阅表
 * （参考 messageStore.subscribeSession）。
 */
export function useSessionActiveEntry(sessionId: string): ActiveSessionEntry | undefined {
  const getSnapshot = useCallback(() => activeSessionStore.getBusySessionEntry(sessionId), [sessionId])
  return useSyncExternalStore(activeSessionStore.subscribe, getSnapshot)
}

/**
 * 只订阅单个 session 的 status。
 *
 * 任意其它 session 的 busy/retry 变化都不会让本组件重渲染；getSnapshot 直接返回
 * statusMap 里的元素引用，未变化时引用稳定，不会触发额外渲染。
 */
export function useSessionStatus(sessionId: string | null): SessionStatus | undefined {
  const getSnapshot = useCallback(
    () => (sessionId ? activeSessionStore.getSessionStatus(sessionId) : undefined),
    [sessionId],
  )
  return useSyncExternalStore(activeSessionStore.subscribe, getSnapshot)
}
