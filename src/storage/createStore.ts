// ============================================
// Persistent Store —— 单一事实来源的持久化状态
// ============================================
//
// 三条约束（对应架构文档「存储收敛」）：
//
//   1. 唯一写入入口 commit()：禁止外部直接 localStorage.setItem。
//      这是消除「同一份数据多个写入者」的前提。
//
//   2. 显式 scope：per-server 数据创建即绑定 serverId，不存在「隐式用当前
//      活动服务器」的路径 —— 那是历史上「读一个桶写另一个桶」的直接来源。
//
//   3. 落盘在 updater 之外：React StrictMode 会重复调用 setState 的 updater，
//      把写入放进 updater 会让时机与次数不可控（曾导致新加的项目被旧快照覆盖）。

import type { z } from 'zod'

export type StoreScope = { kind: 'global' } | { kind: 'server'; serverId: string }

export interface CreateStoreOptions<T> {
  /** 逻辑键；per-server 时实际键为 `srv:{serverId}:{key}` */
  key: string
  scope: StoreScope
  /** 入口校验；不合法时回落到 defaultValue */
  schema: z.ZodType<T>
  defaultValue: T
  /** 写入节流毫秒数（0 = 立即写） */
  writeThrottleMs?: number
}

export interface PersistentStore<T> {
  get(): T
  /** 唯一写入口；mutator 原样返回表示无变化 */
  commit(mutator: (prev: T) => T): void
  /** 外部（同步引擎 / storage 事件）推来的值 */
  applyRemote(next: T): void
  subscribe(listener: () => void): () => void
  getVersion(): number
  getStorageKey(): string
  /** 服务器切换：改绑到新 serverId 并重读（global scope 为空操作） */
  rebind(serverId: string): void
  reset(): void
}

export const storageKeyFor = (scope: StoreScope, key: string) =>
  scope.kind === 'global' ? key : `srv:${scope.serverId}:${key}`

function read<T>(storageKey: string, schema: z.ZodType<T>, fallback: T): T {
  const raw = localStorage.getItem(storageKey)
  if (raw === null) return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 坏数据留档后回落：便于排查，又不阻断应用启动
    localStorage.setItem(`${storageKey}:__invalid__`, raw)
    return fallback
  }
  const result = schema.safeParse(parsed)
  if (result.success) return result.data
  localStorage.setItem(`${storageKey}:__invalid__`, raw)
  return fallback
}

/**
 * 读取任意服务器桶里的值（不改变已创建 store 的绑定）。
 * 用于「设置页展示另一台服务器的当前值」这类只读场景。
 */
export function readStoreFor<T>(
  key: string,
  serverId: string,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  return read(storageKeyFor({ kind: 'server', serverId }, key), schema, fallback)
}

export function createStore<T>({
  key,
  scope,
  schema,
  defaultValue,
  writeThrottleMs = 0,
}: CreateStoreOptions<T>): PersistentStore<T> {
  let currentScope = scope
  let storageKey = storageKeyFor(currentScope, key)
  let snapshot = read(storageKey, schema, defaultValue)
  let version = 0
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false

  const notify = () => {
    version += 1
    listeners.forEach(fn => fn())
  }

  const write = () => {
    dirty = false
    localStorage.setItem(storageKey, JSON.stringify(snapshot))
  }

  const scheduleWrite = () => {
    if (writeThrottleMs <= 0) return write()
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (dirty) write()
    }, writeThrottleMs)
  }

  const store: PersistentStore<T> = {
    get: () => snapshot,
    getVersion: () => version,
    getStorageKey: () => storageKey,

    rebind(serverId) {
      if (currentScope.kind === 'global') return
      if (currentScope.serverId === serverId) return
      currentScope = { kind: 'server', serverId }
      storageKey = storageKeyFor(currentScope, key)
      snapshot = read(storageKey, schema, defaultValue)
      notify()
    },

    commit(mutator) {
      const next = mutator(snapshot)
      if (Object.is(next, snapshot)) return
      const result = schema.safeParse(next)
      if (!result.success) {
        // 内部产出非法值是调用方 bug：保留原值并暴露，不让一次笔误拖垮界面
        console.error(`[store:${key}] commit 产生不合法的值`, result.error)
        return
      }
      snapshot = result.data
      scheduleWrite()
      notify()
    },

    applyRemote(next) {
      const result = schema.safeParse(next)
      if (!result.success) return
      if (JSON.stringify(result.data) === JSON.stringify(snapshot)) return
      snapshot = result.data
      localStorage.setItem(storageKey, JSON.stringify(snapshot))
      notify()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    reset() {
      snapshot = defaultValue
      localStorage.setItem(storageKey, JSON.stringify(snapshot))
      notify()
    },
  }

  // 跨标签页：storage 事件只在「其他标签页写入」时触发，本页收不到自己的写入，
  // 因此直接应用不会形成回环。
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', event => {
      if (event.key !== storageKey || event.newValue === null) return
      try {
        store.applyRemote(JSON.parse(event.newValue) as T)
      } catch {
        /* 非法 JSON 忽略 */
      }
    })
  }

  return store
}
