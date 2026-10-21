// ============================================
// PinnedMessagesStore — 消息级固定
// ============================================
//
// 与 pinnedSessionsStore（置顶会话）区分：这里固定的是单条消息。
// 数据按「服务器 + 会话」隔离，持久化到 per-server localStorage。
//
// 只存展示与定位所需的快照字段，不依赖 messageStore 是否还持有该消息
// （会话被卸载、历史被裁剪后固定项仍要能渲染）。

import { useSyncExternalStore } from 'react'
import { serverStorage } from '../utils/perServerStorage'
import { serverStore } from './serverStore'

export interface PinnedMessageEntry {
  sessionId: string
  messageId: string
  role: 'user' | 'assistant'
  /** 展示用摘要（已截断） */
  excerpt: string
  createdAt: number
}

const STORAGE_KEY = 'opencode-pinned-messages'

interface PersistedShape {
  version: 1
  bySession: Record<string, PinnedMessageEntry[]>
}

function sanitizeEntry(raw: unknown): PinnedMessageEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<PinnedMessageEntry>
  if (typeof item.sessionId !== 'string' || !item.sessionId) return null
  if (typeof item.messageId !== 'string' || !item.messageId) return null
  if (item.role !== 'user' && item.role !== 'assistant') return null
  return {
    sessionId: item.sessionId,
    messageId: item.messageId,
    role: item.role,
    excerpt: typeof item.excerpt === 'string' ? item.excerpt : '',
    createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
  }
}

function sanitize(raw: unknown): PersistedShape {
  const empty: PersistedShape = { version: 1, bySession: {} }
  if (!raw || typeof raw !== 'object') return empty
  const data = raw as Partial<PersistedShape>
  if (data.version !== 1 || !data.bySession || typeof data.bySession !== 'object') return empty

  const bySession: Record<string, PinnedMessageEntry[]> = {}
  for (const [sessionId, list] of Object.entries(data.bySession)) {
    if (!sessionId || !Array.isArray(list)) continue
    const entries: PinnedMessageEntry[] = []
    const seen = new Set<string>()
    for (const item of list) {
      const entry = sanitizeEntry(item)
      if (!entry || seen.has(entry.messageId)) continue
      seen.add(entry.messageId)
      entries.push(entry)
    }
    if (entries.length > 0) bySession[sessionId] = entries
  }
  return { version: 1, bySession }
}

class PinnedMessagesStore {
  private bySession: Record<string, PinnedMessageEntry[]> = {}
  private listeners = new Set<() => void>()
  private snapshotCache = new Map<string, PinnedMessageEntry[]>()
  private readonly emptySnapshot: PinnedMessageEntry[] = []

  constructor() {
    this.reload()
    serverStore.onServerChange(() => {
      this.reload()
      this.emit()
    })
  }

  private reload() {
    this.bySession = sanitize(serverStorage.getJSON<unknown>(STORAGE_KEY, serverStore.getActiveServerId())).bySession
    this.snapshotCache.clear()
  }

  private persist() {
    serverStorage.setJSON(STORAGE_KEY, { version: 1, bySession: this.bySession } satisfies PersistedShape, serverStore.getActiveServerId())
  }

  private invalidate(sessionId: string) {
    this.snapshotCache.delete(sessionId)
  }

  isPinned(sessionId: string, messageId: string): boolean {
    return (this.bySession[sessionId] ?? []).some(entry => entry.messageId === messageId)
  }

  getPinned(sessionId: string): PinnedMessageEntry[] {
    const cached = this.snapshotCache.get(sessionId)
    if (cached) return cached
    const value = this.bySession[sessionId] ?? this.emptySnapshot
    this.snapshotCache.set(sessionId, value)
    return value
  }

  pin(entry: PinnedMessageEntry) {
    const list = this.bySession[entry.sessionId] ?? []
    const existingIndex = list.findIndex(item => item.messageId === entry.messageId)
    if (existingIndex !== -1) {
      const existing = list[existingIndex]
      if (existing.excerpt === entry.excerpt && existing.role === entry.role) return
      const next = [...list]
      next[existingIndex] = entry
      this.bySession = { ...this.bySession, [entry.sessionId]: next }
    } else {
      this.bySession = { ...this.bySession, [entry.sessionId]: [...list, entry] }
    }
    this.invalidate(entry.sessionId)
    this.persist()
    this.emit()
  }

  unpin(sessionId: string, messageId: string) {
    const list = this.bySession[sessionId]
    if (!list) return
    const next = list.filter(entry => entry.messageId !== messageId)
    if (next.length === list.length) return
    const bySession = { ...this.bySession }
    if (next.length === 0) delete bySession[sessionId]
    else bySession[sessionId] = next
    this.bySession = bySession
    this.invalidate(sessionId)
    this.persist()
    this.emit()
  }

  toggle(entry: PinnedMessageEntry): boolean {
    if (this.isPinned(entry.sessionId, entry.messageId)) {
      this.unpin(entry.sessionId, entry.messageId)
      return false
    }
    this.pin(entry)
    return true
  }

  clearSession(sessionId: string) {
    if (!this.bySession[sessionId]) return
    const bySession = { ...this.bySession }
    delete bySession[sessionId]
    this.bySession = bySession
    this.invalidate(sessionId)
    this.persist()
    this.emit()
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * 清空全部内存态与订阅者（不改动 storage）。
   * 供测试隔离使用；生产代码不应调用。
   */
  reset() {
    this.bySession = {}
    this.snapshotCache.clear()
    this.listeners.clear()
  }

  private emit() {
    this.listeners.forEach(fn => fn())
  }
}

export const pinnedMessagesStore = new PinnedMessagesStore()

export const PINNED_MESSAGE_EXCERPT_MAX = 120

export function buildPinnedMessageExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= PINNED_MESSAGE_EXCERPT_MAX) return normalized
  return `${normalized.slice(0, PINNED_MESSAGE_EXCERPT_MAX)}\u2026`
}

const EMPTY_PINNED: PinnedMessageEntry[] = []

export function usePinnedMessages(sessionId: string | null | undefined): PinnedMessageEntry[] {
  return useSyncExternalStore(
    pinnedMessagesStore.subscribe,
    () => (sessionId ? pinnedMessagesStore.getPinned(sessionId) : EMPTY_PINNED),
    () => EMPTY_PINNED,
  )
}

/** 单条消息是否已固定。用于消息流的固定按钮。 */
export function usePinnedMessage(sessionId: string | null | undefined, messageId: string): boolean {
  return useSyncExternalStore(
    pinnedMessagesStore.subscribe,
    () => (sessionId ? pinnedMessagesStore.isPinned(sessionId, messageId) : false),
    () => false,
  )
}
