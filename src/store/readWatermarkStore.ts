// ============================================
// ReadWatermarkStore — 会话「已读水位」跨端同步
// ============================================
//
// 背景：通知历史（opencode:notifications）按设计不做跨端同步（含逐条 read 标志，
// 整键 LWW 会让已读被另一端的旧未读覆盖）。但「未读」必须跨端一致：一端标记
// 已读后，另一端不得再显示未读。
//
// 方案：单独维护一份「每会话已读水位」——记录每个会话被读到的校准时间戳。
// 未读判定改为 `notification.timestamp > watermark[bareSessionId]`。
// 水位用 max 合并（单调递增、永不回退），因此不会重演「已读又变未读」。
//
// 存储：裸键 `opencode-read-watermarks`，值为 { [裸sessionId]: 校准时间戳 }。
// 用裸键（不带 serverId 前缀）是因为同一后端可能被以多个前缀连接
// （local 与 aiagent:inst_x 指向同一实例），按前缀分会造成水位分叉。
// 该键落在 preferencesSync 的 opencode- 白名单前缀下，自动参与跨端同步；
// MERGE_RULES 已登记 map-number（逐键取最大）。
//
// 时间戳基准：统一用校准钟（serverStore.getActiveCalibratedNow），不可用时
// 退回本地钟。通知生成时间也必须用同一基准（见 notificationStore.push），
// 否则两侧数值不同基准、比较无意义。

import { useSyncExternalStore } from 'react'
import { sessionKeyToSessionId } from '../utils/sessionKey'
import { serverStore } from './serverStore'
import { notifyPerServerStorageChanged } from '../utils/perServerStorage'

const STORAGE_KEY = 'opencode-read-watermarks'

type Watermarks = Record<string, number>

function load(): Watermarks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Watermarks = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

/**
 * 当前基准时间：优先校准钟，不可用退回本地钟。
 * 与 notificationStore.push 使用同一函数，保证比较口径一致。
 *
 * 指定 serverId 时用**该会话所属主机**的校准钟，而不是当前活动主机：
 * 同一会话的通知在两端必须能比较，而不同主机的时钟并不相同。用活动主机的钟
 * 给别的主机的通知打戳，跨主机切换后时间戳就会错位（表现为未读点了清不掉、
 * 或已读了又变未读）。
 */
export function watermarkNow(serverId?: string): number {
  const scoped = serverId ? serverStore.getCalibratedNow(serverId) : undefined
  return scoped ?? serverStore.getActiveCalibratedNow() ?? Date.now()
}

type Subscriber = () => void

class ReadWatermarkStore {
  private watermarks: Watermarks = load()
  private subscribers = new Set<Subscriber>()
  private version = 0

  constructor() {
    if (typeof window !== 'undefined') {
      // 跨标签页：同源另一个标签写入 localStorage 时同步
      window.addEventListener('storage', event => {
        if (event.key === STORAGE_KEY) this.reload()
      })
    }
  }

  subscribe = (cb: Subscriber): (() => void) => {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  getSnapshot = (): number => this.version

  /** 从 localStorage 重新读取（外部写入后调用，如偏好同步 pull） */
  reload() {
    const next = load()
    if (sameWatermarks(this.watermarks, next)) return
    this.watermarks = next
    this.version += 1
    this.subscribers.forEach(cb => cb())
  }

  private commit(next: Watermarks) {
    this.watermarks = next
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // quota exceeded
    }
    // 触发偏好同步上传：本键走 preferencesSync 的裸键通道，写入即入队
    notifyPerServerStorageChanged()
    this.version += 1
    this.subscribers.forEach(cb => cb())
  }

  /** 某会话的已读水位（裸 id）。无记录返回 0。 */
  get(bareSessionId: string): number {
    return this.watermarks[bareSessionId] ?? 0
  }

  /** 会话是否已读：通知时间戳不高于水位即视为已读 */
  isRead(bareSessionId: string, timestamp: number): boolean {
    return timestamp <= this.get(bareSessionId)
  }

  /**
   * 抬高某会话的已读水位到 at（缺省用当前基准时间）。
   * 只增不减：低于当前水位时不写，避免时钟回拨或乱序写入把水位拉低。
   */
  raise(sessionId: string, at: number = watermarkNow()): void {
    const bareId = sessionKeyToSessionId(sessionId)
    if (!bareId) return
    if (at <= (this.watermarks[bareId] ?? 0)) return
    this.commit({ ...this.watermarks, [bareId]: at })
  }

  /**
   * 批量抬高多个会话的水位（用于「按项目清理未读」）。
   * 每个会话都取自身当前水位与新值的较大者。
   */
  raiseMany(sessionIds: string[], at: number = watermarkNow()): void {
    let changed = false
    const next = { ...this.watermarks }
    for (const sessionId of sessionIds) {
      const bareId = sessionKeyToSessionId(sessionId)
      if (!bareId) continue
      if (at > (next[bareId] ?? 0)) {
        next[bareId] = at
        changed = true
      }
    }
    if (!changed) return
    this.commit(next)
  }
}

function sameWatermarks(a: Watermarks, b: Watermarks): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export const readWatermarkStore = new ReadWatermarkStore()

/** 订阅水位版本号；版本变化即重新求值 */
export function useReadWatermarkVersion(): number {
  return useSyncExternalStore(readWatermarkStore.subscribe, readWatermarkStore.getSnapshot)
}
