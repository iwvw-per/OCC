// ============================================
// Server-scoped Event Subscription (SSE) - Connection Manager
//
// 每个服务器一条独立 SSE 连接，各自维护心跳 / 重连 / 连接状态 / 事件代次。
// 缺省 serverId 的 API 均作用于"活动服务器"，保持向后兼容：
//   subscribeToEvents(cb)           == subscribeToServerEvents(activeServerId, cb)
//   reconnectSSE()                  == reconnectServerSSE(activeServerId)
//   getConnectionInfo()             == getServerConnectionInfo(activeServerId)
// ============================================

import { normalizeTodoItems } from './todo'
import { getV2Client } from './sdkV2'
import { v2EventToGlobalEvent } from './v2/events'
import { toolResultMetadata } from './v2/adapt'
import { SeqGapTracker, durableOf } from './seqGap'
import { isTauri } from '../utils/tauri'
import { logger } from '../utils/logger'
import { serverStore } from '../store/serverStore'
import type {
  ApiMessage,
  EventCallbacks,
  GlobalEvent,
  NextToolSettledPayload,
  NextToolProgressPayload,
  ServerConnectedPayload,
  SessionErrorPayload,
  SessionCompactedPayload,
  TodoUpdatedPayload,
} from './types'
import type {
  PartDeltaPayload,
  PartRemovedPayload,
  SessionUsagePayload,
  SessionViewedPayload,
  InboxEnqueuedPayload,
} from '../types/api/event'
import { EventTypes } from '../types/api/event'

// ============================================
// Connection State
// ============================================

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface ConnectionInfo {
  state: ConnectionState
  lastEventTime: number
  reconnectAttempt: number
  error?: string
}

interface ServerConnection {
  serverId: string
  info: ConnectionInfo
  subscribers: Set<EventCallbacks>
  controller: AbortController | null
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  isConnecting: boolean
  /** 连接代次，每次 reconnect 递增，旧代次的事件会被丢弃 */
  generation: number
  /** 上一次 onReconnected 广播的时间戳（cooldown） */
  lastReconnectedBroadcast: number
  /**
   * 最近一次**任何传输层活动**的时间戳（含不带 data 的注释心跳帧）。
   *
   * 与 `info.lastEventTime` 的区别：后者只在真正收到事件时更新，是「有没有新
   * 数据」；这里是「连接是否还活着」。两者必须分开，否则空闲会话会被误判为断连
   * （见 touchConnection 的说明）。
   *
   * 刻意放在 ConnectionInfo 之外：它每秒可能变多次，若进入 info 就会触发
   * 订阅者重渲染，而它只服务于内部的存活判定。
   */
  lastActivityAt: number
}

/** serverId -> connection */
const connections = new Map<string, ServerConnection>()
/** serverId -> connection 状态监听者 */
const connectionListeners = new Map<string, Set<(info: ConnectionInfo) => void>>()

/** 是否因为切换服务器而触发的重连（按 serverId） */
const serverSwitchFlags = new Map<string, boolean>()

let lifecycleListenersRegistered = false
/** 当前是否在后台 */
let isInBackground = false
let keepaliveTimer: ReturnType<typeof setInterval> | null = null

// ============================================
// Connection helpers
// ============================================

function bridgeIdFor(serverId: string): string {
  return `sse:${serverId}`
}

function getOrCreateConnection(serverId: string): ServerConnection {
  let conn = connections.get(serverId)
  if (!conn) {
    conn = {
      serverId,
      info: { state: 'disconnected', lastEventTime: 0, reconnectAttempt: 0 },
      subscribers: new Set(),
      controller: null,
      heartbeatTimer: null,
      reconnectTimer: null,
      isConnecting: false,
      generation: 0,
      lastReconnectedBroadcast: 0,
      lastActivityAt: 0,
    }
    connections.set(serverId, conn)
  }
  return conn
}

function updateConnectionState(serverId: string, update: Partial<ConnectionInfo>) {
  // 不隐式创建连接：无连接时直接返回（避免断开后残留空壳连接）
  const conn = connections.get(serverId)
  if (!conn) return
  conn.info = { ...conn.info, ...update }
  connectionListeners.get(serverId)?.forEach(fn => {
    fn(conn.info)
  })
}

// ============================================
// 常量
// ============================================

const RECONNECT_DELAYS = [1000, 2000, 3000, 5000, 10000, 30000]
/** 后台时使用更激进的重连延迟，确保尽快恢复连接 */
const BACKGROUND_RECONNECT_DELAYS = [500, 1000, 2000, 3000, 5000, 10000]
const HEARTBEAT_TIMEOUT = 60000
/** 后台时的心跳超时（更宽松，因为后台 timer 可能不准） */
const BACKGROUND_HEARTBEAT_TIMEOUT = 120000
/** 后台 keepalive 间隔：定期检查连接是否还活着 */
const BACKGROUND_KEEPALIVE_INTERVAL = 30000
/** onReconnected 广播 cooldown */
const RECONNECTED_COOLDOWN = 2000

/** 稳定引用：未连接的服务器默认状态（避免 getSnapshot 每次新建对象导致无限循环） */
const DEFAULT_CONNECTION_INFO: ConnectionInfo = {
  state: 'disconnected',
  lastEventTime: 0,
  reconnectAttempt: 0,
}

// ============================================
// Delta coalescing / parsing 已抽到 ./sseEvents（主线程与 Worker 共用）
// ============================================

function finalizeConnectionAttempt(conn: ServerConnection, generation: number): boolean {
  if (generation !== conn.generation) {
    return false
  }
  conn.isConnecting = false
  return true
}

/**
 * 广播 onReconnected，带 cooldown 防止 SSE 快速重连时密集触发数据拉取
 */
function broadcastReconnected(conn: ServerConnection, reason: 'network' | 'server-switch') {
  const now = Date.now()
  if (reason !== 'server-switch' && now - conn.lastReconnectedBroadcast < RECONNECTED_COOLDOWN) {
    if (import.meta.env.DEV) {
      logger.log('[SSE] onReconnected skipped (cooldown)')
    }
    return
  }
  conn.lastReconnectedBroadcast = now
  conn.subscribers.forEach(cb => {
    cb.onReconnected?.(reason)
  })
}

// ============================================
// Tauri SSE Bridge (via Rust reqwest + Channel)
// 每个服务器一个独立 bridgeId（Rust 侧 BridgeKey=(window, bridgeId) 天然支持多连接）
// ============================================

/** 上一次 bridge_disconnect 的 Promise，用于串行化 Tauri 侧 disconnect → connect */
const pendingDisconnects = new Map<string, Promise<void>>()

function disconnectTauri(bridgeId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve()

  const p = (pendingDisconnects.get(bridgeId) ?? Promise.resolve()).then(() =>
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('bridge_disconnect', { args: { bridgeId } }).then(() => undefined))
      .catch(() => {}),
  )
  pendingDisconnects.set(bridgeId, p)
  return p
}

/** 断开并清理连接的传输层（Tauri bridge / browser fetch），不更新状态 */
function teardownConnectionTransport(conn: ServerConnection): void {
  void disconnectTauri(bridgeIdFor(conn.serverId))
  if (conn.controller) {
    conn.controller.abort()
    conn.controller = null
  }
  conn.isConnecting = false
}

/**
 * 记录一次传输层活动（含注释心跳帧），并顺延心跳超时。
 *
 * 为什么必须单独有这个入口：服务端空闲期只发 `: heartbeat` 注释帧（实测约
 * 15s 一次），而 SDK 的 SSE 解析器**只在 data 非空时才 yield** —— 注释帧
 * 不会进入 for-await 循环。旧实现只在收到真实事件时 resetHeartbeat，于是
 * 一个长时间没新消息的会话（等用户输入、长任务无输出）会在 60s 后误判为
 * 断连并重连，白白打断连接、触发一轮全量对账。
 *
 * SDK 提供了 `onActivity`：每读到一个网络 chunk 就回调一次，注释帧也算。
 * 用它把「连接还活着」与「有没有新事件」解耦。
 */
function touchConnection(conn: ServerConnection) {
  conn.lastActivityAt = Date.now()
  resetHeartbeat(conn)
}

/**
 * 顺延心跳超时。
 *
 * @param activityOnly 仅由传输层活动触发（含注释心跳）。此时不更新
 *   `info.lastEventTime` —— 那个字段的语义是「最后一次收到真实事件」，
 *   被注释帧刷新会让「多久没数据」失真（例如后台 keepalive 的日志与判定）。
 */
function resetHeartbeat(conn: ServerConnection, activityOnly = false) {
  if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer)

  if (!activityOnly) updateConnectionState(conn.serverId, { lastEventTime: Date.now() })

  // 后台时使用更宽松的超时，因为移动端后台 timer 可能被冻结/延迟
  const timeout = isInBackground ? BACKGROUND_HEARTBEAT_TIMEOUT : HEARTBEAT_TIMEOUT

  conn.heartbeatTimer = setTimeout(() => {
    logger.warn(`[SSE] No events received for ${timeout / 1000}s, reconnecting...`)
    updateConnectionState(conn.serverId, { state: 'disconnected', error: 'Heartbeat timeout' })
    scheduleReconnect(conn)
  }, timeout)
}

/**
 * 是否是 SDK 的背压溢出错误（subscriber 队列满）。
 *
 * SDK 抛的是 `Event subscriber exceeded its 4096-event capacity`。
 * 用消息匹配而非错误类：SDK 内部抛的是普通 `Error`，没有可识别的类型标识。
 */
function isBackpressureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /exceeded its \d+-event capacity/i.test(message)
}

/**
 * 连接看起来还活着吗？
 *
 * 判据取「最后一次传输层活动」与「最后一次真实事件」中较晚的那个：
 * 空闲会话只有注释心跳帧，`lastEventTime` 会一直很旧，但连接其实是好的。
 */
function isConnectionFresh(conn: ServerConnection, now = Date.now()): boolean {
  const staleTimeout = isInBackground ? BACKGROUND_HEARTBEAT_TIMEOUT : HEARTBEAT_TIMEOUT
  const lastSeen = Math.max(conn.info.lastEventTime, conn.lastActivityAt)
  return now - lastSeen <= staleTimeout
}

function scheduleReconnect(conn: ServerConnection) {
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)
  if (conn.subscribers.size === 0) return // 没有订阅者就不重连

  const attempt = conn.info.reconnectAttempt
  // 后台时使用更激进的重连策略
  const delays = isInBackground ? BACKGROUND_RECONNECT_DELAYS : RECONNECT_DELAYS
  const delay = delays[Math.min(attempt, delays.length - 1)]

  if (import.meta.env.DEV) {
    logger.log(
      `[SSE] Reconnecting ${conn.serverId} in ${delay}ms (attempt ${attempt + 1}, background: ${isInBackground})...`,
    )
  }

  conn.reconnectTimer = setTimeout(() => {
    updateConnectionState(conn.serverId, { reconnectAttempt: attempt + 1 })
    connectServer(conn.serverId)
  }, delay)
}

function connectServer(serverId: string) {
  const conn = getOrCreateConnection(serverId)
  if (conn.isConnecting || conn.subscribers.size === 0) return

  // 如果状态声称 connected，验证连接是否真的活着
  if (conn.info.state === 'connected') {
    if (isConnectionFresh(conn)) {
      return // 连接确实还活着
    }
    // 太久没有任何活动，连接可能已死，强制断开再重连
    if (import.meta.env.DEV) {
      const staleSec = Math.round((Date.now() - Math.max(conn.info.lastEventTime, conn.lastActivityAt)) / 1000)
      logger.log(`[SSE] connectServer: ${serverId} state=connected but stale (${staleSec}s), forcing disconnect`)
    }
    updateConnectionState(serverId, { state: 'disconnected' })
  }

  // 建立新传输前，务必彻底终止上一条流：递增代次让旧的 for-await / reader 循环
  // 在下一次迭代退出，并 abort 旧 controller 触发其 AbortError 提前结束。
  // 若漏掉这一步，心跳超时经 scheduleReconnect 重连时（该路径不改代次）会留下
  // 两条并发流，同一条 text.delta 被两条流各追加一次 → 正文成倍重复。
  conn.generation++
  teardownConnectionTransport(conn)

  conn.isConnecting = true

  updateConnectionState(serverId, { state: 'connecting' })
  if (import.meta.env.DEV) {
    logger.log(`[SSE] Connecting ${serverId}...`)
  }

  // 注册生命周期监听器（首次连接时）
  registerLifecycleListeners()

  // 事件流走 @opencode/client 的 event.subscribe()（AsyncIterable）。
  // 事件流：v2 是唯一受支持的协议。
  connectViaV2(conn)
}


// ============================================
// v2 event stream (via @opencode/client event.subscribe)
// ============================================

function connectViaV2(conn: ServerConnection) {
  conn.controller = new AbortController()
  const myGeneration = conn.generation
  const serverId = conn.serverId
  const client = getV2Client(serverId)

  ;(async () => {
    try {
      /**
       * `onActivity` 在每个网络 chunk 到达时回调，**包括不带 data 的注释心跳帧**。
       *
       * 这是「连接还活着」的唯一可靠信号：SDK 的 SSE 解析器只在 data 非空时
       * yield，所以注释帧不会进入下面的 for-await。只靠事件重置心跳的话，
       * 空闲会话 60s 后必被误判断连（实测服务端心跳间隔约 15s）。
       */
      const stream = client.event.subscribe({
        signal: conn.controller?.signal,
        onActivity: () => {
          if (myGeneration !== conn.generation) return
          touchConnection(conn)
        },
      })

      finalizeConnectionAttempt(conn, myGeneration)
      updateConnectionState(serverId, { state: 'connected', reconnectAttempt: 0, error: undefined })
      conn.lastActivityAt = Date.now()
      resetHeartbeat(conn)
      if (import.meta.env.DEV) logger.log(`[SSE/v2] ${serverId} connected`)

      const reason = serverSwitchFlags.get(serverId) ? ('server-switch' as const) : ('network' as const)
      serverSwitchFlags.delete(serverId)
      broadcastReconnected(conn, reason)

      for await (const event of stream) {
        if (myGeneration !== conn.generation) break
        resetHeartbeat(conn)
        // 缺口检测必须在映射之前：seq 只在原始事件上，映射后就丢了。
        // 构成缺口的事件直接丢弃（数据不可信，等快照重拉）。
        if (checkSeqGap(conn, event)) continue
        const globalEvent = v2EventToGlobalEvent(event)
        if (globalEvent) broadcastEvent(conn, globalEvent)
      }

      // 流正常结束：按断连处理并重连。
      if (myGeneration === conn.generation) {
        updateConnectionState(serverId, { state: 'disconnected' })
        scheduleReconnect(conn)
      }
    } catch (error) {
      if (!finalizeConnectionAttempt(conn, myGeneration)) return
      if (error instanceof Error && error.name === 'AbortError') return
      const errorMsg = error instanceof Error ? error.message : String(error)

      /**
       * 背压溢出：SDK 的 subscriber 队列满（默认 4096 条）时会抛
       * `Event subscriber exceeded its N-event capacity` 并**停掉整条连接**。
       *
       * 这既不是网络故障也不是服务端故障，而是「本地消费不过来」——通常是主线程
       * 被渲染或大 delta 风暴占满。它与断线的处理方式应当不同：
       *   - 断线：指数退避，避免服务端故障时高频重连；
       *   - 背压：**立即重连**（退避只会让积压更久），并把已消费的 seq 水位
       *     作废，让重连后的第一条事件按「首次见到」放行（否则会被判成缺口
       *     而反复触发快照重拉）。
       *
       * 另外必须让该服务器所有会话都失效：溢出期间丢的事件是**跨会话**的，
       * 无法知道具体丢了哪些，只能整台重拉一次。
       */
      if (isBackpressureError(error)) {
        logger.warn(`[SSE/v2] ${serverId} backpressure overflow, reconnecting immediately:`, errorMsg)
        // 水位作废：重连后按首次见到处理，避免误判缺口
        seqTrackers.get(serverId)?.clear()
        /**
         * 溢出期间丢的事件是**跨会话**的，无法知道具体丢了哪些，只能整台重拉。
         * 传输层不直接碰 store（避免 api → store 的反向依赖），交给上层处理。
         */
        conn.subscribers.forEach(cb => cb.onBackpressure?.(errorMsg))
        updateConnectionState(serverId, { state: 'connecting', error: errorMsg })
        // 立即重连，不走退避
        conn.generation++
        teardownConnectionTransport(conn)
        connectServer(serverId)
        return
      }

      if (import.meta.env.DEV) logger.warn(`[SSE/v2] ${serverId} error:`, errorMsg)
      updateConnectionState(serverId, { state: 'error', error: errorMsg })
      conn.subscribers.forEach(cb => cb.onError?.(error instanceof Error ? error : new Error(errorMsg)))
      scheduleReconnect(conn)
    }
  })()
}

// ============================================
// Browser SSE (via fetch + ReadableStream)
// ============================================


function getMessageInfo(properties: unknown): ApiMessage | undefined {
  if (!isRecord(properties)) return undefined
  const message = properties.info ?? properties.message
  return isRecord(message) ? (message as ApiMessage) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

// ============================================
// Background Keepalive
// ============================================

/**
 * 后台 keepalive：定期检查所有连接是否还活着
 * 移动端后台时 SSE 连接可能静默断开，timer 也可能被冻结
 * 这个轮询机制可以在 timer 恢复执行时及时发现连接已死
 */
function startBackgroundKeepalive() {
  stopBackgroundKeepalive()

  keepaliveTimer = setInterval(() => {
    const now = Date.now()

    for (const conn of connections.values()) {
      const serverId = conn.serverId
      // 存活判定要算上注释心跳帧（lastActivityAt），否则空闲会话在后台会被
      // 反复判死并重连 —— 每次重连都要重拉一遍状态，既费流量又打断订阅。
      const timeSinceActivity = now - Math.max(conn.info.lastEventTime, conn.lastActivityAt)

      if (import.meta.env.DEV) {
        logger.log(
          `[SSE] Background keepalive check ${serverId}: last activity ${Math.round(timeSinceActivity / 1000)}s ago, state=${conn.info.state}`,
        )
      }

      if (conn.info.state === 'connected' && timeSinceActivity > BACKGROUND_HEARTBEAT_TIMEOUT) {
        // 连接声称是 connected，但已经太久没有任何传输层活动 — 大概率已静默断开
        logger.warn(`[SSE] Background keepalive: ${serverId} appears dead, forcing reconnect`)

        // 断开旧连接
        conn.generation++
        teardownConnectionTransport(conn)

        updateConnectionState(serverId, { state: 'disconnected', error: 'Background keepalive timeout' })
        scheduleReconnect(conn)
      } else if ((conn.info.state === 'disconnected' || conn.info.state === 'error') && conn.subscribers.size > 0) {
        // 已知断连状态，但可能 reconnectTimer 被后台冻结了 — 主动触发重连
        if (!conn.reconnectTimer && !conn.isConnecting) {
          logger.warn(`[SSE] Background keepalive: ${serverId} stale disconnect, forcing reconnect`)
          updateConnectionState(serverId, { reconnectAttempt: 0 })
          connectServer(serverId)
        }
      }
    }
  }, BACKGROUND_KEEPALIVE_INTERVAL)
}

function stopBackgroundKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
}

/**
 * 断开并移除一个服务器连接（无订阅者时调用）
 */
function disconnectServerConnection(conn: ServerConnection) {
  const serverId = conn.serverId
  if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer)
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)

  // 断开传输层（Tauri bridge / browser fetch）
  conn.generation++
  teardownConnectionTransport(conn)
  connections.delete(serverId)
  connectionListeners.delete(serverId)

  if (connections.size === 0) {
    // keepalive 的生命周期与「存在任意活跃连接」绑定：
    // 只有最后一个连接被移除时才能停掉全局保活巡检
    stopBackgroundKeepalive()
    unregisterLifecycleListeners()
  }
}

// ============================================
// Lifecycle Listeners (Visibility + Network)
// ============================================

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    // 页面恢复前台
    isInBackground = false
    // 回到前台后不再需要后台轮询，keepalive 只服务于「存在活跃连接」的后台场景
    stopBackgroundKeepalive()

    for (const conn of connections.values()) {
      if (conn.subscribers.size === 0) continue

      if (conn.info.state !== 'connected') {
        // 明确断连，立即重连
        if (import.meta.env.DEV) {
          logger.log(`[SSE] Page visible: ${conn.serverId} not connected, forcing reconnect...`)
        }
        forceReconnectNow(conn)
      } else {
        // 状态是 connected，但连接可能已经在后台静默断开。
        // 判据用「最后一次传输层活动」：后台冻结期间连注释心跳也收不到，
        // 所以这里的老化程度才是可信的断连信号。
        const staleFor = Date.now() - Math.max(conn.info.lastEventTime, conn.lastActivityAt)
        if (staleFor > HEARTBEAT_TIMEOUT) {
          // 太久没有任何活动了，连接大概率已死
          logger.warn(
            `[SSE] Page visible: ${conn.serverId} may be stale (last activity ${Math.round(staleFor / 1000)}s ago), forcing reconnect`,
          )
          forceReconnectNow(conn)
        } else {
          // 连接看起来还活着，重置心跳为前台模式
          resetHeartbeat(conn)
        }
      }
    }
  } else {
    // 页面进入后台
    isInBackground = true

    if (import.meta.env.DEV) {
      logger.log('[SSE] Page entering background, switching to background mode')
    }

    // 保持心跳运行，但切换为后台模式（更长超时）
    for (const conn of connections.values()) {
      resetHeartbeat(conn)
    }

    // 启动后台 keepalive 轮询
    if (connections.size > 0) {
      startBackgroundKeepalive()
    }
  }
}

/**
 * 强制立即重连：断开旧连接、重置计数器、立即发起新连接
 */
function forceReconnectNow(conn: ServerConnection) {
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)
  conn.reconnectTimer = null
  updateConnectionState(conn.serverId, { reconnectAttempt: 0 })

  // 断开旧连接
  conn.generation++
  teardownConnectionTransport(conn)

  connectServer(conn.serverId)
}

function handleOnline() {
  if (import.meta.env.DEV) {
    logger.log('[SSE] Network online, forcing reconnect...')
  }
  for (const conn of connections.values()) {
    if (conn.info.state !== 'connected' && conn.subscribers.size > 0) {
      forceReconnectNow(conn)
    }
  }
}

function handleOffline() {
  if (import.meta.env.DEV) {
    logger.log('[SSE] Network offline')
  }
  // 标记为断连，但不尝试重连（没网重连也没用）
  for (const conn of connections.values()) {
    if (conn.info.state === 'connected' || conn.info.state === 'connecting') {
      conn.generation++
      teardownConnectionTransport(conn)
      if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer)
      if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)
      updateConnectionState(conn.serverId, { state: 'disconnected', error: 'Network offline' })
    }
  }
  // 网络离线后所有连接都已断连，keepalive 已无服务对象，此时停止是安全的
  stopBackgroundKeepalive()
}

function registerLifecycleListeners() {
  if (lifecycleListenersRegistered) return
  lifecycleListenersRegistered = true

  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
}

function unregisterLifecycleListeners() {
  if (!lifecycleListenersRegistered) return
  lifecycleListenersRegistered = false

  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
}

// ============================================
// Event broadcast（只发给对应服务器的订阅者）
// ============================================

/**
 * 每个服务器的 durable 事件序号跟踪器。
 *
 * 用途见 `seqGap.ts`：seq 是 per-aggregate 的，跳号说明断连/背压期间丢了事件，
 * 该会话数据不可信，需要重拉快照。检测到缺口时不在这里修复（传输层不该知道
 * 业务如何重拉），而是通过 `onGap` 回调交给上层。
 */
const seqTrackers = new Map<string, SeqGapTracker>()

function getSeqTracker(serverId: string): SeqGapTracker {
  let tracker = seqTrackers.get(serverId)
  if (!tracker) {
    tracker = new SeqGapTracker()
    seqTrackers.set(serverId, tracker)
  }
  return tracker
}

/** 缺口回调：serverId + 裸 aggregateID（会话） */
export type SeqGapHandler = (serverId: string, aggregateID: string) => void
const seqGapHandlers = new Set<SeqGapHandler>()

/**
 * 订阅「检测到 seq 缺口」事件。
 *
 * 上层（useGlobalEvents）收到后应重拉该会话的快照，然后调用
 * `ackSeqGap(serverId, aggregateID)` 表示已修复 —— 否则后续事件会持续被判为缺口。
 */
export function onSeqGap(handler: SeqGapHandler): () => void {
  seqGapHandlers.add(handler)
  return () => seqGapHandlers.delete(handler)
}

/**
 * 声明某会话的缺口已被修复（快照已重拉）。
 *
 * 必须调用：重拉拿到的是权威快照，之后的事件无论 seq 是多少都应正常应用，
 * 否则会一直卡在缺口判定上反复重拉。
 */
export function ackSeqGap(serverId: string, aggregateID: string): void {
  seqTrackers.get(serverId)?.reset(serverId, aggregateID)
}

/**
 * 检查事件是否构成缺口；构成则通知订阅者并返回 true（调用方应丢弃该事件）。
 *
 * 丢弃而不是先应用再修复：缺口期间的数据本来就不可信，先写进去再被快照覆盖
 * 会让 UI 闪一下错的内容。
 */
function checkSeqGap(conn: ServerConnection, raw: unknown): boolean {
  const durable = durableOf(raw)
  if (!durable) return false // ephemeral 事件不参与

  const verdict = getSeqTracker(conn.serverId).accept(conn.serverId, durable.aggregateID, durable.seq)
  if (verdict.kind !== 'gap') return false

  if (import.meta.env.DEV) {
    logger.warn(
      `[SSE] seq gap on ${conn.serverId}/${durable.aggregateID}: expected ${verdict.expected}, got ${verdict.received}`,
    )
  }
  seqGapHandlers.forEach(fn => {
    try {
      fn(conn.serverId, durable.aggregateID)
    } catch {
      // 观察者异常不能打断事件流
    }
  })
  return true
}

function broadcastEvent(conn: ServerConnection, globalEvent: GlobalEvent) {
  conn.subscribers.forEach(callbacks => {
    handleEventForSubscriber(globalEvent.payload, callbacks)
  })
}

function handleEventForSubscriber(payload: GlobalEvent['payload'], callbacks: EventCallbacks) {
  // 扩展事件：session.renamed 不带完整 session，先于 switch 单独处理。
  if ((payload.type as string) === EventTypes.SESSION_RENAMED) {
    const props = (payload as { properties?: { sessionID?: unknown; title?: unknown } }).properties
    const sessionID = typeof props?.sessionID === 'string' ? props.sessionID : ''
    const title = typeof props?.title === 'string' ? props.title : ''
    if (sessionID) callbacks.onSessionRenamed?.({ sessionID, title })
    return
  }
  if ((payload.type as string) === EventTypes.SESSION_RETRY_SCHEDULED) {
    const props = (payload as {
      properties?: {
        sessionID?: unknown
        assistantMessageID?: unknown
        attempt?: unknown
        at?: unknown
        error?: unknown
      }
    }).properties
    const sessionID = typeof props?.sessionID === 'string' ? props.sessionID : ''
    const assistantMessageID = typeof props?.assistantMessageID === 'string' ? props.assistantMessageID : ''
    if (sessionID && assistantMessageID) {
      callbacks.onSessionRetryScheduled?.({
        sessionID,
        assistantMessageID,
        ...(typeof props?.attempt === 'number' ? { attempt: props.attempt } : {}),
        ...(typeof props?.at === 'number' ? { at: props.at } : {}),
        ...(props?.error && typeof props.error === 'object'
          ? { error: props.error as Record<string, unknown> }
          : {}),
      })
    }
    return
  }
  if ((payload.type as string) === EventTypes.SESSION_USAGE_UPDATED) {
    const props = (payload as { properties?: SessionUsagePayload }).properties
    if (props && typeof props.sessionID === 'string' && props.tokens) {
      callbacks.onSessionUsageUpdated?.(props)
    }
    return
  }
  if ((payload.type as string) === EventTypes.SESSION_VIEWED) {
    const props = (payload as { properties?: SessionViewedPayload }).properties
    if (props && typeof props.sessionID === 'string' && typeof props.idle === 'number') {
      callbacks.onSessionViewed?.(props)
    }
    return
  }
  if ((payload.type as string) === EventTypes.SESSION_COMPACTION_USAGE) {
    const props = (payload as {
      properties?: { sessionID?: unknown; tokens?: unknown; cost?: unknown; at?: unknown }
    }).properties
    if (props && typeof props.sessionID === 'string' && props.tokens) {
      callbacks.onSessionCompactionUsage?.({
        sessionID: props.sessionID,
        tokens: props.tokens as never,
        cost: typeof props.cost === 'number' ? props.cost : 0,
        at: typeof props.at === 'number' ? props.at : Date.now(),
      })
    }
    return
  }
  if ((payload.type as string) === EventTypes.SESSION_INBOX_ENQUEUED) {
    const props = (payload as { properties?: InboxEnqueuedPayload }).properties
    if (props && typeof props.sessionID === 'string' && typeof props.inboxID === 'string') {
      callbacks.onInboxEnqueued?.(props)
    }
    return
  }
  if ((payload.type as string) === EventTypes.SESSION_SYNTHETIC) {
    const props = (payload as {
      properties?: { sessionID?: unknown; text?: unknown; description?: unknown; createdAt?: unknown }
    }).properties
    if (props && typeof props.sessionID === 'string' && typeof props.text === 'string') {
      callbacks.onSessionSynthetic?.({
        sessionID: props.sessionID,
        text: props.text,
        ...(typeof props.description === 'string' ? { description: props.description } : {}),
        ...(typeof props.createdAt === 'number' ? { createdAt: props.createdAt } : {}),
      })
    }
    return
  }
  if ((payload.type as string) === EventTypes.SHELL_CREATED) {
    const props = (payload as {
      properties?: {
        id?: unknown
        status?: unknown
        command?: unknown
        cwd?: unknown
        sessionID?: unknown
        startedAt?: unknown
      }
    }).properties
    if (props && typeof props.id === 'string') {
      callbacks.onShellCreated?.({
        id: props.id,
        status: typeof props.status === 'string' ? props.status : 'running',
        command: typeof props.command === 'string' ? props.command : '',
        cwd: typeof props.cwd === 'string' ? props.cwd : '',
        ...(typeof props.sessionID === 'string' ? { sessionID: props.sessionID } : {}),
        startedAt: typeof props.startedAt === 'number' ? props.startedAt : Date.now(),
      })
    }
    return
  }
  if ((payload.type as string) === EventTypes.SHELL_EXITED) {
    const props = (payload as {
      properties?: { id?: unknown; status?: unknown; exit?: unknown; endedAt?: unknown }
    }).properties
    if (props && typeof props.id === 'string') {
      callbacks.onShellExited?.({
        id: props.id,
        status: typeof props.status === 'string' ? props.status : 'exited',
        ...(typeof props.exit === 'number' ? { exit: props.exit } : {}),
        endedAt: typeof props.endedAt === 'number' ? props.endedAt : Date.now(),
      })
    }
    return
  }
  switch (payload.type) {
    case EventTypes.MESSAGE_UPDATED: {
      const message = getMessageInfo(payload.properties)
      if (message) callbacks.onMessageUpdated?.(message)
      break
    }
    case EventTypes.MESSAGE_PART_UPDATED: {
      callbacks.onPartUpdated?.(payload.properties.part)
      break
    }
    case EventTypes.MESSAGE_PART_DELTA: {
      callbacks.onPartDelta?.(payload.properties as unknown as PartDeltaPayload)
      break
    }
    case EventTypes.MESSAGE_PART_REMOVED:
      callbacks.onPartRemoved?.(payload.properties as unknown as PartRemovedPayload)
      break
    case EventTypes.MESSAGE_REMOVED: {
      // v2 用它撤销一条已入队但未处理的用户消息（session.inbox.cancelled）。
      // 不处理会留下一条永远不会被 agent 处理的用户消息，且刷新后消失，
      // 表现为「这条消息发出去了但一直没回应」。
      const props = payload.properties as { sessionID?: unknown; messageID?: unknown; messageId?: unknown }
      const sessionID = typeof props?.sessionID === 'string' ? props.sessionID : ''
      const messageID =
        typeof props?.messageID === 'string' ? props.messageID : typeof props?.messageId === 'string' ? props.messageId : ''
      if (sessionID && messageID) callbacks.onMessageRemoved?.({ sessionID, messageID })
      break
    }
    case EventTypes.SESSION_UPDATED: {
      callbacks.onSessionUpdated?.(payload.properties.info)
      break
    }
    case EventTypes.SESSION_CREATED: {
      callbacks.onSessionCreated?.(payload.properties.info)
      break
    }
    case EventTypes.SESSION_DELETED: {
      callbacks.onSessionDeleted?.(payload.properties.sessionID)
      break
    }
    case EventTypes.PROJECT_UPDATED: {
      callbacks.onProjectUpdated?.(payload.properties)
      break
    }
    case EventTypes.SESSION_ERROR:
      callbacks.onSessionError?.(normalizeSessionError(payload.properties))
      break
    case EventTypes.SESSION_IDLE:
      callbacks.onSessionIdle?.(payload.properties)
      break
    case EventTypes.SESSION_COMPACTED:
      callbacks.onSessionCompacted?.(payload.properties as unknown as SessionCompactedPayload)
      break
    case EventTypes.SESSION_STATUS:
      callbacks.onSessionStatus?.(payload.properties)
      break
    case EventTypes.PERMISSION_ASKED:
      callbacks.onPermissionAsked?.(payload.properties)
      break
    case EventTypes.PERMISSION_REPLIED:
      callbacks.onPermissionReplied?.(payload.properties)
      break
    case EventTypes.QUESTION_ASKED:
      callbacks.onQuestionAsked?.(payload.properties)
      break
    case EventTypes.QUESTION_REPLIED:
      callbacks.onQuestionReplied?.(payload.properties)
      break
    case EventTypes.QUESTION_REJECTED:
      callbacks.onQuestionRejected?.(payload.properties)
      break
    case EventTypes.WORKTREE_READY:
      callbacks.onWorktreeReady?.(payload.properties)
      break
    case EventTypes.WORKTREE_FAILED:
      callbacks.onWorktreeFailed?.(payload.properties)
      break
    case EventTypes.VCS_BRANCH_UPDATED:
      callbacks.onVcsBranchUpdated?.(payload.properties)
      break
    case EventTypes.TODO_UPDATED: {
      callbacks.onTodoUpdated?.({
        sessionID: payload.properties.sessionID,
        todos: normalizeTodoItems(payload.properties.todos),
      } satisfies TodoUpdatedPayload)
      break
    }
    case EventTypes.SERVER_CONNECTED:
      callbacks.onServerConnected?.(normalizeServerConnected(payload.properties))
      break
    case EventTypes.SESSION_NEXT_TOOL_PROGRESS: {
      const props = payload.properties as Partial<NextToolProgressPayload> | undefined
      const sessionID = typeof props?.sessionID === 'string' ? props.sessionID : ''
      const callID = typeof props?.callID === 'string' ? props.callID : ''
      if (sessionID && callID) {
        callbacks.onNextToolProgress?.({
          sessionID,
          callID,
          ...(props?.metadata && typeof props.metadata === 'object' ? { metadata: props.metadata } : {}),
        })
      }
      break
    }
    case EventTypes.SESSION_NEXT_TOOL_SUCCESS: {
      const settled = normalizeNextToolSettled(payload.properties, 'completed')
      if (settled) callbacks.onNextToolSettled?.(settled)
      break
    }
    case EventTypes.SESSION_NEXT_SHELL_ENDED: {
      const settled = normalizeNextToolSettled(payload.properties, 'completed')
      if (settled) callbacks.onNextToolSettled?.(settled)
      break
    }
    case EventTypes.SESSION_NEXT_TOOL_FAILED: {
      const settled = normalizeNextToolSettled(payload.properties, 'error')
      if (settled) callbacks.onNextToolSettled?.(settled)
      break
    }
    default:
      // 忽略其他事件类型
      break
  }
}

/**
 * 归一 session.next.tool.success/failed / shell.ended 的 properties。
 * 只需要 sessionID + callID + 终态；content/output 仅作兜底文本。
 */
function normalizeNextToolSettled(
  properties: unknown,
  status: 'completed' | 'error',
): NextToolSettledPayload | null {
  if (!isRecord(properties)) return null
  const sessionID = typeof properties.sessionID === 'string' ? properties.sessionID : ''
  const callID = typeof properties.callID === 'string' ? properties.callID : ''
  if (!sessionID || !callID) return null

  if (status === 'error') {
    // 适配层已把错误归一成字符串；这里兼容 Error 对象（{name,message}）与纯字符串。
    const error = isRecord(properties.error)
      ? typeof properties.error.message === 'string'
        ? properties.error.message
        : typeof properties.error.name === 'string'
          ? properties.error.name
          : typeof properties.error.type === 'string'
            ? properties.error.type
            : undefined
      : typeof properties.error === 'string'
        ? properties.error
        : undefined
    return { sessionID, callID, status, error, metadata: settledMetadata(properties) }
  }

  // shell.ended 的 output 是字符串；tool.success 的 content 是文本块数组。
  let output: string | undefined
  if (typeof properties.output === 'string') {
    output = properties.output
  } else if (Array.isArray(properties.content)) {
    const texts = properties.content
      .filter((item): item is { type: 'text'; text: string } => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text)
    if (texts.length > 0) output = texts.join('\n')
  }

  return { sessionID, callID, status, output, metadata: settledMetadata(properties) }
}

/**
 * 从工具结束事件里取工具结果 metadata。
 * 与 v2 事件适配层共用同一个 helper（候选字段 metadata / structured / result），
 * 供前端把 task 行识别成「子代理」而非普通工具。
 */
const settledMetadata = toolResultMetadata

function normalizeServerConnected(properties: unknown): ServerConnectedPayload {
  if (!isRecord(properties)) return {}
  return {
    timestamp: properties.timestamp,
  }
}

function normalizeSessionError(properties: unknown): SessionErrorPayload {
  if (!isRecord(properties)) {
    return { sessionID: '', name: 'UnknownError', data: properties }
  }

  const sessionID = typeof properties.sessionID === 'string' ? properties.sessionID : ''

  if (typeof properties.name === 'string') {
    return {
      sessionID,
      name: properties.name,
      data: properties.data,
    }
  }

  const sdkError = properties.error
  if (isRecord(sdkError)) {
    return {
      sessionID,
      name: typeof sdkError.name === 'string' ? sdkError.name : 'UnknownError',
      data: 'data' in sdkError ? sdkError.data : sdkError,
    }
  }

  return {
    sessionID,
    name: 'UnknownError',
    data: sdkError,
  }
}

// ============================================
// Public API
// ============================================

/**
 * 强制重连指定服务器 SSE（用于切换服务器等场景）
 * 断开当前连接 → 重置状态 → 立即重连（新 URL 由 getApiBaseUrl(serverId) 动态解析）
 */
export function reconnectServerSSE(serverId: string) {
  const conn = connections.get(serverId)
  if (!conn || conn.subscribers.size === 0) return // 没有订阅者不需要重连

  if (import.meta.env.DEV) {
    logger.log(`[SSE] reconnectServerSSE(${serverId}) called, forcing reconnect...`)
  }

  // 断开现有连接
  if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer)
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)
  conn.reconnectTimer = null
  // 这是单个 server 的重连，连接仍然存在（马上会重连），
  // 因此不能停全局 keepalive，否则其余服务器会失去后台兜底

  // 标记为服务器切换，重连成功时 onReconnected 会携带 'server-switch' reason
  serverSwitchFlags.set(serverId, true)

  // 递增连接代次，使旧连接的事件回调自动失效
  conn.generation++
  teardownConnectionTransport(conn)

  // 重置重连计数
  updateConnectionState(serverId, {
    state: 'disconnected',
    reconnectAttempt: 0,
    error: undefined,
  })

  // 立即重连
  connectServer(serverId)
}

/**
 * 确保指定服务器已建立 SSE 连接（幂等）。
 *
 * 与 reconnectServerSSE 的区别：不主动断开已有连接。
 * connectServer 内部判断「已 connected 且心跳未超时」时直接返回，
 * 因此已连着的服务器不会被打断，状态点不会闪 disconnected/connecting。
 *
 * 用于切换活动服务器：多服务器模式下每台服务器本来就各有一条常驻连接，
 * 切换只是改「看哪一台」，无需重连。
 */
export function ensureServerSSE(serverId: string) {
  connectServer(serverId)
}

/**
 * 强制重连活动服务器 SSE（兼容旧 API）
 */
export function reconnectSSE() {
  reconnectServerSSE(serverStore.getActiveServerId())
}

/**
 * 断开指定服务器 SSE
 */
export function disconnectServerSSE(serverId: string, error?: string) {
  const conn = connections.get(serverId)
  if (!conn) return
  // 先广播状态再断开并移除连接，避免 updateConnectionState 隐式重建空壳连接
  updateConnectionState(serverId, { state: error ? 'error' : 'disconnected', error, reconnectAttempt: 0 })
  disconnectServerConnection(conn)
}

/**
 * 获取指定服务器连接状态（返回稳定引用，供 useSyncExternalStore 使用）
 */
export function getServerConnectionInfo(serverId: string): ConnectionInfo {
  return connections.get(serverId)?.info ?? DEFAULT_CONNECTION_INFO
}

/**
 * 获取活动服务器连接状态（兼容旧 API）
 */
export function getConnectionInfo(): ConnectionInfo {
  return getServerConnectionInfo(serverStore.getActiveServerId())
}

/**
 * 订阅指定服务器连接状态
 */
export function subscribeToServerConnectionState(serverId: string, fn: (info: ConnectionInfo) => void): () => void {
  let listeners = connectionListeners.get(serverId)
  if (!listeners) {
    listeners = new Set()
    connectionListeners.set(serverId, listeners)
  }
  listeners.add(fn)
  // 立即发送当前状态
  fn(getServerConnectionInfo(serverId))
  return () => {
    listeners?.delete(fn)
  }
}

/**
 * 订阅活动服务器连接状态（兼容旧 API）
 */
export function subscribeToConnectionState(fn: (info: ConnectionInfo) => void): () => void {
  return subscribeToServerConnectionState(serverStore.getActiveServerId(), fn)
}

/**
 * 订阅指定服务器的 SSE 事件（每服务器独立连接）
 */
export function subscribeToServerEvents(serverId: string, callbacks: EventCallbacks): () => void {
  const conn = getOrCreateConnection(serverId)
  conn.subscribers.add(callbacks)

  // 如果是第一个订阅者，启动连接
  if (conn.subscribers.size === 1) {
    // 第一个订阅者：建立 v2 事件流订阅。
    connectServer(serverId)
  }

  // 返回取消订阅函数
  return () => {
    conn.subscribers.delete(callbacks)

    // 如果没有订阅者了，断开连接
    if (conn.subscribers.size === 0) {
      disconnectServerConnection(conn)
    }
  }
}

/**
 * 订阅活动服务器 SSE 事件（兼容旧 API）。
 * 订阅跟随 active server：切换服务器时自动迁移订阅（恢复改动前的单例语义）。
 */
export function subscribeToEvents(callbacks: EventCallbacks): () => void {
  let currentServerId = serverStore.getActiveServerId()
  let unsubscribe = subscribeToServerEvents(currentServerId, callbacks)

  const offServerChange = serverStore.onServerChange(newServerId => {
    if (newServerId === currentServerId) return
    unsubscribe()
    currentServerId = newServerId
    unsubscribe = subscribeToServerEvents(currentServerId, callbacks)
  })

  return () => {
    offServerChange()
    unsubscribe()
  }
}
