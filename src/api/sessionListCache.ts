// ============================================
// sessionListCache - 会话列表短 TTL 缓存
//
// 切服务器/切目录时列表会被清空重拉，网络往返造成「先空白再出现」的体感。
// 这里按 serverId + 查询参数缓存列表结果：命中则跳过网络请求，
// 让切回已访问过的服务器/目录即时出内容。
//
// 失效策略：
// - 会话增删改归档等本地写操作完成后按 serverId 前缀失效
// - 其它客户端产生的变更不在失效范围内，由 TTL（30s）兜底
// ============================================

import type { ApiSession, SessionListParams } from './types'
import { ttlCacheGet, ttlCacheSet, ttlCacheInvalidate } from '../utils/ttlCache'
import { directoryCacheKey } from '../utils/directoryUtils'

/** 列表缓存 TTL：够短以避免明显陈旧，够长以覆盖来回切换 */
const SESSION_LIST_TTL_MS = 30_000
const SESSION_LIST_CACHE_PREFIX = 'session-list:'

/**
 * 失效代次:防「在途请求回写旧列表」。
 *
 * 列表请求发出后、返回前若发生删除/归档等失效,该请求的 factory 仍会带着
 * **失效前**的列表回来调用 `writeSessionListCache`;若照写,已删除的会话会在
 * 缓存里复活最长 30s。调用方在请求发起前取一次 `sessionListCacheToken`,
 * 写入时回传;期间失效过则 token 不匹配,直接拒绝回写。
 */
let invalidateEpoch = 0
const serverInvalidateEpoch = new Map<string, number>()

/** 请求发起前取该 server 的缓存代次;写入时回传以判断期间是否失效过。 */
export function sessionListCacheToken(serverId: string): string {
  return `${invalidateEpoch}:${serverInvalidateEpoch.get(serverId) ?? 0}`
}

type SessionListQuery = SessionListParams & {
  includeArchived?: boolean
  archivedOnly?: boolean
  /** 显式刷新时跳过读缓存（仍写入，供后续复用） */
  skipCache?: boolean
}

export function sessionListCacheKey(serverId: string, query: SessionListQuery): string {
  const archived = query.archivedOnly ? 'archived' : query.includeArchived ? 'all' : 'active'
  // 用与传输格式无关的目录键：pathMode 在 auto 检测期间可能切换，
  // 直接拼原始目录会让同一目录算出两个 key，缓存与在途合并同时失效。
  return [
    SESSION_LIST_CACHE_PREFIX,
    serverId,
    archived,
    directoryCacheKey(query.directory),
    query.roots === undefined ? '' : String(query.roots),
    query.search ?? '',
    query.limit ?? '',
    query.start ?? '',
  ].join('|')
}

/** 搜索结果是瞬态的高基数查询，不缓存，避免污染与内存膨胀 */
function isCacheable(query: SessionListQuery): boolean {
  return !query.search
}

export function readSessionListCache(serverId: string, query: SessionListQuery): ApiSession[] | undefined {
  if (query.skipCache || !isCacheable(query)) return undefined
  return ttlCacheGet<ApiSession[]>(sessionListCacheKey(serverId, query), SESSION_LIST_TTL_MS)
}

export function writeSessionListCache(
  serverId: string,
  query: SessionListQuery,
  sessions: ApiSession[],
  token?: string,
): void {
  if (!isCacheable(query)) return
  // 失效发生在请求在途时,拒绝回写:否则会把失效前的旧列表重新塞回缓存
  if (token !== undefined && token !== sessionListCacheToken(serverId)) return
  ttlCacheSet(sessionListCacheKey(serverId, query), sessions, SESSION_LIST_TTL_MS)
}

// ============================================
// 在途请求合并（single-flight）
// ============================================
//
// 侧栏每个项目各挂一个 useSessions，挂载时同时发起请求。这些请求都在同一帧
// 内未命中缓存，于是同一个 directory 会被并发拉取多次（实测 5 个目录发出 13 次
// 请求，其中一个目录重复 4 次）。后端本就繁忙时，这些重复请求会互相排队，
// 直接把会话列表的可见时间拖到十几秒。
//
// 同一个 key 的并发请求共享同一个 Promise，只发一次网络。

const inflightSessionLists = new Map<string, Promise<ApiSession[]>>()

/** 复用同 key 的在途请求；没有则调用 factory 并登记，完成后无论成败都移除 */
export function dedupeSessionListRequest(
  serverId: string,
  query: SessionListQuery,
  factory: () => Promise<ApiSession[]>,
): Promise<ApiSession[]> {
  const key = sessionListCacheKey(serverId, query)
  const inflight = inflightSessionLists.get(key)
  if (inflight) return inflight

  const request = factory().finally(() => {
    inflightSessionLists.delete(key)
  })
  inflightSessionLists.set(key, request)
  return request
}

/**
 * 按服务器失效列表缓存（缺省失效全部）。
 * session-list:${serverId}|... 的 key 结构保证前缀能精确匹配单台服务器。
 */
export function invalidateSessionListCache(serverId?: string): void {
  if (serverId) {
    serverInvalidateEpoch.set(serverId, (serverInvalidateEpoch.get(serverId) ?? 0) + 1)
    ttlCacheInvalidate(`${SESSION_LIST_CACHE_PREFIX}${serverId}|`)
    return
  }
  invalidateEpoch += 1
  ttlCacheInvalidate(SESSION_LIST_CACHE_PREFIX)
}
