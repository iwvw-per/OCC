// ============================================
// NotificationStore - Toast + 通知历史
// ============================================
//
// 统一管理所有通知：
// 1. Toast 弹窗（右上角，8 秒自动消失，悬停暂停）
// 2. 通知历史（持久化到 localStorage，显示在 Active tab 的 Notifications 区域）
//
// 由 useGlobalEvents 统一推送，不再由 activeSessionStore 管通知

import { useSyncExternalStore } from 'react'
import { sessionKeyToServerId, sessionKeyToSessionId } from '../utils/sessionKey'
import { isSameDirectory } from '../utils/directoryUtils'
import { readWatermarkStore, watermarkNow } from './readWatermarkStore'

// ============================================
// Types
// ============================================

export type NotificationType = 'permission' | 'question' | 'completed' | 'error'

/** push 后的回调，用于声音播放等扩展 */
export type NotificationPushListener = (type: NotificationType) => void

export interface NotificationEntry {
  id: string
  type: NotificationType
  title: string
  body: string
  sessionId: string
  /**
   * 通知所属服务器（复合 key 里的 serverId 段）。
   *
   * 为什么单独存：通知按 directory 汇总到项目行，而侧栏项目列表只展示
   * 当前活动服务器的会话。两台服务器指向同一后端（或存在同名路径）时，
   * 仅凭 directory 匹配会让 A 服务器的完成通知点亮 B 服务器的项目行，
   * 而那一行并不在本列表里，点不到也清不掉。
   */
  serverId?: string
  directory?: string
  timestamp: number
  read: boolean
}

export interface ToastItem {
  notification: NotificationEntry
  exiting: boolean
}

export interface NotificationPreferencesBackup {
  toastEnabled: boolean
}

interface NotificationState {
  toasts: ToastItem[]
  notifications: NotificationEntry[]
}

type Subscriber = () => void

// ============================================
// Constants
// ============================================

const TOAST_DURATION = 8000
const MAX_TOASTS = 3
const EXIT_ANIMATION_MS = 200
const STORAGE_KEY = 'opencode:notifications'
const TOAST_ENABLED_KEY = 'opencode:toast-enabled'
const MAX_NOTIFICATIONS = 50

// ============================================
// localStorage helpers
// ============================================

function loadNotifications(): NotificationEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return (JSON.parse(raw) as NotificationEntry[]).slice(0, MAX_NOTIFICATIONS)
  } catch {
    return []
  }
}

function saveNotifications(entries: NotificationEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // quota exceeded
  }
}

// ============================================
// Store
// ============================================

class NotificationStore {
  private state: NotificationState = {
    toasts: [],
    notifications: loadNotifications(),
  }
  private subscribers = new Set<Subscriber>()
  private toastTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pushListeners = new Set<NotificationPushListener>()

  constructor() {
    // 水位变化（本地标记已读，或跨端同步 pull 到另一端的已读）后，把受影响的
    // completed 通知的本地 read 缓存重算。read 是本地派生缓存，水位才是跨端权威：
    // 通知时间戳 <= 水位即已读。这里只单向抬高（read: false -> true），
    // 不回退，避免「已读又变未读」。
    readWatermarkStore.subscribe(() => this.reconcileReadFromWatermarks())
  }

  /**
   * 按已读水位重算 completed 通知的本地 read 标志。
   * 只把未读变已读，不反向；permission/question/error 等主动类型不参与水位。
   */
  private reconcileReadFromWatermarks() {
    let changed = false
    const notifications = this.state.notifications.map(n => {
      if (n.read) return n
      if (n.type !== 'completed') return n
      const bareId = sessionKeyToSessionId(n.sessionId)
      if (!bareId) return n
      if (!readWatermarkStore.isRead(bareId, n.timestamp)) return n
      changed = true
      return { ...n, read: true }
    })
    if (!changed) return
    this.state = { ...this.state, notifications }
    this.persist()
    this.notify()
  }

  /** toast 弹窗总开关 */
  toastEnabled: boolean = (() => {
    try {
      return localStorage.getItem(TOAST_ENABLED_KEY) !== 'false'
    } catch {
      return true
    }
  })()

  subscribe = (callback: Subscriber): (() => void) => {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  private notify() {
    this.subscribers.forEach(cb => cb())
  }

  private persist() {
    saveNotifications(this.state.notifications)
  }

  getSnapshot = (): NotificationState => this.state

  setToastEnabled(enabled: boolean) {
    this.toastEnabled = enabled
    try {
      localStorage.setItem(TOAST_ENABLED_KEY, String(enabled))
    } catch {
      // Ignore storage write failures.
    }
    // 关闭时清掉当前所有 toast
    if (!enabled) this.dismissAllToasts()
  }

  /** 注册 push 后回调（声音播放等） */
  onPush(listener: NotificationPushListener): () => void {
    this.pushListeners.add(listener)
    return () => this.pushListeners.delete(listener)
  }

  // ============================================
  // 推送通知（加历史 + 弹 toast）
  // ============================================

  push(type: NotificationType, title: string, body: string, sessionId: string, directory?: string) {
    // 用校准钟（与已读水位同一基准），否则跨端比较无意义
    const timestamp = watermarkNow()
    /**
     * 入队即判断水位，而不是一律 read: false。
     *
     * 水位是跨端权威：同一会话在另一端已经展开/点开过（水位已抬高），本端后到的
     * completed 通知若仍标成未读，就会亮出一个「其实早已读过」的点 —— 用户点了
     * 也没有任何可清的内容（对应的消息他早就看过了）。reconcileReadFromWatermarks
     * 只在水位「变化时」触发，覆盖不到这种「水位早已领先、通知才到」的顺序。
     */
    const bareId = sessionKeyToSessionId(sessionId)
    const read =
      type === 'completed' && !!bareId && readWatermarkStore.isRead(bareId, timestamp)

    const entry: NotificationEntry = {
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      title,
      body,
      sessionId,
      serverId: sessionKeyToServerId(sessionId) || undefined,
      directory,
      timestamp,
      read,
    }

    // 加到历史
    const notifications = [entry, ...this.state.notifications].slice(0, MAX_NOTIFICATIONS)

    // 弹 toast（仅开关打开时）
    if (this.toastEnabled) {
      const toasts = [...this.state.toasts]
      if (toasts.length >= MAX_TOASTS) {
        const oldest = toasts.pop()
        if (oldest) this.clearToastTimer(oldest.notification.id)
      }
      toasts.unshift({ notification: entry, exiting: false })
      this.state = { ...this.state, toasts, notifications }
      this.persist()
      this.notify()
      this.scheduleToastDismiss(entry.id)
    } else {
      this.state = { ...this.state, notifications }
      this.persist()
      this.notify()
    }

    // 触发 push 后回调（声音播放等）
    this.pushListeners.forEach(fn => {
      try {
        fn(type)
      } catch {
        // 回调异常不影响通知流程
      }
    })
  }

  // ============================================
  // 用户交互（通知历史）
  // ============================================

  markRead(id: string) {
    const target = this.state.notifications.find(n => n.id === id)
    const notifications = this.state.notifications.map(n => (n.id === id && !n.read ? { ...n, read: true } : n))
    this.state = { ...this.state, notifications }
    // 抬高水位使其它端也视为已读（仅 completed 参与水位治理）
    if (target && target.type === 'completed') readWatermarkStore.raise(target.sessionId, target.timestamp)
    this.persist()
    this.notify()
  }

  markAllRead() {
    const now = watermarkNow()
    const notifications = this.state.notifications.map(n => (n.read ? n : { ...n, read: true }))
    this.state = { ...this.state, notifications }
    // 仅 completed 参与水位治理，与 markRead/markMatching 口径一致
    readWatermarkStore.raiseMany(
      this.state.notifications.filter(n => n.type === 'completed').map(n => n.sessionId),
      now,
    )
    this.persist()
    this.notify()
  }

  /**
   * 把某个会话的通知标为已读。
   *
   * 匹配用「裸 sessionId」而非完整复合 key：同一个会话可能被多条 SSE
   * 推送成不同前缀的通知（`local::ses_x` 与 `aiagent:inst_...::ses_x`）——
   * 当两台已连接服务器实际指向同一后端时就会发生。只按当前焦点的那个前缀清，
   * 另一个前缀的未读点会永久残留。
   */
  markSessionNotificationsRead(sessionId: string, type?: NotificationType) {
    const bareId = sessionKeyToSessionId(sessionId)
    if (!bareId) return
    this.markMatching(n => sessionKeyToSessionId(n.sessionId) === bareId, type)
  }

  /**
   * 把某个项目（一个或多个目录，限定在指定服务器）下的未读通知全部标为已读。
   *
   * 为什么需要目录级清理：项目行的未读点是按 directory 汇总的，而清理只能靠
   * 逐条点击会话行。会话一旦不在侧栏可见范围（分页只加载前几条、已归档、
   * 被别的客户端删除、子会话不在列表），就没有任何入口能清掉那条通知，
   * 项目行会永久亮着。展开项目即视为「用户已看过这个项目的更新」。
   */
  markDirectoryNotificationsRead(serverId: string, directories: string[], type?: NotificationType) {
    if (directories.length === 0) return
    this.markMatching(
      n =>
        this.entryServerId(n) === serverId &&
        directories.some(directory => isSameDirectory(directory, n.directory)),
      type,
    )
  }

  /** 通知所属服务器：优先用入队时记录的字段，旧数据从复合 key 反解兜底 */
  private entryServerId(entry: NotificationEntry): string {
    return entry.serverId ?? sessionKeyToServerId(entry.sessionId)
  }

  private markMatching(predicate: (entry: NotificationEntry) => boolean, type?: NotificationType) {
    let changed = false
    // 记录被标记的会话及其时间戳，用于抬高水位（跨端同步已读）。
    const watermarkBySession = new Map<string, number>()
    const notifications = this.state.notifications.map(n => {
      if (!predicate(n)) return n
      if (type && n.type !== type) return n
      if (n.read) return n
      changed = true
      // 水位只治理 completed 未读点；其它主动类型（permission/question/error）
      // 不参与，抬水位时一并跳过，避免误伤同会话更早的 completed 通知。
      if (n.type === 'completed') {
        const bareId = sessionKeyToSessionId(n.sessionId)
        if (bareId) {
          const prev = watermarkBySession.get(bareId) ?? 0
          if (n.timestamp > prev) watermarkBySession.set(bareId, n.timestamp)
        }
      }
      return { ...n, read: true }
    })
    if (!changed) return
    this.state = { ...this.state, notifications }
    for (const [bareId, at] of watermarkBySession) readWatermarkStore.raise(bareId, at)
    this.persist()
    this.notify()
  }

  dismiss(id: string) {
    const notifications = this.state.notifications.filter(n => n.id !== id)
    this.state = { ...this.state, notifications }
    this.persist()
    this.notify()
  }

  /**
   * 会话被删除/归档时清掉它的通知。
   *
   * 为什么必须清：通知按 directory 汇总到项目行（见 FolderRecentList 的
   * buildFolderStatus），而会话被删掉后列表里已无对应行。不清的话项目行会一直
   * 亮着未读点，展开却找不到是哪个会话 —— 孤儿通知。
   *
   * 匹配用「裸 sessionId」：删除入口拿到的是裸 id，而通知里存的是复合 key
   * （serverId::sessionId），且同一会话可能因多条 SSE 而有多个前缀。
   */
  removeSessionNotifications(sessionId: string) {
    const bareId = sessionKeyToSessionId(sessionId)
    if (!bareId) return
    const notifications = this.state.notifications.filter(n => sessionKeyToSessionId(n.sessionId) !== bareId)
    if (notifications.length === this.state.notifications.length) return
    this.state = { ...this.state, notifications }
    this.persist()
    this.notify()
  }

  clearAll() {
    this.state = { ...this.state, notifications: [] }
    this.persist()
    this.notify()
  }

  // ============================================
  // Toast 管理
  // ============================================

  /**
   * 纯 toast 轻提示：不进通知历史、不产生未读点、点击不跳转。
   * 用于「已重连」「操作完成」这类系统级提示（push 会把系统提示写进会话通知，
   * 残留孤儿未读点；这类提示不该出现在通知历史里）。
   */
  toast(type: NotificationType, title: string, body?: string) {
    if (!this.toastEnabled) return
    const entry: NotificationEntry = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      title,
      body: body ?? '',
      sessionId: '',
      directory: undefined,
      timestamp: Date.now(),
      read: true,
    }

    const toasts = [...this.state.toasts]
    if (toasts.length >= MAX_TOASTS) {
      const oldest = toasts.pop()
      if (oldest) this.clearToastTimer(oldest.notification.id)
    }
    toasts.unshift({ notification: entry, exiting: false })
    this.state = { ...this.state, toasts }
    this.notify()
    this.scheduleToastDismiss(entry.id)
  }

  private scheduleToastDismiss(id: string) {
    this.clearToastTimer(id)
    const timer = setTimeout(() => this.dismissToast(id), TOAST_DURATION)
    this.toastTimers.set(id, timer)
  }

  private clearToastTimer(id: string) {
    const timer = this.toastTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.toastTimers.delete(id)
    }
  }

  pauseToast(id: string) {
    this.clearToastTimer(id)
  }

  resumeToast(id: string) {
    const exists = this.state.toasts.some(t => t.notification.id === id && !t.exiting)
    if (exists) {
      this.scheduleToastDismiss(id)
    }
  }

  dismissToast(id: string) {
    this.clearToastTimer(id)
    const toasts = this.state.toasts.map(t => (t.notification.id === id ? { ...t, exiting: true } : t))
    this.state = { ...this.state, toasts }
    this.notify()

    setTimeout(() => {
      this.state = {
        ...this.state,
        toasts: this.state.toasts.filter(t => t.notification.id !== id),
      }
      this.notify()
    }, EXIT_ANIMATION_MS)
  }

  dismissAllToasts() {
    this.toastTimers.forEach(timer => clearTimeout(timer))
    this.toastTimers.clear()
    this.state = { ...this.state, toasts: [] }
    this.notify()
  }
}

// ============================================
// 单例 & React Hooks
// ============================================

export const notificationStore = new NotificationStore()

export function exportNotificationPreferencesBackup(): NotificationPreferencesBackup {
  return {
    toastEnabled: notificationStore.toastEnabled,
  }
}

export function importNotificationPreferencesBackup(raw: unknown): void {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const toastEnabled = typeof parsed?.toastEnabled === 'boolean' ? parsed.toastEnabled : true
  notificationStore.setToastEnabled(toastEnabled)
}

export function useNotificationStore() {
  return useSyncExternalStore(notificationStore.subscribe, notificationStore.getSnapshot)
}

/** 通知历史列表 */
export function useNotifications(): NotificationEntry[] {
  const state = useNotificationStore()
  return state.notifications
}

/** 未读通知数 */
export function useUnreadNotificationCount(): number {
  const state = useNotificationStore()
  return state.notifications.filter(n => !n.read).length
}

/**
 * 未读 completed 通知对应的 sessionId 集合。
 *
 * 按 notifications 数组引用缓存：这个 hook 被每个会话行调用（SessionListItem），
 * 每次渲染都 new Set 会让集合引用恒变，配合 useHasUnreadCompletedNotification
 * 的逐行调用，任意一条通知变化都会让展开列表里所有会话行重渲染。
 * store 只在内容变化时替换数组引用，按引用缓存即可稳定。
 */
const unreadCompletedCache = new WeakMap<readonly NotificationEntry[], Set<string>>()

function unreadCompletedSessionIds(notifications: readonly NotificationEntry[]): Set<string> {
  const cached = unreadCompletedCache.get(notifications)
  if (cached) return cached
  const next = new Set(notifications.filter(n => n.type === 'completed' && !n.read).map(n => n.sessionId))
  unreadCompletedCache.set(notifications, next)
  return next
}

export function useUnreadCompletedSessionIds(): Set<string> {
  const state = useNotificationStore()
  return unreadCompletedSessionIds(state.notifications)
}

/**
 * 通知所属服务器。入队时记录优先；旧数据没有该字段时从复合 key 反解。
 * 供按服务器收窄的汇总逻辑（项目行状态）复用。
 */
export function notificationServerId(entry: NotificationEntry): string {
  return entry.serverId ?? sessionKeyToServerId(entry.sessionId)
}

/** 某个 session 是否有未读 completed 通知 */
export function useHasUnreadCompletedNotification(sessionId: string): boolean {
  const unreadCompletedSessionIds = useUnreadCompletedSessionIds()
  return unreadCompletedSessionIds.has(sessionId)
}
