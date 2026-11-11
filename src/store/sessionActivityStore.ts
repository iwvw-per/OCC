// ============================================
// sessionActivityStore - 会话/目录「最后活动时间」锚点
// ============================================
//
// 侧栏会话列表固定「最新对话置顶」，依据不是会话的 time.updated。
// assistant 流式输出会持续刷新 time.updated，多个会话并行运行时各自的时间戳
// 交替变化，按它排序会让列表来回跳。
//
// 这里维护一层单调锚点：
//   - 会话锚点：用户最后一条消息的发送时间（打开会话、SSE、乐观发送时写入）。
//   - 目录锚点：该目录下会话锚点的最大值，供项目排序与项目行「最后对话时间」。
//
// 写入单调只增：迟到的旧时间戳事件不会把顺序降回去，因此天然抗并发抖动。
// 冷启动（内存无锚点）时由列表加载侧用会话的 time.updated 播种一次基线，
// 之后不再随流式变化，只在用户发送或显式刷新时抬高。
//
// 会话锚点用「原始 sessionId」作 key：同一后端可能被多个 serverId 前缀连接
// （local 与隧道指向同一实例），原始 id 才唯一。
//
// ============================================
// 目录「最后活动时间」的跨端同步
// ============================================
//
// 锚点原本只存内存，导致新设备冷启动没有锚点，项目顺序只能退回服务端
// time.updated 兜底 —— 而 time.updated 会被 assistant 流式输出持续抬高，
// 多项目并行时来回超越，这是项目排序抖动的根因。
//
// 这里把目录锚点同步出去：裸键 opencode-project-last-used =
// { 归一化目录路径: 时间戳 }，走 preferencesSync 的 map-number 规则（逐键取
// max，单调、收敛、不回退）。时间戳取自用户消息的 time.created，是服务端
// 生成的绝对时间，各端读到同一后端就是同一个值，无需设备身份、不依赖本地钟。
//
// 这样新设备登录后，一次 pull 就能拿到全部项目的最新活动时间，侧栏首屏即
// 与其它端一致，不必点进会话，也不必等流式把 time.updated 抬上来。

import { normalizeToForwardSlash, normalizeForComparison } from '../utils/directoryUtils'
import { notifyPerServerStorageChanged } from '../utils/perServerStorage'
import type { ApiSession } from '../api'

const SEPARATOR = '\x00'

/** 裸键：目录 → 最后用户活动时间（跨端同步，map-number 取 max）。 */
const PROJECT_LAST_USED_KEY = 'opencode-project-last-used'

type ProjectLastUsed = Record<string, number>

function loadProjectLastUsed(): ProjectLastUsed {
  try {
    const raw = localStorage.getItem(PROJECT_LAST_USED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: ProjectLastUsed = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

export interface ActivityChange {
  sessionId?: string
  /** 本次变化影响的目录（已归一化），无则 undefined */
  directory?: string
  serverId?: string
}

/**
 * D29：目录 key 用 normalizeForComparison（小写）而非 normalizeToForwardSlash。
 * 项目 worktree 是用户保存的路径，服务端 session.directory 是后端返回的路径，
 * 二者大小写可能不同（Windows）。若读写用不同归一化，getDirectoryAnchor 会失配，
 * 项目行时间回退到服务端值、排序与列表依据不一致。
 */
function directoryKey(serverId: string, directory: string): string {
  return `${serverId}${SEPARATOR}${normalizeForComparison(directory)}`
}

class SessionActivityStore {
  private sessionAnchors = new Map<string, number>()
  private directoryAnchors = new Map<string, number>()
  /**
   * 跨端同步的目录「最后活动时间」水位（归一化目录路径 → 时间戳）。
   *
   * 与 directoryAnchors 的区别：directoryAnchors 按 serverId 分桶（本机多服务器
   * 互不干扰），水位是账号级、按裸目录路径存，供跨端 map-number 合并。读取时
   * 两者取 max，因此同一后端无论以 local 还是 aiagent:inst_x 前缀连接都能对齐。
   */
  private projectLastUsed: ProjectLastUsed = loadProjectLastUsed()
  private subscribers = new Set<(change: ActivityChange) => void>()
  /** 内容版本：每次实际变化递增，供 useSyncExternalStore 判断快照是否变化 */
  private version = 0

  subscribe = (fn: (change: ActivityChange) => void): (() => void) => {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  getVersion = (): number => this.version

  private emit(change: ActivityChange) {
    this.version += 1
    for (const fn of this.subscribers) fn(change)
  }

  /**
   * 记一次会话活动时间（单调）。只有比已记录值更新才写入并通知，
   * 因此迟到/重复事件不会造成无谓重排，也不会把顺序降回去。
   */
  recordActivity(sessionId: string, timestamp: number | undefined, directory?: string, serverId?: string): void {
    if (!timestamp || !sessionId) return

    let changed = false
    if (timestamp > (this.sessionAnchors.get(sessionId) ?? 0)) {
      this.sessionAnchors.set(sessionId, timestamp)
      changed = true
    }

    const normalized = directory ? normalizeToForwardSlash(directory) : ''
    if (normalized) {
      if (serverId) {
        const dirKey = directoryKey(serverId, normalized)
        if (timestamp > (this.directoryAnchors.get(dirKey) ?? 0)) {
          this.directoryAnchors.set(dirKey, timestamp)
          changed = true
        }
      }
      // 跨端水位：不分 serverId，按裸目录路径取 max 并持久化。key 用
      // normalizeForComparison（小写）与 directoryKey 同口径 —— 用户保存的
      // worktree 路径与服务端 session.directory 大小写可能不同（Windows），
      // 读写若用不同归一化会失配（D29）。
      const watermarkKey = normalizeForComparison(normalized)
      if (timestamp > (this.projectLastUsed[watermarkKey] ?? 0)) {
        this.projectLastUsed = { ...this.projectLastUsed, [watermarkKey]: timestamp }
        this.persistProjectLastUsed()
        changed = true
      }
    }

    if (changed) this.emit({ sessionId, directory: normalized || undefined, serverId })
  }

  private persistProjectLastUsed(): void {
    try {
      localStorage.setItem(PROJECT_LAST_USED_KEY, JSON.stringify(this.projectLastUsed))
      // 偏好同步引擎订阅 per-server 存储版本；水位是裸键、不走 serverStorage.set，
      // 必须显式通知，否则本地改动只能等 15s 轮询才上传（与已读水位同款处理）。
      notifyPerServerStorageChanged()
    } catch {
      // ignore quota errors
    }
  }

  /** 从 localStorage 重新读取（偏好同步 pull 到别的端的改动后调用）。 */
  reload(): void {
    const next = loadProjectLastUsed()
    if (sameProjectLastUsed(this.projectLastUsed, next)) return
    const merged: ProjectLastUsed = { ...next }
    // 取 max 合并：本地内存里可能已有更高值（尚未上传），不能被外部较低值压低。
    for (const [path, at] of Object.entries(this.projectLastUsed)) {
      if (at > (merged[path] ?? 0)) merged[path] = at
    }
    this.projectLastUsed = merged
    this.emit({})
  }

  /** 取会话锚点；未记录过返回 undefined，由调用方回退到 session.time */
  getSessionAnchor(sessionId: string): number | undefined {
    return this.sessionAnchors.get(sessionId)
  }

  /**
   * 取目录锚点（最后对话时间）；未记录过返回 undefined。
   * 本机分桶锚点与跨端水位取 max —— 水位是从用户消息 time.created 来的权威值，
   * 冷启动（本机无锚点）时直接用它恢复顺序，不必等流式抬高 time.updated。
   */
  getDirectoryAnchor(serverId: string, directory: string): number | undefined {
    if (!directory) return undefined
    const local = this.directoryAnchors.get(directoryKey(serverId, directory))
    const synced = this.projectLastUsed[normalizeForComparison(directory)]
    if (local === undefined) return synced
    if (synced === undefined) return local
    return Math.max(local, synced)
  }

  /** 目录的跨端水位原始值（单测/调试用） */
  getProjectLastUsed(directory: string): number | undefined {
    return this.projectLastUsed[normalizeForComparison(directory)]
  }

  removeSession(sessionId: string): void {
    if (this.sessionAnchors.delete(sessionId)) this.emit({ sessionId })
  }

  /** 单测用：清空全部 */
  reset(): void {
    this.sessionAnchors.clear()
    this.directoryAnchors.clear()
    this.projectLastUsed = {}
  }
}

function sameProjectLastUsed(a: ProjectLastUsed, b: ProjectLastUsed): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export const sessionActivityStore = new SessionActivityStore()

/**
 * 会话锚定时间：优先用锚点，未记录时回退到会话自身的 updated（再退 created）。
 * 时间缺失按 0 处理，避免 NaN 打乱顺序。
 */
/**
 * 会话排序锚点时间。
 *
 * 优先级：用户消息锚点（本地实时，最贴近「最后一次对话」）→ 服务端 `time.idle`
 * → `time.updated` → `time.created`。
 *
 * ## 为什么优先 `time.idle` 而不是 `time.updated`（2026-11-11）
 *
 * `time.updated` 会被 assistant 的每一次流式输出持续抬高，是一个**随时在变**
 * 的时钟。多端各自在不同时刻拉到它，同一个会话在两端就会得到不同数值 ——
 * 表现为「同一批会话在桌面端和网页端排序不一致」。实测（本机 4096，20 条会话）：
 * 按 `updated` 与按 `idle` 排出来的前 4 条顺序完全不同。
 *
 * `time.idle` 是「这一轮真正结束」的权威时间戳，一轮之内不再变化，因此两端
 * 读到的是同一个值，排序天然一致。这也符合用户要求：多端顺序完全一致才能
 * 无缝衔接。
 *
 * `updated` 仍保留作为兜底：会话可能还没跑完过一轮（`idle` 缺失），此时
 * 退回 `updated` 至少能给一个合理位置。
 */
export function getSessionAnchorTime(session: ApiSession): number {
  const anchor = sessionActivityStore.getSessionAnchor(session.id)
  if (anchor !== undefined) return anchor
  const time = session.time
  return time?.idle ?? time?.updated ?? time?.created ?? 0
}

/**
 * 按锚定时间倒序（最新对话置顶，返回新数组，不改原数组）。
 * 时间相同时按 id 升序兜底，保证结果稳定、与输入顺序无关。
 */
export function sortSessionsByAnchor<T extends ApiSession>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const delta = getSessionAnchorTime(b) - getSessionAnchorTime(a)
    if (delta !== 0) return delta
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * 把一个新出现的会话插到锚点倒序列表的正确位置（返回新数组）。
 * 保持「最新对话置顶」的语义，而不是无脑置于末尾。
 */
export function insertSessionByAnchor<T extends ApiSession>(sessions: T[], session: T): T[] {
  if (sessions.length === 0) return [session]
  const target = getSessionAnchorTime(session)
  let index = sessions.length
  for (let i = 0; i < sessions.length; i += 1) {
    if (getSessionAnchorTime(sessions[i]) < target) {
      index = i
      break
    }
  }
  const next = sessions.slice()
  next.splice(index, 0, session)
  return next
}
