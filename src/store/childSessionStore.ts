// ============================================
// ChildSessionStore - 追踪子 session 关系
// ============================================
//
// 核心功能：
// 1. 追踪哪些 session 是当前 session 的子 session
// 2. 支持权限请求冒泡（子 session 的权限请求显示在父界面）
// 3. 存储子 session 的基本信息（用于显示来源）

import type { ApiSession } from '../api/types'
import { makeSessionKey } from '../utils/sessionKey'
import { serverStore } from './serverStore'
import i18n from '../i18n'

// ============================================
// Types
// ============================================

export interface ChildSessionInfo {
  id: string
  parentID: string
  title: string
  agent?: string // 子 agent 名称
  status: 'running' | 'idle' | 'error'
  createdAt: number
}

type Subscriber = () => void

// ============================================
// Store Implementation
// ============================================

class ChildSessionStore {
  // parentID -> Set of child session IDs
  private childrenByParent = new Map<string, Set<string>>()
  // sessionID -> ChildSessionInfo
  private sessionInfo = new Map<string, ChildSessionInfo>()
  private subscribers = new Set<Subscriber>()
  private version = 0
  // 注册之前先到达的终态（idle/error）：注册时消费，避免被 running 覆盖
  private pendingTerminalStatus = new Map<string, 'idle' | 'error'>()

  // ============================================
  // Subscription
  // ============================================

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  private notify() {
    this.version++
    this.subscribers.forEach(fn => fn())
  }

  // ============================================
  // Session Tracking
  // ============================================

  /**
   * 注册一个新的子 session。
   *
   * `status` 只在「重建历史关系」时显式传入：实时事件（session.created）天然是
   * 新会话，可安全默认 running；但刷新后从服务端拉回的子会话可能早已结束，
   * 一律标 running 会让已完成的子代理重新显示为「正在工作」。
   */
  registerChildSession(session: ApiSession, serverId?: string, status?: ChildSessionInfo['status']) {
    if (!session.parentID) return // 不是子 session

    const childKey = makeSessionKey(serverId ?? serverStore.getActiveServerId(), session.id)
    const parentKey = makeSessionKey(serverId ?? serverStore.getActiveServerId(), session.parentID)

    // 添加到 parent -> children 映射
    let children = this.childrenByParent.get(parentKey)
    if (!children) {
      children = new Set()
      this.childrenByParent.set(parentKey, children)
    }
    children.add(childKey)

    // 存储 session 信息。
    // 重复注册（session.created / session.updated）不能把已结束的状态冲回 running：
    // 子代理 idle/error 之后仍会收到 updated（标题更新等），无条件覆盖会让
    // 已完成的子代理永远显示「正在工作」。只有显式的终态（idle/error）才允许
    // 覆盖已有的终态；未显式传 status 时保留现有记录。
    const pending = this.pendingTerminalStatus.get(childKey)
    if (pending) this.pendingTerminalStatus.delete(childKey)

    const existing = this.sessionInfo.get(childKey)
    const resolvedStatus: ChildSessionInfo['status'] =
      status ??
      pending ??
      // 已终态（idle/error）不允许被重复注册冲回 running
      (existing?.status === 'idle' || existing?.status === 'error' ? existing.status : 'running')

    this.sessionInfo.set(childKey, {
      id: childKey,
      parentID: parentKey,
      title: session.title || i18n.t('chat:permissionDialog.subtaskFallback'),
      agent: session.agent,
      status: resolvedStatus,
      createdAt: session.time?.created ?? 0,
    })

    this.notify()
  }

  /**
   * 更新子 session 状态
   */
  updateChildSession(sessionId: string, updates: Partial<Pick<ChildSessionInfo, 'status' | 'title'>>) {
    const info = this.sessionInfo.get(sessionId)
    if (!info) return

    Object.assign(info, updates)
    this.notify()
  }

  /**
   * 标记子 session 为 idle
   */
  markIdle(sessionId: string) {
    this.applyTerminalStatus(sessionId, 'idle')
  }

  /**
   * 标记子 session 为 error
   */
  markError(sessionId: string) {
    this.applyTerminalStatus(sessionId, 'error')
  }

  /**
   * 标记子 session 为 running。
   *
   * 由 session.status(busy/retry) 驱动。只复活「已注册」的子会话：未注册的会话
   * 可能只是父会话本身在跑，凭空建记录会在子代理面板里凭空多出一行。
   *
   * 返回是否接受了 running（true=已置 running；false=被已 error 的终态挡住）。
   * 调用方据此同步 activeSessionStore，避免两处对「error 后迟到 busy」的判断
   * 不一致（D11：子代理面板显示已完成，Working 列表却显示在跑）。
   */
  markRunning(sessionId: string): boolean {
    if (!this.sessionInfo.has(sessionId)) return true
    // 已终态不复活：run 结束后的迟到 busy 事件不应把「已完成」再打回运行态
    const status = this.sessionInfo.get(sessionId)!.status
    if (status === 'error') return false
    this.pendingTerminalStatus.delete(sessionId)
    this.updateChildSession(sessionId, { status: 'running' })
    return true
  }

  /**
   * 落定终态（idle/error）。
   *
   * 子会话可能在注册之前就先收到 session.idle（事件乱序），此时直接写 store 会
   * 因为记录不存在而静默丢弃，随后的 registerChildSession 再把它标成 running，
   * 子代理就永远卡在「正在工作」。因此未注册时先把终态暂存，注册时消费掉。
   */
  private applyTerminalStatus(sessionId: string, status: 'idle' | 'error') {
    if (this.sessionInfo.has(sessionId)) {
      this.updateChildSession(sessionId, { status })
      return
    }
    this.pendingTerminalStatus.set(sessionId, status)
    this.notify()
  }

  // ============================================
  // Getters
  // ============================================

  /**
   * 获取某个 session 的所有子 session IDs
   */
  getChildSessionIds(parentId: string): string[] {
    const children = this.childrenByParent.get(parentId)
    return children ? Array.from(children) : []
  }

  /**
   * 获取某个 session 的所有子 session 信息
   */
  getChildSessions(parentId: string): ChildSessionInfo[] {
    const childIds = this.getChildSessionIds(parentId)
    return childIds.map(id => this.sessionInfo.get(id)).filter((info): info is ChildSessionInfo => !!info)
  }

  /**
   * 获取子 session 信息
   */
  getSessionInfo(sessionId: string): ChildSessionInfo | undefined {
    return this.sessionInfo.get(sessionId)
  }

  getVersion = (): number => this.version

  /**
   * 检查 sessionId 是否是 parentId 的子 session（或子孙 session）。
   * D26：带 visited 保护，避免服务端数据异常形成环时无限递归栈溢出。
   */
  isChildOf(sessionId: string, parentId: string, recursive = true): boolean {
    return this.isChildOfInner(sessionId, parentId, recursive, new Set<string>())
  }

  private isChildOfInner(
    sessionId: string,
    parentId: string,
    recursive: boolean,
    visited: Set<string>,
  ): boolean {
    if (visited.has(sessionId)) return false
    visited.add(sessionId)
    const info = this.sessionInfo.get(sessionId)
    if (!info) return false

    if (info.parentID === parentId) return true

    if (recursive) {
      return this.isChildOfInner(info.parentID, parentId, true, visited)
    }

    return false
  }

  /**
   * 获取 session 及其所有子孙 session 的 ID 列表。
   * D26：带 visited 保护，避免环导致无限递归。
   */
  getSessionAndDescendants(sessionId: string): string[] {
    const result: string[] = []
    const visited = new Set<string>()
    const walk = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      result.push(id)
      for (const childId of this.getChildSessionIds(id)) walk(childId)
    }
    walk(sessionId)
    return result
  }

  /**
   * 检查某个 sessionId 是否属于当前 session 或其子 session
   */
  belongsToSession(sessionId: string, rootSessionId: string): boolean {
    if (sessionId === rootSessionId) return true
    return this.isChildOf(sessionId, rootSessionId, true)
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * 清空所有数据（服务器切换时调用）
   */
  clearAll() {
    this.childrenByParent.clear()
    this.sessionInfo.clear()
    this.pendingTerminalStatus.clear()
    this.notify()
  }

  /**
   * 清理某个父 session 的所有子 session 记录
   */
  clearChildren(parentId: string) {
    const children = this.childrenByParent.get(parentId)
    if (children) {
      for (const childId of children) {
        this.sessionInfo.delete(childId)
        // 递归清理子 session 的子 session
        this.clearChildren(childId)
      }
      this.childrenByParent.delete(parentId)
      this.notify()
    }
  }

  removeSession(sessionId: string) {
    const idsToRemove = this.getSessionAndDescendants(sessionId)
    let changed = false

    for (const id of idsToRemove) {
      this.pendingTerminalStatus.delete(id)
      const info = this.sessionInfo.get(id)
      if (info) {
        const siblings = this.childrenByParent.get(info.parentID)
        if (siblings?.delete(id)) {
          if (siblings.size === 0) this.childrenByParent.delete(info.parentID)
          changed = true
        }
      }

      if (this.childrenByParent.delete(id)) changed = true
      if (this.sessionInfo.delete(id)) changed = true
    }

    if (changed) this.notify()
  }
}

// ============================================
// Singleton Export
// ============================================

export const childSessionStore = new ChildSessionStore()

// ============================================
// Snapshot Cache (避免 useSyncExternalStore 无限循环)
// ============================================

// 缓存：parentId -> ChildSessionInfo[]
const childSessionsCache = new Map<string | null, ChildSessionInfo[]>()
// 缓存：sessionId -> string[] (session family)
const sessionFamilyCache = new Map<string | null, string[]>()

// 订阅 store 变化时清除缓存
childSessionStore.subscribe(() => {
  childSessionsCache.clear()
  sessionFamilyCache.clear()
})

function getChildSessionsSnapshot(parentId: string | null): ChildSessionInfo[] {
  if (!parentId) {
    // 返回稳定的空数组引用
    if (!childSessionsCache.has(null)) {
      childSessionsCache.set(null, [])
    }
    return childSessionsCache.get(null)!
  }

  if (!childSessionsCache.has(parentId)) {
    childSessionsCache.set(parentId, childSessionStore.getChildSessions(parentId))
  }
  return childSessionsCache.get(parentId)!
}

function getSessionFamilySnapshot(sessionId: string | null): string[] {
  if (!sessionId) {
    if (!sessionFamilyCache.has(null)) {
      sessionFamilyCache.set(null, [])
    }
    return sessionFamilyCache.get(null)!
  }

  if (!sessionFamilyCache.has(sessionId)) {
    sessionFamilyCache.set(sessionId, childSessionStore.getSessionAndDescendants(sessionId))
  }
  return sessionFamilyCache.get(sessionId)!
}

// ============================================
// React Hook
// ============================================

import { useCallback, useSyncExternalStore } from 'react'

/**
 * 获取某个 session 的子 session 列表
 */
export function useChildSessions(parentId: string | null): ChildSessionInfo[] {
  return useSyncExternalStore(
    onStoreChange => childSessionStore.subscribe(onStoreChange),
    () => getChildSessionsSnapshot(parentId),
    () => getChildSessionsSnapshot(parentId),
  )
}

/**
 * 获取 session 及其所有子孙的 ID 列表
 */
export function useSessionFamily(sessionId: string | null): string[] {
  return useSyncExternalStore(
    onStoreChange => childSessionStore.subscribe(onStoreChange),
    () => getSessionFamilySnapshot(sessionId),
    () => getSessionFamilySnapshot(sessionId),
  )
}

/**
 * 订阅单个子会话的状态（'running' | 'idle' | 'error'）。
 *
 * 返回状态字符串而非 ChildSessionInfo 对象：info 是就地 mutate 的（Object.assign），
 * 引用恒定，直接返回对象 useSyncExternalStore 会因引用不变而不重渲染。
 * 状态字符串是原始值，能正确触发更新。传入的 id 需为复合 key（含 serverId）。
 */
export function useChildSessionStatus(sessionId: string | null): ChildSessionInfo['status'] | undefined {
  const getSnapshot = useCallback(
    () => (sessionId ? childSessionStore.getSessionInfo(sessionId)?.status : undefined),
    [sessionId],
  )
  return useSyncExternalStore(
    onStoreChange => childSessionStore.subscribe(onStoreChange),
    getSnapshot,
    getSnapshot,
  )
}
