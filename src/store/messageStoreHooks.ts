// ============================================
// MessageStore React Hooks
// ============================================
//
// React 绑定层：snapshot 缓存 + useSyncExternalStore hooks
// 与 messageStore.ts 的纯 store 逻辑分离
//
// 所有便捷 hook 都接受可选的 sessionId：
//   - 传入具体 sessionId（含 null）→ 只订阅该 session，分屏安全
//   - 省略（undefined）→ 回退到全局聚焦 pane 的 session，保持向后兼容

import { useSyncExternalStore, useRef, useCallback } from 'react'
import { messageStore } from './messageStore'
import { paneLayoutStore } from './paneLayoutStore'
import type { MessageStoreSnapshot, SessionStateSnapshot } from './messageStoreTypes'

// ============================================
// Snapshot Cache (避免 useSyncExternalStore 无限循环)
// ============================================

/** 每个 session 一份 snapshot，附带生成时的 store 版本，用于判定是否需重建 */
interface CachedSnapshot {
  version: number
  snapshot: MessageStoreSnapshot
}

const snapshotCache = new Map<string, CachedSnapshot>()
const NULL_SESSION_KEY = '\u0000null'

/**
 * snapshot 缓存上限。messageStore 自身有 MAX_CACHED_SESSIONS 的淘汰，但这里
 * 的缓存按 sessionId 独立存放，若不设限会随浏览过的会话数持续增长（每份都持有
 * messages 数组）。超出后按插入顺序淘汰最旧的，Map 的插入序天然支持这一点。
 */
const MAX_SNAPSHOT_CACHE = 20

function cacheSnapshot(key: string, entry: CachedSnapshot): void {
  // 先删再设，使该项移到插入序末尾（LRU 语义）
  snapshotCache.delete(key)
  snapshotCache.set(key, entry)
  while (snapshotCache.size > MAX_SNAPSHOT_CACHE) {
    const oldest = snapshotCache.keys().next().value
    if (oldest === undefined) break
    snapshotCache.delete(oldest)
  }
}

/** 任一会话/布局变化都递增；按版本号判定各 session 缓存是否过期 */
let storeVersion = 0

messageStore.subscribe(() => {
  storeVersion += 1
})

paneLayoutStore.subscribe(() => {
  storeVersion += 1
})

function sessionCacheKey(sessionId: string | null): string {
  return sessionId ?? NULL_SESSION_KEY
}

function createSnapshot(sessionId: string | null): MessageStoreSnapshot {
  return {
    sessionId,
    messages: messageStore.getVisibleMessages(sessionId),
    isStreaming: messageStore.getIsStreaming(sessionId),
    revertState: messageStore.getRevertState(sessionId),
    hasMoreHistory: messageStore.getHasMoreHistory(sessionId),
    hasTrimmedHistory: messageStore.getTrimmedCount(sessionId) > 0,
    sessionDirectory: messageStore.getSessionDirectory(sessionId),
    sessionTitle: messageStore.getSessionTitle(sessionId),
    shareUrl: messageStore.getShareUrl(sessionId),
    canUndo: messageStore.canUndo(sessionId),
    canRedo: messageStore.canRedo(sessionId),
    redoSteps: messageStore.getRedoSteps(sessionId),
    revertedContent: messageStore.getCurrentRevertedContent(sessionId),
    loadState: messageStore.getLoadState(sessionId),
    loadError: messageStore.getSessionState(sessionId ?? '')?.loadError,
    loadedFromSkeleton: messageStore.getSessionState(sessionId ?? '')?.loadedFromSkeleton === true,
  }
}

function isSameSnapshot(a: MessageStoreSnapshot, b: MessageStoreSnapshot): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.messages === b.messages &&
    a.isStreaming === b.isStreaming &&
    a.revertState === b.revertState &&
    a.hasMoreHistory === b.hasMoreHistory &&
    a.hasTrimmedHistory === b.hasTrimmedHistory &&
    a.sessionDirectory === b.sessionDirectory &&
    a.sessionTitle === b.sessionTitle &&
    a.shareUrl === b.shareUrl &&
    a.canUndo === b.canUndo &&
    a.canRedo === b.canRedo &&
    a.redoSteps === b.redoSteps &&
    a.revertedContent === b.revertedContent &&
    a.loadState === b.loadState &&
    a.loadError === b.loadError &&
    a.loadedFromSkeleton === b.loadedFromSkeleton
  )
}

function getSnapshotFor(sessionId: string | null): MessageStoreSnapshot {
  const key = sessionCacheKey(sessionId)
  const cached = snapshotCache.get(key)
  if (cached && cached.version === storeVersion) return cached.snapshot

  const next = createSnapshot(sessionId)
  // 内容与上一版完全一致时复用旧引用，避免旁路组件空刷
  const snapshot = cached && isSameSnapshot(cached.snapshot, next) ? cached.snapshot : next
  cacheSnapshot(key, { version: storeVersion, snapshot })
  return snapshot
}

function getFocusedSessionId(): string | null {
  return paneLayoutStore.getFocusedSessionId()
}

/**
 * 解析目标 session：
 * - undefined → 跟随全局聚焦 pane（需要订阅 paneLayoutStore）
 * - string / null → 固定订阅该 session
 */
function resolveSessionId(sessionId: string | null | undefined): string | null {
  return sessionId === undefined ? getFocusedSessionId() : sessionId
}

function subscribeFocused(onStoreChange: () => void): () => void {
  const unsubscribeMessageStore = messageStore.subscribe(onStoreChange)
  const unsubscribePaneLayout = paneLayoutStore.subscribe(onStoreChange)
  return () => {
    unsubscribeMessageStore()
    unsubscribePaneLayout()
  }
}

// ============================================
// React Hooks
// ============================================

/**
 * 订阅某个 session 的完整 snapshot。
 *
 * @param sessionId 显式 session；省略时跟随全局聚焦 pane。
 */
export function useMessageStore(sessionId?: string | null): MessageStoreSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (sessionId === undefined) return subscribeFocused(onStoreChange)
      if (sessionId === null) return () => undefined
      return messageStore.subscribeSession(sessionId, onStoreChange)
    },
    [sessionId],
  )

  const getSnapshot = useCallback(() => getSnapshotFor(resolveSessionId(sessionId)), [sessionId])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 选择器模式 - 只订阅需要的字段，减少不必要的重渲染
 *
 * @example
 * // 只订阅 sessionId 和 isStreaming
 * const { sessionId, isStreaming } = useMessageStoreSelector(
 *   state => ({ sessionId: state.sessionId, isStreaming: state.isStreaming })
 * )
 */
export function useMessageStoreSelector<T>(
  selector: (state: MessageStoreSnapshot) => T,
  equalityFn: (a: T, b: T) => boolean = shallowEqual,
  sessionId?: string | null,
): T {
  const prevResultRef = useRef<T | undefined>(undefined)

  const getSelectedSnapshot = useCallback(() => {
    const fullSnapshot = getSnapshotFor(resolveSessionId(sessionId))
    const newResult = selector(fullSnapshot)

    // 如果结果相等，返回之前的引用以避免重渲染
    if (prevResultRef.current !== undefined && equalityFn(prevResultRef.current, newResult)) {
      return prevResultRef.current
    }

    prevResultRef.current = newResult
    return newResult
  }, [selector, equalityFn, sessionId])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (sessionId === undefined) return subscribeFocused(onStoreChange)
      if (sessionId === null) return () => undefined
      return messageStore.subscribeSession(sessionId, onStoreChange)
    },
    [sessionId],
  )

  return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot)
}

/**
 * 浅比较两个对象
 */
function shallowEqual<T>(a: T, b: T): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (a === null || b === null) return false

  const keysA = Object.keys(a as object)
  const keysB = Object.keys(b as object)

  if (keysA.length !== keysB.length) return false

  const recordA = a as Record<string, unknown>
  const recordB = b as Record<string, unknown>

  for (const key of keysA) {
    if (recordA[key] !== recordB[key]) return false
  }

  return true
}

// 模块级 selector：避免组件内联 () => ({...}) 导致 getSnapshot 身份每帧变化
const selectSessionId = (state: MessageStoreSnapshot) => state.sessionId
const selectMessages = (state: MessageStoreSnapshot) => state.messages
const selectHasMessages = (state: MessageStoreSnapshot) => state.messages.length > 0
const selectHeaderSessionMeta = (state: MessageStoreSnapshot) => ({
  sessionId: state.sessionId,
  sessionDirectory: state.sessionDirectory,
  sessionTitle: state.sessionTitle,
})
const selectShareSessionMeta = (state: MessageStoreSnapshot) => ({
  sessionId: state.sessionId,
  shareUrl: state.shareUrl,
  sessionDirectory: state.sessionDirectory,
})
const sameMessageArray = (a: Message[], b: Message[]) => a === b

// 缓存：sessionId -> SessionStateSnapshot（附带生成时的该 session 版本）
//
// 用 per-session 版本判定新鲜度：后台会话流式只会让它自己的版本前进，
// 当前会话的快照不会被连累重建（旧实现对全局 subscribe 做 clear 会清掉所有）。
interface CachedSessionSnapshot {
  version: number
  snapshot: SessionStateSnapshot
}
const sessionSnapshots = new Map<string, CachedSessionSnapshot>()

/** 快照缓存上限：无订阅者的条目不会自动删除，靠 LRU 兜底防止无界增长 */
const MAX_SESSION_SNAPSHOTS = 20

function cacheSessionSnapshot(sessionId: string, entry: CachedSessionSnapshot): void {
  sessionSnapshots.delete(sessionId)
  sessionSnapshots.set(sessionId, entry)
  while (sessionSnapshots.size > MAX_SESSION_SNAPSHOTS) {
    const oldest = sessionSnapshots.keys().next().value
    if (oldest === undefined) break
    sessionSnapshots.delete(oldest)
  }
}

/**
 * React hook to subscribe to a SPECIFIC session state
 */
export function useSessionState(sessionId: string | null): SessionStateSnapshot | null {
  const getSessionSnapshot = (): SessionStateSnapshot | null => {
    if (!sessionId) return null

    const version = messageStore.getSessionChangeVersion(sessionId)
    const cached = sessionSnapshots.get(sessionId)
    // 版本一致说明该 session 未变化，直接复用（其它 session 变化不影响这里）
    if (cached && cached.version === version) return cached.snapshot

    const state = messageStore.getSessionState(sessionId)
    if (!state) return null
    const visibleMessages = messageStore.getVisibleMessages(sessionId)

    // 构建 snapshot 并缓存
    const snapshot: SessionStateSnapshot = {
      messages: visibleMessages,
      isStreaming: state.isStreaming,
      loadState: state.loadState,
      loadError: state.loadError,
      revertState: state.revertState,
      canUndo: messageStore.canUndo(sessionId),
      canRedo: !state.isStreaming && (state.revertState?.history.length ?? 0) > 0,
      redoSteps: state.revertState?.history.length ?? 0,
      revertedContent: state.revertState?.history?.[0] ?? null,
      hasMoreHistory: state.hasMoreHistory,
      hasTrimmedHistory: (state.trimmedCount ?? 0) > 0,
      loadedFromSkeleton: state.loadedFromSkeleton === true,
      directory: state.directory,
      title: state.title ?? null,
      compactedAt: state.compactedAt,
      model: state.model,
      agent: state.agent,
      lastTurn: state.lastTurn,
    }

    cacheSessionSnapshot(sessionId, { version, snapshot })
    return snapshot
  }

  const subscribeSession = useCallback(
    (onStoreChange: () => void) => {
      if (!sessionId) return () => undefined
      return messageStore.subscribeSession(sessionId, () => {
        sessionSnapshots.delete(sessionId)
        onStoreChange()
      })
    },
    [sessionId],
  )

  return useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot)
}

// ============================================
// 便捷选择器 Hooks
// ============================================

/** 全局聚焦 pane 的 sessionId（不接受覆盖，语义即「当前聚焦」） */
export function useCurrentSessionId(): string | null {
  return useMessageStoreSelector(selectSessionId)
}

/** 只订阅 messages；传 sessionId 时只读该 session，分屏安全 */
export function useMessages(sessionId?: string | null): Message[] {
  return useMessageStoreSelector(selectMessages, sameMessageArray, sessionId)
}

/** 指定 session 是否已有消息（length 级，流式加字不触发） */
export function useHasMessages(sessionId?: string | null): boolean {
  return useMessageStoreSelector(selectHasMessages, undefined, sessionId)
}

/** Header 用：session 身份与标题，不跟 messages 文本 */
export function useHeaderSessionMeta(sessionId?: string | null) {
  return useMessageStoreSelector(selectHeaderSessionMeta, undefined, sessionId)
}

/** Share 用：分享链接相关字段 */
export function useShareSessionMeta(sessionId?: string | null) {
  return useMessageStoreSelector(selectShareSessionMeta, undefined, sessionId)
}

// Re-export types for convenience
import type { Message } from '../types/message'
export type { MessageStoreSnapshot, SessionStateSnapshot }
