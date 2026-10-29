// ============================================
// useGlobalEvents - 全局 SSE 事件订阅
// ============================================
//
// 职责：
// 1. 订阅全局 SSE 事件流
// 2. 将事件分发到 messageStore
// 3. 追踪子 session 关系（用于权限请求冒泡）
// 4. 与具体 session 无关，处理所有 session 的事件

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { logger } from '../utils/logger'
import i18n from '../i18n'
import { messageStore, childSessionStore, paneLayoutStore, serverStore } from '../store'
import { activeSessionStore } from '../store/activeSessionStore'
import { backgroundJobStore } from '../store/backgroundJobStore'
import { parseBackgroundNotice } from '../features/workStatus/backgroundJobs'
import { notificationStore } from '../store/notificationStore'
import { readWatermarkStore } from '../store/readWatermarkStore'
import { soundStore } from '../store/soundStore'
import { playNotificationSoundDeduped } from '../utils/notificationSoundBridge'
import { clearSessionRuntimeState } from '../utils/sessionLifecycle'
import { isEphemeralSession } from '../utils/ephemeralSessions'
import { makeSessionKey, sessionKeyToServerId, sessionKeyToSessionId } from '../utils/sessionKey'
import { subscribeToServerEvents, getSession, getSessionStatus, getPendingPermissions, getPendingQuestions } from '../api'
import { onSeqGap, ackSeqGap } from '../api/events'
import { reportSessionViewed } from '../api/sessionView'
import { recoverPendingInbox } from '../api/inboxRecovery'
import { backfillSessionUsage } from '../api/contextBackfill'
import { invalidateSessionListCache } from '../api/sessionListCache'
import { sessionListIndexStore } from '../store/sessionListIndexStore'
import type { EventCallbacks } from '../types/api/event'
import type { SessionCompactedPayload } from '../types/api/event'
import { replyPermission } from '../api/permission'
import { stripMessageSummaryDiffs, sanitizeStreamPart } from '../api/sanitize'
import { autoApproveStore } from '../store/autoApproveStore'
import type { ApiMessage, ApiPart, ApiPermissionRequest, ApiQuestionRequest, ApiSession } from '../api/types'
import type { SessionStatusMap } from '../types/api/session'

// ============================================
// Session-level pub/sub 消费者注册
// ============================================
//
// 支持多个消费者（每个 pane 一个）按 sessionId 注册回调。
// SSE 事件到达后，按 sessionId 找到匹配的消费者分发。

/** 消费者可以注册的回调类型（与 GlobalEventsCallbacks 的子集对应） */
export interface SessionEventCallbacks {
  onPermissionAsked?: (request: ApiPermissionRequest) => void
  onPermissionReplied?: (data: { sessionID: string; requestID: string }) => void
  onQuestionAsked?: (request: ApiQuestionRequest) => void
  onQuestionReplied?: (data: { sessionID: string; requestID: string }) => void
  onQuestionRejected?: (data: { sessionID: string; requestID: string }) => void
  onScrollRequest?: () => void
  onSessionIdle?: (sessionID: string) => void
  /** 会话压缩结束（v2）：用于刷新消息或提示 */
  onSessionCompacted?: (data: SessionCompactedPayload) => void
  onSessionError?: (sessionID: string) => void
  onReconnected?: (reason: 'network' | 'server-switch', serverId: string) => void
}

interface SessionConsumer {
  sessionId: string | null
  callbacks: SessionEventCallbacks
}

/** 全局消费者注册表 */
const sessionConsumers = new Map<string, SessionConsumer>()

/**
 * 注册一个 session 级事件消费者。
 * @param consumerId 唯一标识（通常用 paneId）
 * @param sessionId 关心的 sessionId（null = 不接收事件）
 * @param callbacks 回调函数集
 * @returns 注销函数
 */
export function registerSessionConsumer(
  consumerId: string,
  sessionId: string | null,
  callbacks: SessionEventCallbacks,
): () => void {
  sessionConsumers.set(consumerId, { sessionId, callbacks })
  return () => {
    sessionConsumers.delete(consumerId)
  }
}

/** 更新已注册消费者的 sessionId（pane 切换 session 时，无需重新注册） */
export function updateConsumerSessionId(consumerId: string, sessionId: string | null) {
  const c = sessionConsumers.get(consumerId)
  if (c) c.sessionId = sessionId
}

/** 按 sessionId 找到所有匹配的消费者回调（包括子 session 冒泡） */
function dispatchToConsumers(sessionId: string, invoke: (cb: SessionEventCallbacks) => void): boolean {
  let dispatched = false
  for (const consumer of sessionConsumers.values()) {
    if (!consumer.sessionId) continue
    // D21：同时认裸 id（isSameSessionKey），与 belongsToCurrentSession 口径一致。
    // 此前只做精确匹配 + 父子关系，跨服务器同后端（local::x 与 remote::x 指向同一实例）
    // 时 belongsToCurrentSession 判为「在看」，这里却无 consumer 命中，权限弹窗被静默丢弃。
    if (
      consumer.sessionId === sessionId ||
      isSameSessionKey(sessionId, consumer.sessionId) ||
      childSessionStore.belongsToSession(sessionId, consumer.sessionId)
    ) {
      invoke(consumer.callbacks)
      dispatched = true
    }
  }
  return dispatched
}

/** 检查是否有任何消费者关心此 sessionId */
function hasConsumerForSession(sessionId: string): boolean {
  for (const consumer of sessionConsumers.values()) {
    if (!consumer.sessionId) continue
    if (consumer.sessionId === sessionId) return true
    if (isSameSessionKey(sessionId, consumer.sessionId)) return true
    if (childSessionStore.belongsToSession(sessionId, consumer.sessionId)) return true
  }
  return false
}

function shouldPlayPermissionSound(sessionId: string): boolean {
  if (autoApproveStore.fullAutoMode === 'global') return false

  for (const [consumerId, consumer] of sessionConsumers.entries()) {
    if (!consumer.sessionId) continue
    if (autoApproveStore.getPaneFullAutoMode(consumerId) !== 'session') continue
    if (consumer.sessionId === sessionId || childSessionStore.belongsToSession(sessionId, consumer.sessionId)) {
      return false
    }
  }

  return true
}

/** 检查是否有“其他”消费者仍在使用该 sessionId（排除当前 pane 自己） */
export function hasOtherConsumerForSession(sessionId: string, consumerId: string): boolean {
  for (const [id, consumer] of sessionConsumers.entries()) {
    if (id === consumerId) continue
    if (!consumer.sessionId) continue
    if (consumer.sessionId === sessionId) return true
    if (childSessionStore.belongsToSession(sessionId, consumer.sessionId)) return true
  }
  return false
}

// ============================================
// 待处理请求缓存 - 处理 permission/question 事件先于 session.created 到达的时序问题
// 同一 session 可能有多个 pending 请求，所以用数组
// ============================================
interface PendingRequest<T> {
  request: T
  timestamp: number
}

const pendingPermissions = new Map<string, PendingRequest<ApiPermissionRequest>[]>()
const pendingQuestions = new Map<string, PendingRequest<ApiQuestionRequest>[]>()

// 5秒后过期，防止内存泄漏
const PENDING_TIMEOUT = 5000

// late pending 请求（权限/问答）的驻留上限与过期时间。
// 断连窗口内 replied 事件可能永久丢失，必须靠 TTL 兜底清理，否则条目会无限累积
const LATE_PENDING_TIMEOUT = 5 * 60 * 1000
const LATE_PENDING_MAX = 200

/**
 * seq 缺口批量处理窗口。
 *
 * 一次断连/背压恢复后，同一台服务器上可能有多个会话同时报缺口；逐个立即重拉
 * 会在隧道上打出并发风暴。300ms 足够吸收一次重连风暴，又不会让用户明显等待。
 */
const SEQ_GAP_FLUSH_MS = 300

interface LatePendingRequest {
  requestId: string
  sessionId: string
  type: 'permission' | 'question'
  description?: string
  scopeKey: string
  directory?: string
  timestamp: number
}

function pruneLatePendingRequests(map: Map<string, LatePendingRequest>) {
  const now = Date.now()
  for (const [key, entry] of map) {
    if (now - (entry.timestamp ?? 0) > LATE_PENDING_TIMEOUT) {
      map.delete(key)
    }
  }
  // Map 保持插入顺序，超容量时从最旧的条目开始淘汰
  while (map.size > LATE_PENDING_MAX) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

function cleanupExpired<T>(map: Map<string, PendingRequest<T>[]>) {
  const now = Date.now()
  for (const [key, arr] of map) {
    const filtered = arr.filter(item => now - item.timestamp <= PENDING_TIMEOUT)
    if (filtered.length === 0) {
      map.delete(key)
    } else if (filtered.length !== arr.length) {
      map.set(key, filtered)
    }
  }
}

function addPending<T>(map: Map<string, PendingRequest<T>[]>, sessionID: string, request: T) {
  const arr = map.get(sessionID) || []
  arr.push({ request, timestamp: Date.now() })
  map.set(sessionID, arr)
}

function drainPending<T>(map: Map<string, PendingRequest<T>[]>, sessionID: string): T[] {
  const arr = map.get(sessionID)
  if (!arr || arr.length === 0) return []
  map.delete(sessionID)
  return arr.map(item => item.request)
}

function getScopeKey(directories?: readonly string[]) {
  if (!directories || directories.length === 0) return '__global__'
  return directories.join('|')
}

/**
 * 从消息 part 里识别「已转入后台」的任务；不是后台任务返回 null。
 *
 * 与 `workStatus/backgroundJobs.ts` 的判定同源：`background=true` 的工具调用
 * 会立刻返回（工具本身 completed），真正的任务 id 在 `metadata.shellID` 或
 * 输出回执里。
 */
/**
 * `shell.created` 见到、但尚未被工具 part 认领的 shell。
 *
 * 用途：启动事件能给出真实开始时刻与归属会话，但**单凭它无法区分前后台**
 * （前台命令也会触发）。所以这里只暂存，等工具 part 带来
 * `background: true` 或后台回执时再认领入表。未认领的候选不显示。
 *
 * 有界：按 id 覆盖写入，并在认领时删除；长期不认领的条目由容量上限兜底。
 */
const pendingShellCandidates = new Map<
  string,
  { sessionId: string; startedAt: number; command?: string }
>()

/** 候选上限：防止极端情况下无限增长（正常只有个位数） */
const PENDING_SHELL_CANDIDATE_LIMIT = 50

function rememberPendingShell(
  id: string,
  value: { sessionId: string; startedAt: number; command?: string },
): void {
  if (pendingShellCandidates.size >= PENDING_SHELL_CANDIDATE_LIMIT) {
    const oldest = pendingShellCandidates.keys().next()
    if (!oldest.done) pendingShellCandidates.delete(oldest.value)
  }
  pendingShellCandidates.set(id, value)
}

/**
 * 工具 part 是否「已转入后台」。
 *
 * ⚠️ 不能只看 `metadata.shellID`：opencode 的 shell 工具会给**所有** shell
 * （包括前台阻塞执行的）都写这个字段。只认它就会把正在跑的前台命令
 * （例如 `sleep 12; ...`）也列成后台任务 —— 实测如此。
 *
 * 真正的判据是**后台回执**：
 *   - 输入显式 `background: true`；或
 *   - 输出正文里有「Command moved to the background (shell ID: ...)」。
 *     前台调用即使中途被用户转后台，也会补发这条回执。
 */
function backgroundJobFromToolPart(part: unknown): { id: string; title: string } | null {
  if (!part || typeof part !== 'object') return null
  const record = part as {
    type?: unknown
    state?: { metadata?: unknown; content?: unknown; input?: unknown }
  }
  if (record.type !== 'tool') return null

  const shellId = extractShellId(record.state)
  if (!shellId) return null

  const input = record.state?.input
  const inputRecord = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  if (!isBackgroundedCall(inputRecord, record.state?.content)) return null

  const rawTitle =
    (typeof inputRecord.description === 'string' && inputRecord.description) ||
    (typeof inputRecord.command === 'string' && inputRecord.command) ||
    shellId
  return { id: shellId, title: rawTitle.length > 80 ? `${rawTitle.slice(0, 80)}…` : rawTitle }
}

/** 后台回执文案（v2 shell 工具固定措辞） */
const BACKGROUND_RECEIPT_RE = /moved to the background/i

function isBackgroundedCall(
  input: Record<string, unknown>,
  content: unknown,
): boolean {
  if (input.background === true) return true
  if (!Array.isArray(content)) return false
  const text = content
    .map(item => (item && typeof item === 'object' ? (item as { text?: unknown }).text : undefined))
    .filter((value): value is string => typeof value === 'string')
    .join('')
  return BACKGROUND_RECEIPT_RE.test(text)
}

function extractShellId(state: { metadata?: unknown; content?: unknown } | undefined): string | null {
  if (!state) return null
  const metadata = state.metadata
  if (metadata && typeof metadata === 'object') {
    const shellID = (metadata as Record<string, unknown>).shellID
    if (typeof shellID === 'string' && shellID) return shellID
  }
  const content = state.content
  if (Array.isArray(content)) {
    const text = content
      .map(item => (item && typeof item === 'object' ? (item as { text?: unknown }).text : undefined))
      .filter((value): value is string => typeof value === 'string')
      .join('')
    const match = text.match(/shell ID:\s*([\w-]+)/)
    if (match?.[1]) return match[1]
  }
  return null
}

function removePendingByRequestId<T extends { id: string }>(
  map: Map<string, PendingRequest<T>[]>,
  sessionID: string,
  requestID: string,
) {
  const arr = map.get(sessionID)
  if (!arr || arr.length === 0) return

  const filtered = arr.filter(item => item.request.id !== requestID)
  if (filtered.length === 0) {
    map.delete(sessionID)
  } else if (filtered.length !== arr.length) {
    map.set(sessionID, filtered)
  }
}

async function fetchActiveScopeData(directories: string[] | undefined, serverId: string) {
  const scopes = directories && directories.length > 0 ? directories : [undefined]

  /**
   * 运行态与权限在 v2 都是**全局**接口：
   *   - GET /api/session/active 不接受 directory；
   *   - permission.request.list 也不接受 directory。
   *
   * 之前按目录循环调用它们，把同一份全局结果请求了 N 次，并且把返回的**每个**
   * 会话都归到「当前这个目录」。同一会话会被依次塞进 N 个目录的 meta，最后一次
   * 写入者获胜 —— 于是「KomiDash 里正在跑的会话」被记成了别的项目的目录，项目行
   * 按目录汇总状态时，那个项目就一直转圈，展开却找不到在跑的会话。
   *
   * 现在只取一次，目录由会话自身的 meta 决定（见下方 resolveDirectory）。
   */
  const [statusMap, permissions, questionResults] = await Promise.all([
    getSessionStatus(undefined, serverId).catch(() => ({}) as SessionStatusMap),
    getPendingPermissions(undefined, undefined, serverId).catch(() => []),
    Promise.all(scopes.map(directory => getPendingQuestions(undefined, directory, serverId).catch(() => []))),
  ])

  const mergedStatusMap: SessionStatusMap = {}
  const permissionMap = new Map<string, ApiPermissionRequest>()
  const questionMap = new Map<string, ApiQuestionRequest>()
  const sessionMetaEntries: Array<{ sessionId: string; directory?: string }> = []

  // 全局接口不返回目录：已知的从 store 的 session meta 取；未知的（应用启动前
  // 就在跑、本次还没收到 session.updated）单独查一次会话详情。只查真正在跑的，
  // 数量很少，且 getSession 自带短 TTL 缓存。
  const unknownDirectoryIds = new Set<string>()
  const knownDirectory = (sessionId: string): string | undefined => {
    const directory = activeSessionStore.getSessionMeta(sessionId)?.directory
    if (directory) return directory
    unknownDirectoryIds.add(sessionId)
    return undefined
  }

  for (const [sid, status] of Object.entries(statusMap)) {
    const scopedId = makeSessionKey(serverId, sid)
    mergedStatusMap[scopedId] = status
    if (status.type === 'idle') continue
    const directory = knownDirectory(scopedId)
    if (directory) sessionMetaEntries.push({ sessionId: scopedId, directory })
  }

  for (const permission of permissions) {
    const scopedId = makeSessionKey(serverId, permission.sessionID)
    permissionMap.set(permission.id, { ...permission, sessionID: scopedId })
    const directory = knownDirectory(scopedId)
    if (directory) sessionMetaEntries.push({ sessionId: scopedId, directory })
  }

  questionResults.forEach((questions, index) => {
    // form.list 接受 location，因此这里的目录是**查询时指定的那个**，可信。
    const directory = scopes[index]
    for (const question of questions) {
      const scopedId = makeSessionKey(serverId, question.sessionID)
      questionMap.set(question.id, { ...question, sessionID: scopedId })
      if (directory) sessionMetaEntries.push({ sessionId: scopedId, directory })
    }
  })

  if (unknownDirectoryIds.size > 0) {
    const resolved = await Promise.all(
      [...unknownDirectoryIds].map(async scopedId => {
        const sid = scopedId.slice(scopedId.indexOf('::') + 2)
        try {
          const session = await getSession(sid, undefined, serverId)
          return { sessionId: scopedId, directory: session.directory || undefined }
        } catch {
          // 会话可能刚被删除；拿不到目录就不写 meta，状态自然不会挂到任何项目行
          return null
        }
      }),
    )
    for (const entry of resolved) {
      if (entry?.directory) sessionMetaEntries.push(entry)
    }
  }

  return {
    statusMap: mergedStatusMap,
    permissions: Array.from(permissionMap.values()),
    questions: Array.from(questionMap.values()),
    sessionMetaEntries,
  }
}

/**
 * 检查 sessionID 是否属于当前活跃的 session family。
 * 依次检查：
 *   1. focused pane 的 session family
 *   2. pub/sub 消费者注册表（其他 pane）
 *
 * 比较时同时认「裸 sessionId」：两台已连接服务器指向同一后端时，同一个会话
 * 会被两条 SSE 以不同前缀推事件（`local::ses_x` 与 `aiagent:...::ses_x`）。
 * 只比复合 key 会把另一个前缀的事件误判为「不在看」，从而推送一条永远点不掉的
 * 未读通知。
 */
function belongsToCurrentSession(sessionId: string): boolean {
  const focusedSessionId = paneLayoutStore.getFocusedSessionId()

  // 检查当前 focused pane 的 session family
  if (focusedSessionId) {
    if (sessionId === focusedSessionId) return true
    if (isSameSessionKey(sessionId, focusedSessionId)) return true
    if (childSessionStore.belongsToSession(sessionId, focusedSessionId)) return true
  }

  // 检查 pub/sub 消费者注册表（多 pane 模式下各 pane 注册的 session）
  if (hasConsumerForSession(sessionId)) return true

  return false
}

/** 两个复合 key 是否指向同一个会话（忽略服务器前缀差异） */
function isSameSessionKey(left: string, right: string): boolean {
  const leftId = sessionKeyToSessionId(left)
  return !!leftId && leftId === sessionKeyToSessionId(right)
}

/**
 * 是否是子 agent 会话。
 *
 * 子会话默认不在侧栏出现，对它的完成/错误事件推通知只会留下点不到也清不掉的
 * 孤儿未读点（项目行常亮）。以 childSessionStore 的注册记录为准。
 */
function isChildSession(sessionId: string): boolean {
  return !!childSessionStore.getSessionInfo(sessionId)
}

/**
 * 检查 session 是否被某个 pane 直接打开。
 *
 * 和 belongsToCurrentSession() 的区别：
 * - belongsToCurrentSession(): 包含当前 session 的子 session family
 * - isSessionDirectlyOpen(): 只认 pane 直接打开的 session 本身
 *
 * 这样父 session 正在查看时，子 session 的事件可以继续在界面内冒泡，
 * 但不会再被当成“当前 session 自己”的提示音来播放。
 */
function isSessionDirectlyOpen(sessionId: string): boolean {
  const focusedSessionId = paneLayoutStore.getFocusedSessionId()
  if (focusedSessionId === sessionId) return true
  if (focusedSessionId && isSameSessionKey(sessionId, focusedSessionId)) return true

  for (const consumer of sessionConsumers.values()) {
    if (consumer.sessionId === sessionId) return true
    if (consumer.sessionId && isSameSessionKey(sessionId, consumer.sessionId)) return true
  }

  return false
}

/**
 * 收集当前活跃服务器：
 * - 所有 pane 打开的 session 所属 server
 * - active server
 * - 多服务器模式：白名单订阅的服务器（即使没有 pane 打开也要保持 SSE 连接，避免列表断连）
 */
/**
 * 需要保持事件连接的服务器集合。
 *
 * 现在无条件连接**所有已配置服务器**：主机列表要把每台的状态点、版本号都显示
 * 成实时值，切换主机也要瞬时生效，这都要求连接先建好。
 *
 * 此前只有「多服务器模式」开启时才连白名单，关闭时只连活动服务器 ——
 * 结果是主机列表里其他服务器全是灰点，看起来像"没生效"。
 * 该模式已取消，同时订阅多服务器会话成为默认行为。
 */
function collectActiveServerIds(): string[] {
  const ids = new Set<string>()
  // 已打开会话所属的服务器（即使它已从配置里被移除，也要保持连接以便收尾）
  for (const leaf of paneLayoutStore.allLeaves()) {
    if (leaf.sessionId) ids.add(sessionKeyToServerId(leaf.sessionId))
  }
  for (const server of serverStore.getEnabledServers()) {
    ids.add(server.id)
  }
  const activeId = serverStore.getActiveServerId()
  if (activeId) ids.add(activeId)
  // 过滤未注册服务器：getServerBaseUrl 对未知 id 会静默回退到 local，不过滤就会
  // 把 local 的数据写到该 id 的键下（数据串服）。服务器注册进 serverStore 时
  // 会 notify，届时重算自然入集。
  return Array.from(ids).filter(id => serverStore.getServer(id) !== null)
}

export function useGlobalEvents(directoriesByServer?: ReadonlyMap<string, readonly string[]>) {
  const directoriesByServerRef = useRef(directoriesByServer)
  const refreshRef = useRef<((strategy?: 'replace' | 'merge', onlyServerId?: string) => void) | null>(null)
  const initializedDirectoriesRef = useRef(false)
  // 已做过全量初始化的 serverId。用于区分「首次连接」（走 replace 建基线）与
  // 「effect 因服务器列表变化重跑」（走 merge，避免清掉别的服务器刚拉到的状态）。
  // 见下方 activeServerIds.forEach 处的说明。
  const initializedServersRef = useRef<Set<string>>(new Set())

  /**
   * 取指定服务器自己的目录列表（无则返回 undefined，表示全局 scope）。
   *
   * 目录属于各自的服务器：把 A 的路径拿去查 B 既无意义（路径在其文件系统上
   * 不存在），又会白白多发请求。因此按 serverId 取，而不是共用一份扁平列表。
   */
  const directoriesFor = useCallback((serverId: string): string[] | undefined => {
    const list = directoriesByServerRef.current?.get(serverId)
    return list && list.length > 0 ? [...list] : undefined
  }, [])

  // 活跃服务器集合：所有 pane 打开的 session 所属 server + active server
  const [activeServerIds, setActiveServerIds] = useState<string[]>(() => collectActiveServerIds())

  // 内容不变时保持引用稳定，避免 useGlobalEvents effect 因新数组引用重跑导致 SSE 全量重连
  const updateActiveServerIds = useCallback(() => {
    setActiveServerIds(prev => {
      const next = collectActiveServerIds()
      if (prev.length === next.length && prev.every((id, index) => id === next[index])) return prev
      return next
    })
  }, [])
  const activeServerIdsRef = useRef(activeServerIds)

  // 已配置过的服务器 id 集合：用于在服务器被删除时清掉其列表索引桶
  const knownServerIdsRef = useRef<Set<string>>(new Set(serverStore.getEnabledServers().map(server => server.id)))

  useEffect(() => {
    activeServerIdsRef.current = activeServerIds
  }, [activeServerIds])

  // pane 布局变化（打开/关闭 session、切换 server）时重算活跃服务器
  useEffect(() => {
    const unsubscribeLayout = paneLayoutStore.subscribe(() => {
      updateActiveServerIds()
      // 会话成为当前焦点即视为已读，清掉它的 completed 未读点。
      //
      // 为什么不能只靠点击列表项来清：completed 通知的推送条件是
      // !belongsToCurrentSession(scopedId)，而它读的 focusedSessionId 更新是
      // 异步的。用户点开会话的瞬间若会话刚好完成，会误判为「不在看」而推送一条
      // 通知；等状态稳定后已无人再触发标记已读，小点就永久残留。
      // 这里在焦点真正落到该会话时补一次，覆盖所有打开路径（点击、键盘、分屏、URL）。
      const focused = paneLayoutStore.getFocusedSessionId()
      if (focused) {
        notificationStore.markSessionNotificationsRead(focused, 'completed')
        // 同步把已读水位推给服务端（v2 session.view），让其它端也看到已读。
        // 焦点变化时手上没有 idle 水位，向服务端要一次（getSession 有短 TTL 缓存，
        // 且这个分支只在切换会话时触发，频率很低）。失败静默，绝不阻塞打开流程。
        void getSession(focused)
          .then(session => reportSessionViewed(focused, session?.time?.idle))
          .catch(() => {})
      }
    })
    // 服务器列表变化（新增/删除/改名）也要重算：现在连接集合 = 所有已配置服务器
    const unsubscribeServers = serverStore.subscribe(() => {
      updateActiveServerIds()
      // 已配置服务器集合缩小（删除）时，清掉被删服务器的列表索引桶，
      // 否则那份数据永远不会再被刷新，只会白占内存。
      const known = new Set(serverStore.getEnabledServers().map(server => server.id))
      for (const id of knownServerIdsRef.current) {
        if (!known.has(id)) sessionListIndexStore.dropServer(id)
      }
      knownServerIdsRef.current = known
    })
    return () => {
      unsubscribeLayout()
      unsubscribeServers()
    }
  }, [updateActiveServerIds])

  useEffect(() => {
    // 节流滚动
    let scrollPending = false
    const pendingScrollSessionIds = new Set<string>()
    const fetchVersions = new Map<string, number>()
    // 整台状态对账用的独立版本号：与 fetchVersions 分开，避免重连时
    // reconcileServerStatus 与 fetchAndInitialize 并发调用互相作废（两者共用同一
    // 计数器时，后者的递增会让前者的 .then 因版本不符被丢弃）。
    const reconcileVersions = new Map<string, number>()
    const activeFetchVersions = new Map<string, number>()
    let disposed = false
    const latePendingRequests = new Map<string, LatePendingRequest>()

    const scheduleScroll = (sessionId: string) => {
      pendingScrollSessionIds.add(sessionId)
      if (scrollPending) return
      scrollPending = true
      requestAnimationFrame(() => {
        scrollPending = false

        // 分发到 pub/sub 消费者
        for (const sid of pendingScrollSessionIds) {
          dispatchToConsumers(sid, cb => cb.onScrollRequest?.())
        }
        pendingScrollSessionIds.clear()
      })
    }

    // ============================================
    // 拉取 session 状态 + pending requests（初始化 & 重连共用，按 server）
    // ============================================

    const fetchAndInitialize = (serverId: string, strategy?: 'replace' | 'merge') => {
      // 默认 merge：现在始终连接多台服务器，各服务器的状态/待处理请求是并集的
      // 一部分，用 replace 会把其他服务器刚拉到的状态清掉。
      // replace 只在「单台服务器的全量刷新」时显式传入。
      const effectiveStrategy = strategy ?? 'merge'
      const currentVersion = (fetchVersions.get(serverId) ?? 0) + 1
      fetchVersions.set(serverId, currentVersion)
      activeFetchVersions.set(serverId, currentVersion)
      const serverDirectories = directoriesFor(serverId)

      const startFetch = () => {
        void fetchActiveScopeData(serverDirectories, serverId)
          .then(({ statusMap, permissions, questions, sessionMetaEntries }) => {
            if (disposed || currentVersion !== fetchVersions.get(serverId)) return
            if (effectiveStrategy === 'merge') {
              activeSessionStore.mergeStatusRefresh(statusMap)
              activeSessionStore.mergePendingRequests(permissions, questions)
            } else {
              // 传 serverId：按服务器作用域替换，多台服务器并发首次连接时不互相清空
              activeSessionStore.initialize(statusMap, serverId)
              activeSessionStore.initializePendingRequests(permissions, questions, serverId)
            }
            const currentDirectories = serverDirectories
            const currentScopeKey = getScopeKey(currentDirectories)
            for (const pending of latePendingRequests.values()) {
              // 只处理属于该 server 的 pending（复合 key 前缀）
              if (!pending.sessionId.startsWith(`${serverId}::`)) continue
              const matchesScope = pending.directory
                ? !currentDirectories ||
                  currentDirectories.length === 0 ||
                  currentDirectories.includes(pending.directory)
                : pending.scopeKey === currentScopeKey
              if (!matchesScope) continue
              activeSessionStore.addPendingRequest(
                pending.requestId,
                pending.sessionId,
                pending.type,
                pending.description,
              )
              // 已消费的条目立即移除，避免下次重连重复处理
              latePendingRequests.delete(pending.requestId)
            }
            pruneLatePendingRequests(latePendingRequests)
            activeSessionStore.setSessionMetaBulk(sessionMetaEntries)
          })
          .catch(() => {
            // best effort: 下次目录切换或 SSE 重连会再拉一次
          })
          .finally(() => {
            if (currentVersion === fetchVersions.get(serverId)) {
              activeFetchVersions.set(serverId, 0)
            }
          })
      }

      // 数据拉取不依赖版本探测：v2 是唯一协议，直接开始拉取。
      startFetch()
    }

    const refreshServerHealth = (serverId: string) => {
      void serverStore.checkHealth(serverId).catch(() => {})
    }

    /**
     * 回前台时对齐某台服务器的 session 状态。
     *
     * 应用在后台被冻结期间 SSE 事件可能未被处理，而连接靠心跳仍显示存活、
     * 不会触发 onReconnected。这里拉取该服务器的全量状态（不带 directory，
     * 服务端返回该实例所有 busy/retry 会话），整台替换其名下条目，清掉残留的
     * 陈旧 busy，同时保留其它服务器状态。失败则静默，下次重连会再对齐。
     */
    const reconcileServerStatus = (serverId: string) => {
      const currentVersion = (reconcileVersions.get(serverId) ?? 0) + 1
      reconcileVersions.set(serverId, currentVersion)
      void getSessionStatus(undefined, serverId)
        .then(statusMap => {
          if (disposed || currentVersion !== reconcileVersions.get(serverId)) return
          const scoped: SessionStatusMap = {}
          for (const [sid, status] of Object.entries(statusMap)) {
            scoped[makeSessionKey(serverId, sid)] = status
          }
          activeSessionStore.replaceServerStatus(serverId, scoped)
          /**
           * 同时校正 messageStore 的「生成中」状态。
           *
           * 这是 messageStore 唯一的**独立于 SSE** 的兜底：收尾事件（idle /
           * execution.succeeded）一旦丢失，界面会永久显示生成中 —— 停止按钮、
           * 项目行转圈、消息半透明都停不下来。而 `/session/active` 是权威快照，
           * 它说「不在跑」就一定不在跑。
           *
           * 判据用 `Date.now()`：服务端此刻没把它列为运行中，即「现在已结束」，
           * 这个时间必然不早于最后一条 assistant（后者是过去产生的）。
           */
          const now = Date.now()
          for (const sessionKey of messageStore.getAllSessionKeys()) {
            if (sessionKeyToServerId(sessionKey) !== serverId) continue
            if (!messageStore.getIsStreaming(sessionKey)) continue
            // 服务端仍认为它在跑 → 不动
            if (scoped[sessionKey]) continue
            messageStore.settleByAuthoritativeIdle(sessionKey, now)
          }
        })
        .catch(() => {})
    }

    const markPermissionReplied = (sessionID: string, requestID: string) => {
      removePendingByRequestId(pendingPermissions, sessionID, requestID)
      latePendingRequests.delete(requestID)
      activeSessionStore.resolvePendingRequest(requestID)

      // Broadcast to ALL consumers regardless of session match.
      // Each consumer clears its local state by requestID (which is globally unique),
      // so a no-op for consumers that don't have this request.
      for (const { callbacks } of sessionConsumers.values()) {
        callbacks.onPermissionReplied?.({ sessionID, requestID })
      }
    }

    refreshRef.current = (strategy?: 'replace' | 'merge', onlyServerId?: string) => {
      const serverIds = onlyServerId ? [onlyServerId] : activeServerIdsRef.current
      for (const serverId of serverIds) {
        fetchAndInitialize(serverId, strategy)
      }
    }

    const approveGlobalPendingPermissions = () => {
      if (!autoApproveStore.approvePendingOnFullAuto || autoApproveStore.fullAutoMode !== 'global') return

      const serverIds = activeServerIdsRef.current

      void Promise.all(
        serverIds.flatMap(serverId => {
          // 每台服务器只查自己的目录；无目录时查全局 scope
          const serverDirectories = directoriesFor(serverId) ?? [undefined]
          return serverDirectories.map(async directory => {
            const permissions = await getPendingPermissions(undefined, directory, serverId).catch(() => [])

            await Promise.all(
              permissions.map(async request => {
                if (!autoApproveStore.claimAutoReply(request.id)) return

                const dir =
                  directory ?? activeSessionStore.getSessionMeta(makeSessionKey(serverId, request.sessionID))?.directory
                try {
                  await replyPermission(request.id, 'once', undefined, dir, request.sessionID, serverId)
                  if (!disposed) markPermissionReplied(makeSessionKey(serverId, request.sessionID), request.id)
                } catch {
                  autoApproveStore.releaseAutoReply(request.id)
                }
              }),
            )
          })
        }),
      )
    }

    const unsubscribeAutoApprove = autoApproveStore.subscribe(approveGlobalPendingPermissions)
    const unsubscribeServerChange = serverStore.onServerChange(serverId => {
      void serverStore.checkHealth(serverId).catch(() => {})
    })

    // ============================================
    // 每个活跃服务器一条 SSE 订阅（事件回调按 server 作用域复合 sessionId）
    // ============================================

    const buildServerCallbacks = (serverId: string): EventCallbacks => {
      const scope = (sid: string) => makeSessionKey(serverId, sid)

      /**
       * 会话完成的统一落定：把 activeSessionStore 置 idle，并在「由忙转闲」时
       * 触发一次完成提示（应用内未读点 / 提示音）。
       *
       * session.idle 与 session.status(idle) 都可能先到，两者都调用本函数；
       * 只有第一个到达者会看到 wasBusy=true 并弹提示，后到者因已是 idle 自动跳过，
       * 从而既保证数量下降、又不会重复提示。
       */
      const settleSessionIdle = (scopedId: string, rawSessionId: string, completedAt?: number) => {
        const prevStatus = activeSessionStore.getSnapshot().statusMap[scopedId]
        const wasBusy = prevStatus && (prevStatus.type === 'busy' || prevStatus.type === 'retry')
        // updateStatus 返回 true 表示会话真正被清除；仍有未回复 pending 时返回
        // false（条目保留），此时会话并未完成，不弹完成提示。
        const cleared = activeSessionStore.updateStatus(scopedId, { type: 'idle' })
        if (!wasBusy || !cleared) return

        if (belongsToCurrentSession(scopedId)) {
          // 正在看的会话：补一次标记已读。
          // 推送条件读的 focusedSessionId 更新是异步的，点开会话瞬间若会话
          // 刚好完成，会被误判为「不在看」而推一条通知，之后没人再触发标记，
          // 小点就永久留在项目行上。这里在状态落定时兜底清一次。
          notificationStore.markSessionNotificationsRead(scopedId, 'completed')
          // 把已读水位推给服务端（v2 session.view），让其它端也看到已读。
          // completedAt 就是这一轮的 idle 时间，正是 session.view 要的水位。
          void reportSessionViewed(scopedId, completedAt)
          if (isSessionDirectlyOpen(scopedId) && soundStore.getSnapshot().currentSessionEnabled) {
            playNotificationSoundDeduped('completed')
          }
        } else if (!isChildSession(scopedId)) {
          // 子 agent 会话：不在侧栏出现（除非用户显式打开子会话开关），
          // 推通知只会产生点不到也清不掉的孤儿未读点。跳过。
          const meta = activeSessionStore.getSessionMeta(scopedId)
          const sessionLabel = meta?.title || rawSessionId.slice(0, 8)
          notificationStore.push(
            'completed',
            sessionLabel,
            i18n.t('chat:notification.sessionCompleted'),
            scopedId,
            meta?.directory,
            completedAt,
          )
        }
      }

      return {
        // ============================================
        // Message Events → messageStore
        // ============================================

        onMessageUpdated: (apiMsg: ApiMessage) => {
          // SSE 的 message.updated 会携带 summary.diffs 全文（整轮 patch），
          // 不去掉就会随每个事件进入 store 并参与不可变拷贝。
          // 与分页拉取共用同一份裁剪，保证两条路径的数据形态一致。
          const info = stripMessageSummaryDiffs(apiMsg)
          messageStore.handleMessageUpdated({ ...info, sessionID: scope(apiMsg.sessionID) })
          // 有真实消息活动 = 这一轮确实在跑：为本地乐观条目续期，避免运行中被回收
          activeSessionStore.touchSession(scope(apiMsg.sessionID))
        },

        onPartUpdated: (apiPart: ApiPart) => {
          if ('sessionID' in apiPart && 'messageID' in apiPart) {
            activeSessionStore.touchSession(scope(apiPart.sessionID))
            const scopedId = scope(apiPart.sessionID)
            messageStore.handlePartUpdated(
              sanitizeStreamPart({
                ...(apiPart as ApiPart & { sessionID: string; messageID: string }),
                sessionID: scopedId,
              }),
            )
            /**
             * 工具一转入后台就立刻标记「运行中」。
             *
             * 只靠 synthetic 完成通知是不够的：那是**结束**信号，任务刚开始跑时
             * 面板上什么都不会出现。这里在工具 part 更新时识别「已转入后台」，
             * 先落成 running，等完成通知到达再纠正为终态。
             *
             * 这是任务进入 store 的**主登记路径** —— 骨架只覆盖已定稿轮次，
             * 正在跑的这一轮不在骨架里，`shell.created` 又可能早于本次
             * part.updated 到达，所以必须在这里登记。
             */
            const job = backgroundJobFromToolPart(apiPart)
            if (job) {
              /**
               * 认领启动事件留下的候选：它能提供**真实开始时刻**（比
               * part.updated 的到达时间准确），也确认了归属会话。
               */
              const candidate = pendingShellCandidates.get(job.id)
              if (candidate) {
                pendingShellCandidates.delete(job.id)
                backgroundJobStore.set(scopedId, {
                  id: job.id,
                  status: 'running',
                  at: candidate.startedAt,
                  title: job.title,
                  authoritative: true,
                })
              } else {
                backgroundJobStore.set(scopedId, {
                  id: job.id,
                  status: 'running',
                  at: Date.now(),
                  title: job.title,
                  authoritative: true,
                })
              }
            }
            scheduleScroll(scopedId)
          }
        },

        onPartDelta: data => {
          const scopedId = scope(data.sessionID)
          activeSessionStore.touchSession(scopedId)
          // store 按 v1 形状索引 part：partID = `${messageID}-text-${ordinal}`
          messageStore.handlePartDelta({
            sessionID: scopedId,
            messageID: data.assistantMessageID,
            partID: `${data.assistantMessageID}-text-${data.ordinal}`,
            field: 'text',
            delta: data.delta ?? '',
          })
          scheduleScroll(scopedId)
        },

        onPartRemoved: data => {
          messageStore.handlePartRemoved({ ...data, sessionID: scope(data.sessionID) })
        },

        // 用户消息入队后被撤销（v2 session.inbox.cancelled）：移除本地占位，
        // 否则会留下一条永远不会被处理的用户消息。
        onMessageRemoved: data => {
          messageStore.removeMessage(scope(data.sessionID), data.messageID)
          scheduleScroll(scope(data.sessionID))
        },

        /**
         * 用户消息入队（v2 session.inbox.enqueued）→ 建立可见的用户消息。
         *
         * 这是 v2 唯一的实时用户消息信号（流里没有 message.updated）。不处理它，
         * 其他端在 agent 开始处理前完全看不到这条消息；连发多条时中间那些会被
         * 彻底跳过 —— 用户说的「多端同时用会吞消息」。
         *
         * 同一端自己发送时，本地已有乐观占位（id 相同，因为客户端传的 messageID
         * 就是 inboxID）。这里按 id 写入会替换掉占位而不是新增一条，所以不会重复。
         */
        onInboxEnqueued: data => {
          const scopedId = scope(data.sessionID)
          activeSessionStore.touchSession(scopedId)
          messageStore.upsertRemoteUserMessage(scopedId, {
            messageId: data.inboxID,
            text: data.text,
            createdAt: data.created,
          })
          scheduleScroll(scopedId)
        },

        // session.next.* 事件流兜底：后端若只发 next 工具事件、不补 message.part.updated，
        // 也把悬空的 running/pending part 落定，避免永久转圈。
        onNextToolSettled: data => {
          messageStore.settleToolByCallID(scope(data.sessionID), data.callID, {
            status: data.status,
            output: data.output,
            error: data.error,
            metadata: data.metadata,
          })
        },

        /**
         * 工具执行中的进度：把 metadata 合到已有 part 上，状态保持 running。
         *
         * 只在 part 当前确实是 running/pending 时才更新 —— progress 是 ephemeral、
         * 可能与 success 乱序到达；无脑覆盖会把已完成的工具改回「运行中」。
         */
        onNextToolProgress: data => {
          messageStore.applyToolProgress(scope(data.sessionID), data.callID, data.metadata)
        },

        // ============================================
        // Session Events → childSessionStore
        // ============================================

        onSessionCreated: session => {
          // 内部临时会话（AI 重命名等）不进入任何用户可见视图：
          // 不进列表索引、不注册子会话、不写 session meta、不弹通知。
          if (isEphemeralSession(session.id)) return
          const scopedId = scope(session.id)
          // 根会话出现会改变列表成员；子会话（parentID）频繁创建且只影响子会话列表，
          // 不做失效以免缓存被子 agent 抖动反复冲掉。
          if (!session.parentID) invalidateSessionListCache(serverId)
          // 列表索引增量：created 的会话若属于已加载的目录桶，就地插入
          sessionListIndexStore.applySessionChanged(serverId, session)
          // 注册子 session 关系
          if (session.parentID) {
            childSessionStore.registerChildSession(session, serverId)
          }

          // 处理因时序问题缓存的权限/提问请求（可能有多个）。
          // D22：不限于子会话——根会话的 permission.asked 先于 session.created 到达、
          // 当时 belongsToCurrentSession 为 false 时也会进缓存，此前只在 parentID 分支
          // 内 drain，根会话的缓存会 5s 后过期、请求不再弹出。
          if (belongsToCurrentSession(scopedId)) {
            for (const req of drainPending(pendingPermissions, scopedId)) {
              dispatchToConsumers(req.sessionID, cb => cb.onPermissionAsked?.(req))
            }
            for (const req of drainPending(pendingQuestions, scopedId)) {
              dispatchToConsumers(req.sessionID, cb => cb.onQuestionAsked?.(req))
            }
          }

          // 更新 session meta 供 active tab 使用
          activeSessionStore.setSessionMeta(scopedId, session.title, session.directory)

          // 清理过期缓存
          cleanupExpired(pendingPermissions)
          cleanupExpired(pendingQuestions)
          pruneLatePendingRequests(latePendingRequests)
        },

        onSessionIdle: data => {
          if (isEphemeralSession(data.sessionID)) return
          const scopedId = scope(data.sessionID)
          messageStore.handleSessionIdle(scopedId)
          childSessionStore.markIdle(scopedId)
          // session.idle 是会话完成的权威信号。activeSessionStore 此前只由
          // session.status 驱动，服务端不保证每次都补推 status——只收到 idle 时
          // 会残留 busy 条目，导致 Working 列表与实况通知数量不下降。
          settleSessionIdle(scopedId, data.sessionID, data.timestamp)
          /**
           * 服务端原因导致的中断要给用户一个说法。
           *
           * v2 的 `session.execution.interrupted` 带 reason：
           *   - `user`       用户主动停止（自己按的，不需要提示）
           *   - `inactivity` 服务端判定空闲/服务重启而中止
           *   - `shutdown`   服务端关闭
           *
           * 实测 `inactivity` / 服务重启会把正在跑的一轮直接打断，界面上只是
           * 悄悄回到 idle —— 用户什么都没做却发现「卡住了、没反应了」，只能靠
           * 反复发「继续」来猜测发生了什么。这里明确告知原因。
           */
          const reason = data.interruptReason
          if (reason && reason !== 'user') {
            notificationStore.toast(
              'completed',
              i18n.t('chat:notification.turnInterrupted'),
              reason === 'inactivity'
                ? i18n.t('chat:notification.turnInterruptedInactivity')
                : i18n.t('chat:notification.turnInterruptedShutdown'),
            )
          }
          // 子 agent 运行结束：自动关闭其分屏 pane
          paneLayoutStore.closeSubtaskSession(scopedId)
          dispatchToConsumers(scopedId, cb => cb.onSessionIdle?.(scopedId))
        },

        onSessionCompacted: data => {
          if (isEphemeralSession(data.sessionID)) return
          const scopedId = scope(data.sessionID)
          // started 只是开始信号：标记一下并等待结果，不提示也不刷新。
          if (data.status === 'started') return

          // 失败：后端明确拒绝（如 "Nothing to compact yet"）。必须提示，
          // 否则用户点 /compact 后界面毫无反应，会误以为功能坏掉。
          // 自动压缩失败不打扰用户（后台行为，下一轮仍会重试）。
          if (data.status === 'failed') {
            if (data.reason === 'auto') return
            notificationStore.toast(
              'error',
              i18n.t('chat:notification.compactionFailed'),
              data.error || i18n.t('chat:notification.compactionFailedHint'),
            )
            return
          }

          // 成功：先把压缩后的上下文规模落进 store，再失效消息缓存。
          //
          // ⚠️ 不能用 data.tokens：v2 实测那是**压缩前**用量（input 342383 /
          // cache.read 577024），压缩后实际约 24k。用它会让圆环在压缩后显得更满 ——
          // 正是「压缩完上下文没更新」的根因。真实构成是摘要 + 保留的近期消息，
          // 由 summaryChars / recentChars 表达。
          //
          // compaction part 这条路径（message.part.updated）不带摘要规模：
          // 此时只推进 compactedAt（分隔条），规模等重拉消息后由 message.list
          // 的 compaction 条目补上。写 0 会把圆环误算成 0。
          const hasSize = data.summaryChars !== undefined || data.recentChars !== undefined
          messageStore.recordCompactionResult(scopedId, {
            ...(hasSize ? { summaryChars: data.summaryChars, recentChars: data.recentChars } : {}),
            at: data.time,
          })
          if (data.reason !== 'auto') {
            notificationStore.toast('completed', i18n.t('chat:notification.compactionDone'))
          }
          messageStore.markServerSessionsStale(sessionKeyToServerId(scopedId))
          dispatchToConsumers(scopedId, cb => cb.onSessionCompacted?.(data))
        },

        onSessionUsageUpdated: data => {
          if (isEphemeralSession(data.sessionID)) return
          // 会话累计用量（tokens/cost）。压缩后旧轮次被裁掉，按可见消息汇总
          // 会变小；这份是服务端口径，直接覆盖累计值。
          messageStore.recordSessionUsage(scope(data.sessionID), data.tokens, data.cost)
        },

        /**
         * 压缩那一次请求的用量（durable）。
         *
         * 只写 `compactionUsage`（压缩后上下文快照），**不写** `usage`：
         * 后者是会话累计消耗，混入单次压缩用量会让侧栏数字重复计入。
         */
        onSessionCompactionUsage: data => {
          if (isEphemeralSession(data.sessionID)) return
          messageStore.recordCompactionResult(scope(data.sessionID), {
            tokens: data.tokens,
            cost: data.cost,
            at: data.at,
          })
        },

        /**
         * 已读水位（服务端权威，跨端）。
         *
         * 语义是 `viewed < idle` 即未读。这里把服务端水位同步到本地
         * `readWatermarkStore`（max 合并，天然收敛），从而：
         *   - A 端读了会话 → 服务端 viewed 前进 → B 端收到事件 → B 端未读点消失；
         *   - 不依赖账号登录（账号通道只是离线兜底）。
         *
         * 用 `idle` 而不是本地时间：两端比较必须同基准，服务端时间戳才是权威。
         */
        onSessionViewed: data => {
          if (isEphemeralSession(data.sessionID)) return
          if (!data.idle || data.idle <= 0) return
          const scopedId = scope(data.sessionID)
          readWatermarkStore.raise(scopedId, data.idle)
          notificationStore.markSessionNotificationsRead(scopedId, 'completed')
        },

        onSessionError: error => {
          if (isEphemeralSession(error.sessionID ?? '')) return
          const isAbort = error.name === 'MessageAbortedError' || error.name === 'AbortError'
          if (!isAbort && import.meta.env.DEV) {
            logger.warn('[GlobalEvents] Session error:', error)
          }
          if (error.sessionID == null || error.sessionID.length < 1) {
            return // Don't handle errors with no sessionID
          }
          const scopedId = scope(error.sessionID)
          messageStore.handleSessionError(scopedId)
          childSessionStore.markError(scopedId)
          // 子 agent 以错误结束时同样自动关闭其分屏 pane（主动中止除外）
          if (!isAbort) {
            paneLayoutStore.closeSubtaskSession(scopedId)
          }
          if (!isAbort) {
            // 从 Working 列表移除
            activeSessionStore.updateStatus(scopedId, { type: 'idle' })
            // 通知（跳过当前 session family；子会话不在列表，推了会变成孤儿未读点）
            if (!belongsToCurrentSession(scopedId)) {
              if (!isChildSession(scopedId)) {
                const meta = activeSessionStore.getSessionMeta(scopedId)
                const sessionLabel = meta?.title || error.sessionID.slice(0, 8)
                notificationStore.push(
                  'error',
                  sessionLabel,
                  i18n.t('chat:notification.sessionError'),
                  scopedId,
                  meta?.directory,
                )
              }
            } else if (isSessionDirectlyOpen(scopedId) && soundStore.getSnapshot().currentSessionEnabled) {
              playNotificationSoundDeduped('error')
            }
          }
          dispatchToConsumers(scopedId, cb => cb.onSessionError?.(scopedId))
        },

        onSessionUpdated: session => {
          if (isEphemeralSession(session.id)) return
          const scopedId = scope(session.id)
          // 列表索引增量：含「归档迁移」——本桶与归档桶之间移动由 store 内部处理，
          // 因此不再需要整片失效缓存（原来注释说的 30s TTL 兜底已被索引取代）。
          sessionListIndexStore.applySessionChanged(serverId, session)
          // 注意：此处不对归档做缓存失效。恢复后的会话 time.archived 恒为 0，
          // 用「字段存在」判断会让每次标题更新都冲掉列表缓存（流式期间高频）。
          // 归档迁移已由上面的索引增量精确处理。
          //
          // 但归档要清通知：归档后会话不再出现在列表，通知留着会让项目行因孤儿
          // 通知一直亮未读点（本端归档入口已清，这里覆盖其他客户端归档）。
          if (session.time?.archived) {
            notificationStore.removeSessionNotifications(scopedId)
            // 归档的会话不应再出现在侧栏状态里：清掉它的活跃条目（含 pending），
            // 否则「归档前正在跑」的会话会永久留在 busy 集合，项目行一直显示运行中。
            activeSessionStore.removeSession(scopedId)
          }
          // 归档态变化（本端或其它客户端）都要让归档视图过期：
          // applySessionChanged 只往「已存在」的归档桶里写，而桶一旦加载过就会
          // 一直用旧快照（30s TTL 内甚至不重拉），归档后必须刷新页面才看得到。
          // 这里只标新鲜度失效，不清条目——重开面板仍能首帧上屏，再静默补齐。
          sessionListIndexStore.invalidateArchivedView(serverId)
          // 更新 session meta 供 active tab 使用
          activeSessionStore.setSessionMeta(scopedId, session.title, session.directory)
          if (session.parentID) {
            childSessionStore.registerChildSession(session, serverId)
          }

          // 同步标题到 messageStore，让 Header 等依赖 messageStore 的组件实时更新
          if (session.title && messageStore.getSessionState(scopedId)) {
            messageStore.updateSessionMetadata(scopedId, { title: session.title })
          }
        },

        // v2：会话重命名事件只带 {sessionID, title}。按 id 打补丁更新侧栏索引、
        // activeSessionStore meta 与 messageStore 标题，避免整条替换（会因缺字段被丢弃）。
        onSessionRenamed: ({ sessionID, title }) => {
          if (isEphemeralSession(sessionID) || !title) return
          const scopedId = scope(sessionID)
          const patch: Partial<ApiSession> = { id: sessionID, title }
          sessionListIndexStore.patchAll(serverId, sessionID, patch)
          activeSessionStore.setSessionMeta(scopedId, title, undefined)
          if (messageStore.getSessionState(scopedId)) {
            messageStore.updateSessionMetadata(scopedId, { title })
          }
        },

        // v2 重试：后端放弃旧 assistant 消息（assistantMessageID）、用新 id 重新生成。
        // 旧消息可能已产生部分文本（限流/超时打断时），不移除会与新消息完整文本
        // 同时渲染 → 同一轮回复里句子重复。这里按 id 移除旧消息；新消息由后续
        // step.started / text.* 事件正常建立。
        //
        // 同时把「正在重试」落成 retry 状态：上游限流时实测有 24 秒完全没有任何
        // 内容事件（只有这条 + step.started），界面若不给提示，用户只会觉得
        // 「卡死了、不流式」。重试成功后的 step.started 会把状态推回 busy。
        onSessionRetryScheduled: ({ sessionID, assistantMessageID, attempt, at, error }) => {
          const scopedId = scope(sessionID)
          if (!messageStore.getSessionState(scopedId)) return
          messageStore.removeMessage(scopedId, assistantMessageID)
          activeSessionStore.updateStatus(scopedId, {
            type: 'retry',
            attempt: attempt ?? 1,
            // SessionStatus.retry.message 是给人看的一句话；没有 error 时给个中性描述
            message: typeof error?.message === 'string' ? error.message : 'retrying',
            ...(at != null ? { next: at } : {}),
          } as never)
          scheduleScroll?.(scopedId)
        },

        /**
         * 系统合成消息：后台任务完成通知。
         *
         * 正文是 `<shell id="sh_x" state="completed" command="...">output</shell>`
         * 或 `<subagent sessionID="ses_x" state="...">`。只更新后台任务状态表，
         * **不写进消息流** —— 否则用户会在对话里看到一段 XML。
         */
        onSessionSynthetic: ({ sessionID, text, description, createdAt }) => {
          const notice = parseBackgroundNotice(text)
          if (!notice) return
          const scopedId = scope(sessionID)
          backgroundJobStore.set(scopedId, {
            id: notice.id,
            status: notice.status,
            at: createdAt ?? Date.now(),
            ...(notice.output ? { output: notice.output } : {}),
            ...(notice.title || description ? { title: notice.title || description } : {}),
            // 完成通知是权威终态：可以纠正历史推导出来的「已完成」
            authoritative: true,
          })
        },

        /**
         * 后台 shell 启动。
         *
         * ⚠️ 不能无条件新建条目：前台工具调用同样会产生 shell 与
         * `shell.created` 事件，那样会把正在执行的前台命令也列成后台任务
         * （实测 `sleep 12; ...` 会占满面板）。
         *
         * 但也不能只认「已登记」：后台任务可能在页面打开前就已启动，
         * 此时 store 里还没有它，只认登记就会漏掉。
         *
         * 折中：**已登记 → 刷新为运行中；未登记 → 先记下候选**，等工具 part
         * 到达（带 `background: true` 或回执）时再由主登记路径确认。
         * 候选不直接进 store，所以前台命令不会因此出现在面板上。
         */
        onShellCreated: ({ id, command, sessionID, startedAt }) => {
          const scoped = sessionID ? scope(sessionID) : ''
          if (!scoped) return
          if (backgroundJobStore.has(scoped, id)) {
            backgroundJobStore.set(scoped, {
              id,
              status: 'running',
              at: startedAt,
              ...(command ? { title: command.slice(0, 80) } : {}),
              authoritative: true,
            })
            return
          }
          // 未登记：只留一份候选，供随后的工具 part 认领
          rememberPendingShell(id, {
            sessionId: scoped,
            startedAt,
            ...(command ? { command } : {}),
          })
        },

        /** 后台 shell 退出：落成终态（超时/被杀也算） */
        onShellExited: ({ id, status, exit, endedAt }) => {
          /**
           * `shell.exited` 只带 shell id、不带 sessionID，因此按 id 反查归属会话。
           * 归属在 `shell.created` 时已登记，这里只投递给登记过它的会话。
           */
          const jobStatus =
            status === 'exited'
              ? exit != null && exit !== 0
                ? 'error'
                : 'completed'
              : status === 'timeout'
                ? 'error'
                : status === 'killed'
                  ? 'cancelled'
                  : 'completed'
          for (const sessionId of backgroundJobStore.sessionIdsFor(id)) {
            backgroundJobStore.set(sessionId, {
              id,
              status: jobStatus,
              at: endedAt,
              ...(exit != null ? { exit } : {}),
              authoritative: true,
            })
          }
        },

        onSessionDeleted: sessionId => {          const scopedId = scope(sessionId)
          // 内部临时会话：不进用户列表，但需清运行时状态；若曾在事件竞态中
          // 进过索引桶，delete 事件也照常从桶中移除并记墓碑。
          if (isEphemeralSession(sessionId)) {
            clearSessionRuntimeState(scopedId)
            childSessionStore.removeSession(scopedId)
            sessionListIndexStore.applyDeleted(serverId, sessionId)
            return
          }
          // 删除改变列表成员，失效缓存避免切回时复活已删除项
          invalidateSessionListCache(serverId)
          // 列表索引增量：该服务器所有桶移除 + 记墓碑（挡住晚归的在途响应）
          sessionListIndexStore.applyDeleted(serverId, sessionId)
          const removedSessionIds = childSessionStore.getSessionAndDescendants(scopedId)
          // 清通知：会话已不在列表，通知留着会让项目行永久亮未读点
          for (const id of removedSessionIds) notificationStore.removeSessionNotifications(id)
          clearSessionRuntimeState(scopedId)
          for (const id of removedSessionIds) paneLayoutStore.clearSession(id)
        },

        onServerConnected: data => {
          serverStore.applyServerConnectedTimestamp(serverId, data.timestamp)
        },

        // ============================================
        // Permission Events → callbacks (通过 ref 调用)
        // ============================================

        onPermissionAsked: request => {
          const scopedId = scope(request.sessionID)

          // Full Auto 全局模式拦截 — 所有会话的权限请求直接放行
          if (autoApproveStore.fullAutoMode === 'global') {
            const dir = activeSessionStore.getSessionMeta(scopedId)?.directory
            if (autoApproveStore.claimAutoReply(request.id)) {
              replyPermission(request.id, 'once', undefined, dir, request.sessionID, serverId)
                .then(() => {
                  if (!disposed) markPermissionReplied(scopedId, request.id)
                })
                .catch(() => {
                  autoApproveStore.releaseAutoReply(request.id)
                })
            }
            return
          }

          const meta = activeSessionStore.getSessionMeta(scopedId)
          const sessionLabel = meta?.title || request.sessionID.slice(0, 8)
          const desc = request.patterns?.length ? `${request.permission}: ${request.patterns[0]}` : request.permission

          // Active 列表：注册 pending request
          activeSessionStore.addPendingRequest(request.id, scopedId, 'permission', desc)
          if (activeFetchVersions.get(serverId) !== 0) {
            latePendingRequests.set(request.id, {
              requestId: request.id,
              sessionId: scopedId,
              type: 'permission',
              description: desc,
              scopeKey: getScopeKey(directoriesFor(serverId)),
              directory: meta?.directory,
              timestamp: Date.now(),
            })
            pruneLatePendingRequests(latePendingRequests)
          }

          // Toast 通知 — 不属于当前 session family 的才弹
          if (!belongsToCurrentSession(scopedId)) {
            notificationStore.push(
              'permission',
              i18n.t('chat:notification.permissionTitle', { session: sessionLabel }),
              desc,
              scopedId,
              meta?.directory,
            )
          } else if (
            shouldPlayPermissionSound(scopedId) &&
            isSessionDirectlyOpen(scopedId) &&
            soundStore.getSnapshot().currentSessionEnabled
          ) {
            // 当前会话：如果开启了当前会话提示音
            playNotificationSoundDeduped('permission')
          }

          if (belongsToCurrentSession(scopedId)) {
            dispatchToConsumers(scopedId, cb => cb.onPermissionAsked?.({ ...request, sessionID: scopedId }))
          } else {
            addPending(pendingPermissions, scopedId, { ...request, sessionID: scopedId })
          }
        },

        onPermissionReplied: data => {
          markPermissionReplied(scope(data.sessionID), data.requestID)
        },

        // ============================================
        // Question Events
        // ============================================

        onQuestionAsked: request => {
          const scopedId = scope(request.sessionID)
          const meta = activeSessionStore.getSessionMeta(scopedId)
          const sessionLabel = meta?.title || request.sessionID.slice(0, 8)
          const desc = request.questions?.[0]?.header || i18n.t('chat:notification.aiWaitingForInput')

          // Active 列表：注册 pending request
          activeSessionStore.addPendingRequest(request.id, scopedId, 'question', desc)
          if (activeFetchVersions.get(serverId) !== 0) {
            latePendingRequests.set(request.id, {
              requestId: request.id,
              sessionId: scopedId,
              type: 'question',
              description: desc,
              scopeKey: getScopeKey(directoriesFor(serverId)),
              directory: meta?.directory,
              timestamp: Date.now(),
            })
            pruneLatePendingRequests(latePendingRequests)
          }

          // Toast 通知
          if (!belongsToCurrentSession(scopedId)) {
            notificationStore.push(
              'question',
              i18n.t('chat:notification.questionTitle', { session: sessionLabel }),
              desc,
              scopedId,
              meta?.directory,
            )
          } else if (isSessionDirectlyOpen(scopedId) && soundStore.getSnapshot().currentSessionEnabled) {
            playNotificationSoundDeduped('question')
          }

          if (belongsToCurrentSession(scopedId)) {
            dispatchToConsumers(scopedId, cb => cb.onQuestionAsked?.({ ...request, sessionID: scopedId }))
          } else {
            addPending(pendingQuestions, scopedId, { ...request, sessionID: scopedId })
          }
        },

        onQuestionReplied: data => {
          const scopedId = scope(data.sessionID)
          removePendingByRequestId(pendingQuestions, scopedId, data.requestID)
          latePendingRequests.delete(data.requestID)
          activeSessionStore.resolvePendingRequest(data.requestID)

          if (belongsToCurrentSession(scopedId)) {
            dispatchToConsumers(scopedId, cb => cb.onQuestionReplied?.({ ...data, sessionID: scopedId }))
          }
        },

        onQuestionRejected: data => {
          const scopedId = scope(data.sessionID)
          removePendingByRequestId(pendingQuestions, scopedId, data.requestID)
          latePendingRequests.delete(data.requestID)
          activeSessionStore.resolvePendingRequest(data.requestID)

          if (belongsToCurrentSession(scopedId)) {
            dispatchToConsumers(scopedId, cb => cb.onQuestionRejected?.({ ...data, sessionID: scopedId }))
          }
        },

        // ============================================
        // Session Status → activeSessionStore
        // ============================================

        onSessionStatus: data => {
          if (isEphemeralSession(data.sessionID)) return
          const scopedId = scope(data.sessionID)

          // idle 与 session.idle 走同一落定逻辑，避免重复提示、保证数量下降
          if (data.status.type === 'idle') {
            settleSessionIdle(scopedId, data.sessionID, data.timestamp)
            childSessionStore.markIdle(scopedId)
            return
          }

          // D11：先让 childSessionStore 落定。若该会话是已注册子会话且被已 error
          // 的终态挡住（markRunning 返回 false），activeSessionStore 也不应置 busy，
          // 否则子代理面板显示已完成、Working 列表却显示在跑。
          if (childSessionStore.markRunning(scopedId)) {
            activeSessionStore.updateStatus(scopedId, data.status)
          }
        },

        /**
         * 背压溢出：本地消费不过来导致整条连接被 SDK 停掉（已由传输层立即重连）。
         *
         * 这里要做的是「补齐溢出期间丢掉的事件」：溢出是跨会话的，无法定位丢了
         * 哪些，因此把该服务器的会话全部标记 stale（下次打开会重拉），并对账
         * 运行态。不给用户弹 toast —— 这不是故障，重连通常在一秒内完成，
         * 弹提示反而制造焦虑。
         */
        onBackpressure: detail => {
          logger.warn(`[GlobalEvents] backpressure overflow on ${serverId}, marking sessions stale: ${detail}`)
          messageStore.markServerSessionsStale(serverId)
          reconcileServerStatus(serverId)
          fetchAndInitialize(serverId)
          void recoverPendingInbox(serverId)
        },

        // ============================================
        // Reconnected → 通知调用方刷新数据 + 重新拉取 session status
        // ============================================

        onReconnected: reason => {
          if (import.meta.env.DEV) {
            logger.log(`[GlobalEvents] SSE reconnected (${serverId}, reason: ${reason}), notifying for data refresh`)
          }
          // 网络抖动恢复后给用户一个明确的「已重连」提示：断网期间无任何界面
          // 反馈，恢复也只能靠藏在 Footer 菜单里的状态点，用户感知不到。
          // server-switch 是用户主动切换，不需要提示。
          if (reason !== 'server-switch') {
            const serverName = serverStore.getServer(serverId)?.name || serverId
            notificationStore.toast('completed', i18n.t('common:reconnected', { serverName }), undefined)
          }
          refreshServerHealth(serverId)
          // 重连后重新拉取全量状态 + pending requests。
          // 先做一次「整台替换」对账：断连期间可能漏掉 idle/归档事件，而 merge 只增
          // 不删清不掉陈旧 busy（表现为侧栏项目行/会话行一直显示运行中）。整台替换
          // 以服务端权威状态为准，顺带清掉这些残留；随后 fetchAndInitialize 补齐
          // pending 与 session meta。
          reconcileServerStatus(serverId)
          fetchAndInitialize(serverId)
          // 断连期间可能漏掉 `session.inbox.enqueued`（用户消息唯一的实时信号）。
          // 漏掉就意味着「另一台设备发的消息在这台设备上永远不出现」，直到那一轮
          // 跑完、消息落进 message.list 为止。用 session.inbox.list 把还没投递的
          // 入队消息补回来，比等下一轮结束要早得多。
          void recoverPendingInbox(serverId)
          // 只通知「关心的 session 属于该重连服务器」的消费者。
          // 重连是按 serverId 独立的：某台服务器网络抖动不应让其它服务器的
          // 会话缓存失效、被迫重拉。消费者 sessionId 是复合 key，用它反解 serverId 比对。
          for (const consumer of sessionConsumers.values()) {
            if (consumer.sessionId && sessionKeyToServerId(consumer.sessionId) !== serverId) continue
            consumer.callbacks.onReconnected?.(reason, serverId)
          }
        },
      }
    }

    const unsubscribes = activeServerIds.map(serverId =>
      subscribeToServerEvents(serverId, buildServerCallbacks(serverId)),
    )

    /**
     * seq 缺口修复。
     *
     * 传输层只负责「发现丢了」（见 api/seqGap.ts），这里负责「怎么修」：
     * 把该会话标记为 stale 并通知 pane 重拉快照，然后 ack 掉缺口。
     *
     * 为什么只能重拉快照：实测 `GET /session/{id}/log?after=N` 不回放历史事件
     * （`after=0` 也只返回当前水位），服务端没有游标续传能力。
     *
     * 为什么 ack 必须在这里做：ack 之后该会话的 seq 记录被清空，下一条事件按
     * 「首次见到」放行。若忘记 ack，会一直卡在缺口判定上反复重拉。
     */
    /**
     * seq 缺口修复（带节流与合并）。
     *
     * 为什么需要节流：一次断连/背压恢复后，同一台服务器上**多个会话**可能同时
     * 报缺口。每个都立即触发一次 force 重载，就会在隧道上打出一波并发请求
     * （实测经网关单次往返约 1.1s，几个大会话足以把后续请求全拖慢）。
     *
     * 策略：
     *   - 按 serverId 合并：一个窗口内的所有缺口只触发一次「批量处理」；
     *   - 窗口 300ms：足够吸收一次重连风暴，又不会让用户明显等待；
     *   - 同一会话在窗口内只处理一次（Set 去重）。
     */
    const pendingGaps = new Map<string, Set<string>>()
    let gapFlushTimer: ReturnType<typeof setTimeout> | null = null

    const flushGaps = () => {
      gapFlushTimer = null
      const batches = [...pendingGaps.entries()]
      pendingGaps.clear()
      for (const [serverId, aggregateIDs] of batches) {
        for (const aggregateID of aggregateIDs) {
          const scopedId = makeSessionKey(serverId, aggregateID)
          messageStore.markSessionStale(scopedId)
          // 通知打开着该会话的 pane：它的 onReconnected 会做 force 重载。
          // 复用同一回调是刻意的 —— 对 pane 而言「数据不可信需要重拉」和
          // 「断线重连」是同一件事，没必要再造一套。
          for (const consumer of sessionConsumers.values()) {
            if (consumer.sessionId !== scopedId) continue
            consumer.callbacks.onReconnected?.('network', serverId)
          }
          ackSeqGap(serverId, aggregateID)
        }
      }
    }

    const unsubscribeSeqGap = onSeqGap((serverId, aggregateID) => {
      let set = pendingGaps.get(serverId)
      if (!set) {
        set = new Set()
        pendingGaps.set(serverId, set)
      }
      set.add(aggregateID)
      if (gapFlushTimer !== null) return
      gapFlushTimer = setTimeout(flushGaps, SEQ_GAP_FLUSH_MS)
    })

    activeServerIds.forEach(serverId => {
      // 只有该服务器「首次连接」才用 replace：这是全量初始化，需要
      // initializePendingRequests 建立待处理请求的基线。
      //
      // 不能用「本 effect 第一次运行」当条件：effect 依赖 activeServerIds，
      // 而 collectActiveServerIds 现在无条件包含所有已配置服务器，所以任何
      // 服务器增删改名都会让 effect 整体重跑。若那时仍传 replace，会对所有
      // 已连服务器重跑 initialize/initializePendingRequests，把它们刚拉到的
      // 待处理请求清掉。因此按 serverId 记录是否已初始化过。
      const firstConnect = !initializedServersRef.current.has(serverId)
      if (firstConnect) initializedServersRef.current.add(serverId)
      fetchAndInitialize(serverId, firstConnect ? 'replace' : 'merge')
      refreshServerHealth(serverId)
    })
    approveGlobalPendingPermissions()

    // 健康轮询：SSE 长连接在进程死后可能长时间挂着（心跳超时才判死），
    // 而 health 探测是真的 HTTP 请求（5s 超时即判离线）。定期刷新 health，
    // 让主机列表的状态点及时反映真实可达性，而不是跟着 SSE 连接态停留绿色。
    const healthPollTimer = window.setInterval(() => {
      for (const serverId of activeServerIdsRef.current) {
        // silent：已有结果时不要先翻成 checking，否则状态点会周期性闪烁
        void serverStore.checkHealth(serverId, { silent: true }).catch(() => {})
      }
    }, 15000)

    // 回收长时间没有任何事件佐证的本地乐观 busy：
    // 点击发送后这一轮若根本没跑起来（请求失败、命令只改本地状态），
    // 没有服务端 status 来收尾，条目会永远留着让项目行显示「运行中」。
    const optimisticBusySweepTimer = window.setInterval(() => {
      activeSessionStore.expireStaleOptimisticEntries()
    }, 30000)

    /**
     * 周期性以服务端为准对齐运行态。
     *
     * 只在「重连」和「切回前台」对齐不够：桌面端可以整天开着、SSE 心跳也一直
     * 正常，但某个 execution.succeeded / interrupted 事件丢失（隧道抖动、
     * 服务端重启、浏览器丢事件）后，没有第二次机会把它清掉。这条 busy 会永久
     * 留着 —— 表现为折叠的项目行一直转圈，而那个会话其实早就结束了。
     *
     * 频率取 60s：/api/session/active 只返回正在跑的会话，开销很小；且该接口
     * 走 microCache，与其它路径的调用会合并。页面隐藏时不拉，省流量。
     */
    const activeStatusReconcileTimer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      for (const serverId of activeServerIdsRef.current) {
        reconcileServerStatus(serverId)
      }
      reconcileUsage()
    }, 60000)

    /**
     * 周期性对齐会话用量。
     *
     * 为什么单独需要它：`session.usage.updated` 是 ephemeral 事件，丢了就没有
     * 第二次机会；而上面的 activeStatusReconcileTimer 只对账运行态
     * （`/session/active`），完全没碰 `usage` / `contextUsage`。
     * 结果是「连接看起来活着、但事件丢了」时，token 与花费数字永久停在旧值。
     *
     * 只对账**已加载进内存**的会话（messageStore 里有 state 的），且复用
     * contextBackfill 的轻量路径（`session` 接口 504 字节），不做全量重拉。
     * 用 force 绕过去重：周期对账的目的就是纠错，被「已补过」挡掉就失去意义。
     */
    const reconcileUsage = () => {
      for (const sessionKey of messageStore.getAllSessionKeys()) {
        void backfillSessionUsage(sessionKey, { force: true })
      }
    }

    // 回前台时重新对齐 session 状态：应用在后台被冻结期间 SSE 事件可能未被处理，
    // 而连接靠心跳仍显示存活、不会触发 onReconnected。此时主动拉一次全量状态，
    // 清掉残留的 busy 条目，让 Working 列表与实况通知数量回到真实值。
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      for (const serverId of activeServerIdsRef.current) {
        reconcileServerStatus(serverId)
      }
      reconcileUsage()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      disposed = true
      refreshRef.current = null
      window.clearInterval(healthPollTimer)
      window.clearInterval(optimisticBusySweepTimer)
      window.clearInterval(activeStatusReconcileTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribes.forEach(unsubscribe => unsubscribe())
      unsubscribeSeqGap()
      // 挂起的缺口批量任务必须清掉：effect 已销毁，再回调会打到已卸载的 consumer
      if (gapFlushTimer !== null) {
        clearTimeout(gapFlushTimer)
        gapFlushTimer = null
      }
      pendingGaps.clear()
      unsubscribeAutoApprove()
      unsubscribeServerChange()
    }
  }, [activeServerIds, directoriesFor])

  // 目录变化时只刷新「自己的目录集合真的变了」的服务器：把 A 的目录变化套用到
  // 所有服务器会连累其它服务器做无谓重拉（且用错的路径）。
  const lastScopeKeysRef = useRef<Map<string, string> | null>(null)
  useLayoutEffect(() => {
    directoriesByServerRef.current = directoriesByServer
    const nextKeys = new Map<string, string>()
    for (const [serverId, list] of directoriesByServer ?? []) {
      nextKeys.set(serverId, getScopeKey(list))
    }
    const prevKeys = lastScopeKeysRef.current
    lastScopeKeysRef.current = nextKeys
    if (!initializedDirectoriesRef.current) {
      initializedDirectoriesRef.current = true
      return
    }
    if (!prevKeys) {
      refreshRef.current?.('merge')
      return
    }
    // 新增/变化的服务器
    for (const [serverId, key] of nextKeys) {
      if (prevKeys.get(serverId) !== key) refreshRef.current?.('merge', serverId)
    }
    // 目录被移除的服务器：scope 回落到全局，同样需要重拉
    for (const serverId of prevKeys.keys()) {
      if (!nextKeys.has(serverId)) refreshRef.current?.('merge', serverId)
    }
  }, [directoriesByServer])
}
