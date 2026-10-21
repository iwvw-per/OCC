// ============================================
// PinnedSessionsStore — 置顶对话状态管理
// ============================================
//
// 按服务器隔离的置顶会话列表（跨工作区持久化）。
// 存储 { sessionId, directory, title } 以便未加载 session 详情时也能渲染。
//
// 持久化统一走 createStore：单写入口 + schema 校验 + 服务器切换自动 rebind。

import { z } from 'zod'
import { createStore } from '../storage/createStore'
import { serverStore } from './serverStore'

export interface PinnedSessionEntry {
  sessionId: string
  directory: string
  title: string
}

// 新：srv:{serverId}:opencode-pinned-sessions
// 旧：localStorage 全局 opencode-pinned-sessions（一次性迁到当前 active server）
const STORAGE_KEY = 'opencode-pinned-sessions'

const schema: z.ZodType<PinnedSessionEntry[]> = z.array(z.unknown()).transform(items =>
  items.flatMap(item => {
    const entry = item as Partial<PinnedSessionEntry> | null
    if (!entry || typeof entry.sessionId !== 'string') return []
    if (typeof entry.directory !== 'string' || typeof entry.title !== 'string') return []
    return [{ sessionId: entry.sessionId, directory: entry.directory, title: entry.title }]
  }),
)

/** 旧全局列表迁移到当前服务器桶（只在目标桶为空时执行一次） */
function migrateLegacyBucket(): void {
  try {
    const legacyRaw = localStorage.getItem(STORAGE_KEY)
    if (!legacyRaw) return
    const target = `srv:${serverStore.getActiveServerId()}:${STORAGE_KEY}`
    if (localStorage.getItem(target) === null) {
      localStorage.setItem(target, JSON.stringify(schema.parse(JSON.parse(legacyRaw))))
    }
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 迁移失败不影响后续使用 */
  }
}

migrateLegacyBucket()

const store = createStore({
  key: STORAGE_KEY,
  scope: { kind: 'server', serverId: serverStore.getActiveServerId() },
  schema,
  defaultValue: [],
})

class PinnedSessionsStore {
  private listeners = new Set<() => void>()

  constructor() {
    store.subscribe(() => this.emit())
    serverStore.onServerChange(() => store.rebind(serverStore.getActiveServerId()))
  }

  private emit() {
    this.listeners.forEach(fn => fn())
  }

  private entries(): PinnedSessionEntry[] {
    return store.get()
  }

  isPinned(sessionId: string): boolean {
    return this.entries().some(e => e.sessionId === sessionId)
  }

  pin(entry: PinnedSessionEntry) {
    store.commit(list => {
      const index = list.findIndex(e => e.sessionId === entry.sessionId)
      if (index === -1) return [...list, entry]
      const existing = list[index]
      if (existing.directory === entry.directory && existing.title === entry.title) return list
      return [...list.slice(0, index), entry, ...list.slice(index + 1)]
    })
  }

  update(sessionId: string, patch: Partial<Omit<PinnedSessionEntry, 'sessionId'>>) {
    store.commit(list => {
      const index = list.findIndex(e => e.sessionId === sessionId)
      if (index === -1) return list
      const next = { ...list[index], ...patch }
      const current = list[index]
      if (next.directory === current.directory && next.title === current.title) return list
      return [...list.slice(0, index), next, ...list.slice(index + 1)]
    })
  }

  unpin(sessionId: string) {
    store.commit(list => {
      const index = list.findIndex(e => e.sessionId === sessionId)
      if (index === -1) return list
      return [...list.slice(0, index), ...list.slice(index + 1)]
    })
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = (): PinnedSessionEntry[] => store.get()
}

export const pinnedSessionsStore = new PinnedSessionsStore()
