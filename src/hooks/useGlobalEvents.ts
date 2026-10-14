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
import i18n from '../i18n'
import { messageStore, childSessionStore, paneLayoutStore, serverStore } from '../store'
import { activeSessionStore } from '../store/activeSessionStore'
import { notificationStore } from '../store/notificationStore'
import { soundStore } from '../store/soundStore'
import { playNotificationSoundDeduped } from '../utils/notificationSoundBridge'
import { clearSessionRuntimeState } from '../utils/sessionLifecycle'
import { isEphemeralSession } from '../utils/ephemeralSessions'
import { makeSessionKey, sessionKeyToServerId, sessionKeyToSessionId } from '../utils/sessionKey'
import { subscribeToServerEvents, getSessionStatus, getPendingPermissions, getPendingQuestions } from '../api'
import { invalidateSessionListCache } from '../api/sessionListCache'
import { sessionListIndexStore } from '../store/sessionListIndexStore'
import type { EventCallbacks } from '../types/api/event'
import { replyPermission } from '../api/permission'
import { stripMessageSummaryDiffs, sanitizeStreamPart } from '../api/sanitize'
import { autoApproveStore } from '../store/autoApproveStore'
import type { ApiMessage, ApiPart, ApiPermissionRequest, ApiQuestionRequest } from '../api/types'
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
  const results = await Promise.all(
    scopes.map(async directory => {
      const [statusMap, permissions, questions] = await Promise.all([
        getSessionStatus(directory, serverId).catch(() => ({}) as SessionStatusMap),
        getPendingPermissions(undefined, directory, serverId).catch(() => []),
        getPendingQuestions(undefined, directory, serverId).catch(() => []),
      ])

      return { directory, statusMap, permissions, questions }
    }),
  )

  const mergedStatusMap: SessionStatusMap = {}
  const permissionMap = new Map<string, ApiPermissionRequest>()
  const questionMap = new Map<string, ApiQuestionRequest>()
  const sessionMetaEntries: Array<{ sessionId: string; directory?: string }> = []

  results.forEach(({ directory, statusMap, permissions, questions }) => {
    // statusMap 的 key 复合化（事件/store 内部统一用 serverId::sessionId）
    for (const [sid, status] of Object.entries(statusMap)) {
      mergedStatusMap[makeSessionKey(serverId, sid)] = status
    }

    if (directory) {
      Object.keys(statusMap).forEach(sid => {
        sessionMetaEntries.push({ sessionId: makeSessionKey(serverId, sid), directory })
      })
    }

    permissions.forEach(permission => {
      if (directory) {
        sessionMetaEntries.push({ sessionId: makeSessionKey(serverId, permission.sessionID), directory })
      }
      permissionMap.set(permission.id, { ...permission, sessionID: makeSessionKey(serverId, permission.sessionID) })
    })

    questions.forEach(question => {
      if (directory) {
        sessionMetaEntries.push({ sessionId: makeSessionKey(serverId, question.sessionID), directory })
      }
      questionMap.set(question.id, { ...question, sessionID: makeSessionKey(serverId, question.sessionID) })
    })
  })

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
  const knownServerIdsRef = useRef<Set<string>>(
    new Set(serverStore.getEnabledServers().map(server => server.id)),
  )

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
      if (focused) notificationStore.markSessionNotificationsRead(focused, 'completed')
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
                ? !currentDirectories || currentDirectories.length === 0 || currentDirectories.includes(pending.directory)
                : pending.scopeKey === currentScopeKey
              if (!matchesScope) continue
              activeSessionStore.addPendingRequest(pending.requestId, pending.sessionId, pending.type, pending.description)
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

      // 版本未知（首次同步的 v2 实例、或旧版本没留下 apiVersion 记录）：先探测
      // 再拉数据。否则 getSDKClient 按 v1 建 client，首屏 /session、/agent、/path
      // 打在 v2 服务器的 SPA 兜底上（text/html），列表直接加载失败。
      // ensureApiVersion 与 SSE/健康轮询共享健康检查在途合并，不多花一次网络；
      // 探测失败不阻塞，照常走原回退路径。
      if (serverStore.getApiVersion(serverId)) {
        startFetch()
      } else {
        void serverStore.ensureApiVersion(serverId).then(() => {
          if (!disposed) startFetch()
        })
      }
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
      const settleSessionIdle = (scopedId: string, rawSessionId: string) => {
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
          if (isSessionDirectlyOpen(scopedId) && soundStore.getSnapshot().currentSessionEnabled) {
            playNotificationSoundDeduped('completed')
          }
        } else if (!isChildSession(scopedId)) {
          // 子 agent 会话：不在侧栏出现（除非用户显式打开子会话开关），
          // 推通知只会产生点不到也清不掉的孤儿未读点。跳过。
          const meta = activeSessionStore.getSessionMeta(scopedId)
          const sessionLabel = meta?.title || rawSessionId.slice(0, 8)
          notificationStore.push('completed', sessionLabel, i18n.t('chat:notification.sessionCompleted'), scopedId, meta?.directory)
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
        },

        onPartUpdated: (apiPart: ApiPart) => {
          if ('sessionID' in apiPart && 'messageID' in apiPart) {
            const scopedId = scope(apiPart.sessionID)
            messageStore.handlePartUpdated(
              sanitizeStreamPart({
                ...(apiPart as ApiPart & { sessionID: string; messageID: string }),
                sessionID: scopedId,
              }),
            )
            scheduleScroll(scopedId)
          }
        },

        onPartDelta: data => {
          const scopedId = scope(data.sessionID)
          messageStore.handlePartDelta({ ...data, sessionID: scopedId })
          scheduleScroll(scopedId)
        },

        onPartRemoved: data => {
          messageStore.handlePartRemoved({ ...data, sessionID: scope(data.sessionID) })
        },

        // session.next.* 事件流兜底：后端若只发 next 工具事件、不补 message.part.updated，
        // 也把悬空的 running/pending part 落定，避免永久转圈。
        onNextToolSettled: data => {
          messageStore.settleToolByCallID(scope(data.sessionID), data.callID, {
            status: data.status,
            output: data.output,
            error: data.error,
          })
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
          settleSessionIdle(scopedId, data.sessionID)
          // 子 agent 运行结束：自动关闭其分屏 pane
          paneLayoutStore.closeSubtaskSession(scopedId)
          dispatchToConsumers(scopedId, cb => cb.onSessionIdle?.(scopedId))
        },

        onSessionError: error => {
          if (isEphemeralSession(error.sessionID ?? '')) return
          const isAbort = error.name === 'MessageAbortedError' || error.name === 'AbortError'
          if (!isAbort && import.meta.env.DEV) {
            console.warn('[GlobalEvents] Session error:', error)
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
                notificationStore.push('error', sessionLabel, i18n.t('chat:notification.sessionError'), scopedId, meta?.directory)
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

        onSessionDeleted: sessionId => {
          const scopedId = scope(sessionId)
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
            notificationStore.push('permission', i18n.t('chat:notification.permissionTitle', { session: sessionLabel }), desc, scopedId, meta?.directory)
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
            notificationStore.push('question', i18n.t('chat:notification.questionTitle', { session: sessionLabel }), desc, scopedId, meta?.directory)
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
            settleSessionIdle(scopedId, data.sessionID)
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

        // ============================================
        // Reconnected → 通知调用方刷新数据 + 重新拉取 session status
        // ============================================

        onReconnected: reason => {
          if (import.meta.env.DEV) {
            console.log(`[GlobalEvents] SSE reconnected (${serverId}, reason: ${reason}), notifying for data refresh`)
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

    // 回前台时重新对齐 session 状态：应用在后台被冻结期间 SSE 事件可能未被处理，
    // 而连接靠心跳仍显示存活、不会触发 onReconnected。此时主动拉一次全量状态，
    // 清掉残留的 busy 条目，让 Working 列表与实况通知数量回到真实值。
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      for (const serverId of activeServerIdsRef.current) {
        reconcileServerStatus(serverId)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      disposed = true
      refreshRef.current = null
      window.clearInterval(healthPollTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribes.forEach(unsubscribe => unsubscribe())
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
