// ============================================
// Location 管理 - 已加载目录（opencode 的 Location 图）的查看与回收
// ============================================
//
// 背景：opencode v2 把 `Mcp` 放在 **Location 图**里（见 upstream
// `packages/core/src/instance.ts` 的 `nodes`），因此**每个目录各有一份独立的
// MCP 进程**。stdio 类 MCP（uvx / npx / python）每次都要真起一个子进程，
// 于是「打开过 N 个项目 = N 份 MCP」。
//
// 实测（本机 2026-10-22）：
//   14 个 location → 14 个 metis MCP → 28 个 python 进程 → 约 2.18 GB 内存。
//   逐个 evict 非当前目录后：location 14→1，metis 14→1，python 28→2。
//
// 上游状态（已调研，不能依赖）：
//   - #37844 `core: cached locations multiply MCP subprocesses`（open，已指派）；
//   - #43845 `v2 service spawns one local MCP server pair per cataloged project
//     directory at startup`（open，2.0 标签）；
//   - #46210 曾提交「按配置 hash 共享 MCP 进程 + 引用计数」的修复，**已 Closed
//     未合并**（因 PR 模板不合规被机器人自动关闭）。
//
// 所以 OCC 侧提供手动回收：调用上游自带的调试端点
//   GET    /api/debug/location            列出已加载 location
//   DELETE /api/debug/location?location[directory]=<path>
//
// ⚠️ 参数是 **deepObject**（`location[directory]`），不是 `directory`。
// 传错参数时服务端仍回 204，但什么都不会发生 —— 这是个静默失败，实测踩过。
//
// ⚠️ 单个 location 只 evict 一次往往不够：有活跃会话（borrower）占着时，
// 服务端会拒绝真正关闭，需要「多轮 evict + 间隔」才能清干净。实测第二轮
// 才把残留的 8 个清到 1 个。
// ============================================

import { buildHeaders } from './sdk'
import { serverStore } from '../store/serverStore'
import { logger } from '../utils/logger'

/** 已加载的 location（一个目录一份服务图） */
export interface LoadedLocation {
  directory: string
  workspaceID?: string
}

/** 单个请求的超时：这是运维操作，卡住就放弃 */
const LOCATION_TIMEOUT_MS = 20_000
/** 多轮回收的轮数上限 */
const MAX_EVICT_ROUNDS = 8
/**
 * 轮与轮之间的等待。
 *
 * 服务端关闭一个 location 的 scope 要**依次**结束它的 borrower、取消在途操作、
 * 关闭 scope、再杀掉 MCP 子进程组。实测 2.5s 往往还没结束，下一轮 list 会看到
 * 「仍在」，于是误判为清不掉；5s 后基本都已收敛（10 → 1）。
 *
 * 用轮询而非固定长等待：短间隔先试几次，绝大多数情况第一轮就够了，
 * 避免让用户白等 5 秒。
 */
const EVICT_POLL_INTERVAL_MS = 700
/** 每轮 evict 之后，最多等这么久让服务端收敛 */
const EVICT_SETTLE_TIMEOUT_MS = 8_000

function baseUrlOf(serverId: string): string {
  return serverStore.getServerBaseUrl(serverId).replace(/\/$/, '')
}

async function request(serverId: string, path: string, init?: RequestInit): Promise<Response> {
  const { getUnifiedFetch } = await import('../store/serverStore')
  const fetchImpl = await getUnifiedFetch()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(new Error('location request timed out')), LOCATION_TIMEOUT_MS)
  try {
    return await fetchImpl(`${baseUrlOf(serverId)}${path}`, {
      ...init,
      headers: { ...buildHeaders(serverId), Accept: 'application/json', ...(init?.headers ?? {}) },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

/** 列出服务端当前加载的全部 location。 */
export async function listLoadedLocations(serverId?: string): Promise<LoadedLocation[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  const res = await request(sid, '/api/debug/location')
  if (!res.ok) {
    // 老版本没有这个调试端点：当作「不支持」而不是错误，调用方据此隐藏入口。
    if (res.status === 404) return []
    throw new Error(`list locations failed: HTTP ${res.status}`)
  }
  const body: unknown = await res.json()
  const items = Array.isArray(body) ? body : []
  return items
    .map(item => {
      const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const directory = typeof record.directory === 'string' ? record.directory : undefined
      if (!directory) return null
      const workspaceID = typeof record.workspaceID === 'string' ? record.workspaceID : undefined
      return { directory, ...(workspaceID ? { workspaceID } : {}) }
    })
    .filter((entry): entry is LoadedLocation => entry != null)
}

/** 回收单个 location（释放其服务图，连带杀掉它拥有的 MCP 子进程）。 */
export async function evictLocation(directory: string, serverId?: string): Promise<boolean> {
  const sid = serverId ?? serverStore.getActiveServerId()
  // 参数必须是 deepObject 形式，见文件头说明。
  const query = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`
  const res = await request(sid, `/api/debug/location?${query}`, { method: 'DELETE' })
  return res.ok
}

/** 目录比较：大小写与正/反斜杠都不敏感（Windows 上同一个目录有多种写法）。 */
export function sameDirectory(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}

export interface ReclaimResult {
  /** 回收前已加载的 location 数 */
  before: number
  /** 回收后仍加载的 location 数 */
  after: number
  /** 实际发出 evict 的目录 */
  evicted: string[]
  /** 回收后仍然加载、但非当前目录的（被会话占用，服务端拒绝关闭） */
  stuck: string[]
  /** 保留（当前正在用的）目录 */
  kept: string[]
  /** 是否达到稳定（不再有可回收的） */
  settled: boolean
}

/**
 * 回收所有「非当前目录」的 location。
 *
 * 需要多轮：某个 location 若有活跃会话占着，服务端会跳过真正关闭；
 * 下一轮再试通常就能清掉。实测残留 8 个时，第二轮即清到 1 个。
 *
 * @param keepDirectory 当前正在使用的目录，永不回收
 */
export async function reclaimIdleLocations(
  keepDirectory: string | undefined,
  serverId?: string,
  options?: {
    signal?: AbortSignal
    /** 每轮 evict 后的收敛超时（测试可传 0 加速） */
    settleTimeoutMs?: number
    pollIntervalMs?: number
    maxRounds?: number
  },
): Promise<ReclaimResult> {
  const sid = serverId ?? serverStore.getActiveServerId()
  const maxRounds = options?.maxRounds ?? MAX_EVICT_ROUNDS
  const settleTimeoutMs = options?.settleTimeoutMs ?? EVICT_SETTLE_TIMEOUT_MS
  const pollIntervalMs = options?.pollIntervalMs ?? EVICT_POLL_INTERVAL_MS
  const initial = await listLoadedLocations(sid)
  const before = initial.length
  const evicted = new Set<string>()
  const kept = new Set<string>()
  let current = initial
  let settled = false

  /** 等待服务端收敛：轮询直到「无可回收目标」或超时。 */
  const waitForSettle = async (): Promise<Array<{ directory: string; workspaceID?: string }>> => {
    const deadline = Date.now() + settleTimeoutMs
    let snapshot = await listLoadedLocations(sid)
    while (Date.now() < deadline) {
      const remaining = snapshot.filter(location =>
        keepDirectory ? !sameDirectory(location.directory, keepDirectory) : true,
      )
      if (remaining.length === 0) return snapshot
      if (options?.signal?.aborted) return snapshot
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
      snapshot = await listLoadedLocations(sid)
    }
    return snapshot
  }

  for (let round = 0; round < maxRounds; round++) {
    if (options?.signal?.aborted) break

    const targets = current.filter(location => {
      if (!keepDirectory) return true
      return !sameDirectory(location.directory, keepDirectory)
    })
    if (targets.length === 0) {
      settled = true
      break
    }

    for (const location of targets) {
      if (options?.signal?.aborted) break
      try {
        if (await evictLocation(location.directory, sid)) evicted.add(location.directory)
      } catch (error) {
        logger.warn('[location] evict failed', { directory: location.directory, error })
      }
    }

    current = await waitForSettle()
  }

  for (const location of current) {
    if (keepDirectory && sameDirectory(location.directory, keepDirectory)) kept.add(location.directory)
  }

  const stuck = current
    .filter(location => !keepDirectory || !sameDirectory(location.directory, keepDirectory))
    .map(location => location.directory)

  return {
    before,
    after: current.length,
    evicted: Array.from(evicted),
    stuck,
    kept: Array.from(kept),
    settled: settled || stuck.length === 0,
  }
}
