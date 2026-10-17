// ============================================
// Session API Functions
// 基于 @opencode-ai/sdk: /session 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { getV2Client } from './sdkV2'
import {
  nativeListSessions,
  nativeGetSession,
  nativeCreateSession,
  nativeUpdateSession,
  nativeRemoveSession,
  nativeInterruptSession,
  nativeRevertMessage,
  nativeUnrevertSession,
  nativeForkSession,
  nativeCompactSession,
  nativeListChildSessions,
  nativeActiveSessions,
} from './v2NativeSession'
import { resolveSessionTarget } from '../utils/sessionKey'
import { normalizeTodoItems } from './todo'
import { formatPathForApi, directoryCacheKey } from '../utils/directoryUtils'
import { getSessionMessages } from './message'
import { isEphemeralSession } from '../utils/ephemeralSessions'
import { normalizeFileDiffs } from '../types/api/file'
import { INITIAL_MESSAGE_LIMIT } from '../constants/pagination'
import { serverStore } from '../store/serverStore'
import {
  readSessionListCache,
  writeSessionListCache,
  invalidateSessionListCache,
  dedupeSessionListRequest,
} from './sessionListCache'
import { singleFlight } from '../utils/singleFlight'
import { microCache } from '../utils/microCache'
import { ttlCacheGet, ttlCacheSet, ttlCacheInvalidate } from '../utils/ttlCache'
import { stripSessionListDetails } from './sanitize'
import { collectTurnDiffsFromMessages } from '../features/message/parts/turnDiffs'
import type { ApiSession, SessionListParams, FileDiff, ApiMessageWithParts, ApiUserMessage } from './types'
import type { SessionStatusMap } from '../types/api/session'
import type { TodoItem } from '../types/api/event'

export { invalidateSessionListCache }

function normalizeSessionList(value: unknown): ApiSession[] {
  if (Array.isArray(value)) return value as ApiSession[]
  throw new Error('Invalid OpenCode session list response')
}

// ============================================
// Session Status & Diff
// ============================================

/**
 * 获取所有 session 的当前状态
 *
 * 用 microCache 而非 singleFlight：这类「状态兜底拉取」会在初始化、目录切换、
 * SSE 重连时分几批先后触发（实测打开一个会话被拉 2 次），singleFlight 只能合并
 * 同一批。经隧道时每次约 1.1s，跨批次重复代价很高。
 *
 * TTL 取 1.5s 且不影响实时性：session 状态的权威更新走 SSE，这里只是兜底。
 */
export async function getSessionStatus(directory?: string, serverId?: string): Promise<SessionStatusMap> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return microCache(
    `status:${sid}:${directoryCacheKey(directory)}`,
    async () => {
      if (serverStore.getApiVersion(sid) === 'v2') {
        return nativeActiveSessions(sid) as unknown as SessionStatusMap
      }
      const sdk = getSDKClient(serverId)
      return unwrap(await sdk.session.status({ directory: formatPathForApi(directory, serverId) }))
    },
    { ttlMs: 1500 },
  )
}

/**
 * 获取 session 的 diff
 * 返回可在 UI 中渲染的 SnapshotFileDiff（过滤缺少 file 的异常项）
 *
 * 参数顺序为 (sessionId, directory?, serverId?, messageId?)：serverId 放第 3 位，
 * 与项目内其它 API（getSession/getSessionMessages 等）一致，避免调用方把 serverId
 * 误传到 messageId 槽位（曾导致 session 模式的 diff 恒为空）。
 */
export async function getSessionDiff(
  sessionId: string,
  directory?: string,
  serverId?: string,
  messageId?: string,
): Promise<FileDiff[]> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    const client = getV2Client(target.serverId)
    const res = await client.session.diff({ sessionID: target.sessionId })
    return normalizeFileDiffs(res as unknown as FileDiff[])
  }
  const sdk = getSDKClient(target.serverId)
  return normalizeFileDiffs(
    unwrap(
      await sdk.session.diff({
        sessionID: target.sessionId,
        directory: formatPathForApi(directory, target.serverId),
        messageID: messageId,
      }),
    ),
  )
}

function isUserMessage(message: ApiMessageWithParts): message is ApiMessageWithParts & { info: ApiUserMessage } {
  return message.info.role === 'user'
}

/**
 * 获取当前可见用户消息对应的本轮 diff
 *
 * 对齐 opencode 官方行为：官方 turn 模式的变更列表直接取最近一条 user 消息
 * 的 summary.diffs（见 packages/app/src/pages/session.tsx 的 turnDiffs），
 * 而不是全量拉取消息。这里只取最近一批消息（INITIAL_MESSAGE_LIMIT，分页语义），
 * 避免 limit=undefined 时的全量下载——带 directory 参数时，全量消息响应会包含
 * 整个工作区相关的文件 part，大项目里一次请求可能非常大（issue #157）。
 */
export async function getLastTurnDiff(sessionId: string, directory?: string, serverId?: string): Promise<FileDiff[]> {
  const [session, messages] = await Promise.all([
    getSession(sessionId, directory, serverId),
    // project:false —— 本轮 diff 依赖 summary.diffs，不能用消息流的裁剪投影
    getSessionMessages(sessionId, INITIAL_MESSAGE_LIMIT, directory, serverId, { project: false }),
  ])

  const userMessages = messages.filter(isUserMessage)
  const revertMessageId = session.revert?.messageID
  const visibleUserMessages = revertMessageId
    ? userMessages.filter(message => message.info.id < revertMessageId)
    : userMessages

  const summaryDiffs = normalizeFileDiffs(visibleUserMessages.at(-1)?.info.summary?.diffs)
  if (summaryDiffs.length > 0) return summaryDiffs

  // 回退：服务端未写回 summary.diffs（snapshot 关闭 / 版本差异 / 尚未定稿）时，
  // 从本轮工具调用的 metadata 聚合。tool metadata 与消息流工具卡片同源，
  // 因此「工具卡片能看到改动」的场景这里也一定能看到，不再误报「本轮无变更」。
  const fallbackMessages = revertMessageId
    ? messages.filter(message => message.info.id < revertMessageId)
    : messages
  return collectTurnDiffsFromMessages(fallbackMessages)
}

// ============================================
// Session CRUD
// ============================================

/**
 * 获取 session 列表
 * 默认不返回归档会话（time.archived），避免归档后回显到侧栏/搜索/会话切换。
 * 传 includeArchived 时透传服务端 archived 参数（服务端语义为"也包含归档"），
 * 并在归档视图下按 time.archived 收窄，供「已归档」列表使用。
 *
 * 纯拉取：不碰 sessionListIndexStore。索引的读写由 hook（useSessions 等）
 * 负责，SSE 增量由 useGlobalEvents 负责——职责单一，避免多处双写。
 */
export async function getSessions(
  params: SessionListParams & { includeArchived?: boolean; archivedOnly?: boolean; skipCache?: boolean } = {},
  serverId?: string,
): Promise<ApiSession[]> {
  const sdk = getSDKClient(serverId)
  const { directory, roots, start, search, limit, includeArchived, archivedOnly, skipCache } = params
  // 归一 roots：undefined 保持 undefined（让服务端用默认），否则规约成 boolean。
  // 列表默认只返回 root 会话；只有显式 roots===false（如归档全量）才保留子会话。
  const rootsFlag = roots === undefined ? undefined : roots !== false && roots !== 'false'
  // 服务端的 active 过滤是 time_archived IS NULL，会把恢复后的会话
  // （time.archived === 0，falsy-but-present）排除掉，导致恢复的会话不回显。
  // 因此无论目标列表是活跃还是归档，都向服务端请求归档（archived: true 包含式），
  // 再在客户端按 time.archived 真值分桶（见 openchamber splitGlobalSessionsByArchived）。
  const sdkArchived = true
  const sdkQuery = {
    directory: formatPathForApi(directory, serverId),
    roots,
    start,
    search,
    limit,
    archived: sdkArchived,
  }
  const cacheQuery = { ...sdkQuery, includeArchived, archivedOnly, skipCache }

  const cacheServerId = serverId ?? serverStore.getActiveServerId()
  const cached = readSessionListCache(cacheServerId, cacheQuery)
  // 返回浅拷贝：调用方（如 getArchivedSessions 的 sort）可能就地修改数组，
  // 直接返回缓存引用会把缓存内容改坏。
  // 命中缓存也要再过滤临时会话：AI 重命名期间服务端列表可能带临时会话，
  // 且它写进缓存后才被删除，读侧过滤保证它绝不露面。
  if (cached) return cached.filter(session => !isEphemeralSession(session.id))

  return dedupeSessionListRequest(cacheServerId, cacheQuery, async () => {
    const isV2 = serverStore.getApiVersion(cacheServerId) === 'v2'
    const sessions = isV2
      ? (await nativeListSessions(cacheServerId, {
          directory: formatPathForApi(directory, cacheServerId),
          search,
          limit,
        })).sessions
      : normalizeSessionList(unwrap(await sdk.experimental.session.list(sdkQuery)))
    const filtered = archivedOnly
      ? sessions.filter(session => Boolean(session.time?.archived))
      : includeArchived
        ? sessions
        : sessions.filter(session => !session.time?.archived)
    // 子代理会话（有 parentID）不属于列表：列表按 roots 展示，子会话归 childSessionStore。
    // v2 session.list 不保证按 roots 过滤（且历史响应可能带子会话），这里客户端兜底剔除，
    // 否则子对话会泄漏进侧栏/搜索列表。显式 roots===false 时（归档全量）保留。
    const rootsFiltered = rootsFlag === false ? filtered : filtered.filter(session => !session.parentID)
    // 内部临时会话（如 AI 重命名用的临时会话）不进入任何用户可见列表。
    // 列表读侧与 SSE 增量读侧共用同一登记，见 utils/ephemeralSessions。
    const visible = rootsFiltered.filter(session => !isEphemeralSession(session.id))
    // 列表渲染不需要 summary.diffs / revert 快照 / permission 详情，
    // 这些字段单条可达数百 KB，且会被缓存 30s，去掉后缓存占用同步下降。
    const result = visible.map(stripSessionListDetails)

    writeSessionListCache(cacheServerId, cacheQuery, result)
    return result.slice()
  })
}

/**
 * 获取已归档的 session 列表（按归档时间倒序）
 */
export async function getArchivedSessions(params: SessionListParams = {}, serverId?: string): Promise<ApiSession[]> {
  const sessions = await getSessions({ ...params, archivedOnly: true }, serverId)
  return [...sessions].sort((a, b) => (b.time?.archived ?? 0) - (a.time?.archived ?? 0))
}

/**
 * 恢复已归档的 session（把 time.archived 清为 0）
 */
export async function restoreSession(sessionId: string, directory?: string, serverId?: string): Promise<ApiSession> {
  return updateSession(sessionId, { time: { archived: 0 } }, directory, serverId)
}

/**
 * 获取单个 session
 *
 * 会话元数据变动不频繁，加一层短 TTL 缓存：首屏时 loadSession、SidePanel
 * 元数据补齐、getLastTurnDiff 会先后各取一次同一会话，singleFlight 只能合并
 * 同时在途的请求，串行调用仍会各发一次。TTL 内命中缓存直接返回，避免串行重复
 * 拉取；create/update/delete/revert 等写操作后按前缀失效，保证不长期陈旧。
 */
const SESSION_META_TTL_MS = 15_000
const SESSION_META_CACHE_PREFIX = 'session-meta:'

function sessionMetaCacheKey(serverId: string, sessionId: string, directory?: string): string {
  return `${SESSION_META_CACHE_PREFIX}${serverId}:${sessionId}:${directoryCacheKey(directory)}`
}

/** 写操作后失效某会话的元数据缓存（含各目录键，简单起见按 server:session 前缀） */
function invalidateSessionMetaCache(serverId: string, sessionId: string): void {
  ttlCacheInvalidate(`${SESSION_META_CACHE_PREFIX}${serverId}:${sessionId}:`)
}

export async function getSession(sessionId: string, directory?: string, serverId?: string): Promise<ApiSession> {
  const target = resolveSessionTarget(sessionId, serverId)
  const cacheKey = sessionMetaCacheKey(target.serverId, target.sessionId, directory)
  const cached = ttlCacheGet<ApiSession>(cacheKey, SESSION_META_TTL_MS)
  if (cached) return cached

  // 首屏时 loadSession、SidePanel、元数据补齐会各取一次同一会话，
  // 合并同 key 在途请求。key 用与传输格式无关的目录键，
  // 避免 pathMode 在 auto 检测期间切换导致 key 失配。
  const session = await singleFlight(
    `session:${target.serverId}:${target.sessionId}:${directoryCacheKey(directory)}`,
    async () => {
      const isV2 = serverStore.getApiVersion(target.serverId) === 'v2'
      if (isV2) return nativeGetSession(target.serverId, target.sessionId)
      const sdk = getSDKClient(target.serverId)
      return unwrap(
        await sdk.session.get({ sessionID: target.sessionId, directory: formatPathForApi(directory, target.serverId) }),
      )
    },
  )
  ttlCacheSet(cacheKey, session, SESSION_META_TTL_MS)
  return session
}

/**
 * 创建 session
 */
export async function createSession(
  params: {
    directory?: string
    title?: string
    parentID?: string
  } = {},
  serverId?: string,
): Promise<ApiSession> {
  const sdk = getSDKClient(serverId)
  const { directory, title, parentID } = params
  const sid = serverId ?? serverStore.getActiveServerId()
  const isV2 = serverStore.getApiVersion(sid) === 'v2'
  const session = isV2
    ? await nativeCreateSession(sid, { directory, title, parentID })
    : unwrap(
        await sdk.session.create({
          directory: formatPathForApi(directory, serverId),
          title,
          parentID,
        }),
      )
  // 无显式 serverId 时按活动服务器失效，避免误伤其它服务器的列表缓存
  invalidateSessionListCache(serverId ?? serverStore.getActiveServerId())
  return session
}

/**
 * 更新 session
 */
export async function updateSession(
  sessionId: string,
  params: { title?: string; time?: { archived?: number } },
  directory?: string,
  serverId?: string,
): Promise<ApiSession> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    const session = await nativeUpdateSession(target.serverId, {
      sessionID: target.sessionId,
      title: params.title,
      archived: params.time?.archived,
    })
    invalidateSessionMetaCache(target.serverId, target.sessionId)
    invalidateSessionListCache(target.serverId)
    return session
  }
  const sdk = getSDKClient(target.serverId)
  const session = unwrap(
    await sdk.session.update({
      sessionID: target.sessionId,
      directory: formatPathForApi(directory, target.serverId),
      ...params,
    }),
  )
  invalidateSessionMetaCache(target.serverId, target.sessionId)
  invalidateSessionListCache(target.serverId)
  return session
}

/**
 * 删除 session
 */
export async function deleteSession(sessionId: string, directory?: string, serverId?: string): Promise<boolean> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    const ok = await nativeRemoveSession(target.serverId, target.sessionId)
    invalidateSessionMetaCache(target.serverId, target.sessionId)
    invalidateSessionListCache(target.serverId)
    return ok
  }
  const sdk = getSDKClient(target.serverId)
  unwrap(
    await sdk.session.delete({ sessionID: target.sessionId, directory: formatPathForApi(directory, target.serverId) }),
  )
  invalidateSessionMetaCache(target.serverId, target.sessionId)
  invalidateSessionListCache(target.serverId)
  return true
}

// ============================================
// Session Actions
// ============================================

/**
 * 中止 session
 */
export async function abortSession(sessionId: string, directory?: string, serverId?: string): Promise<boolean> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    return nativeInterruptSession(target.serverId, target.sessionId)
  }
  const sdk = getSDKClient(target.serverId)
  unwrap(
    await sdk.session.abort({ sessionID: target.sessionId, directory: formatPathForApi(directory, target.serverId) }),
  )
  return true
}

/**
 * 回退消息
 */
export async function revertMessage(
  sessionId: string,
  messageId: string,
  partId?: string,
  directory?: string,
  serverId?: string,
): Promise<ApiSession> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    const session = await nativeRevertMessage(target.serverId, { sessionID: target.sessionId, messageID: messageId })
    invalidateSessionMetaCache(target.serverId, target.sessionId)
    return session
  }
  const sdk = getSDKClient(target.serverId)
  const session = unwrap(
    await sdk.session.revert({
      sessionID: target.sessionId,
      directory: formatPathForApi(directory, target.serverId),
      messageID: messageId,
      partID: partId,
    }),
  )
  invalidateSessionMetaCache(target.serverId, target.sessionId)
  return session
}

/**
 * 恢复已回退的消息
 */
export async function unrevertSession(sessionId: string, directory?: string, serverId?: string): Promise<ApiSession> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    const session = await nativeUnrevertSession(target.serverId, target.sessionId)
    invalidateSessionMetaCache(target.serverId, target.sessionId)
    return session
  }
  const sdk = getSDKClient(target.serverId)
  const session = unwrap(
    await sdk.session.unrevert({
      sessionID: target.sessionId,
      directory: formatPathForApi(directory, target.serverId),
    }),
  )
  invalidateSessionMetaCache(target.serverId, target.sessionId)
  return session
}

/**
 * 分享 session
 */
export async function shareSession(sessionId: string, directory?: string, serverId?: string): Promise<ApiSession> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    // v2 无 share 能力，返回当前会话（安全 no-op）
    return nativeGetSession(target.serverId, target.sessionId)
  }
  const sdk = getSDKClient(target.serverId)
  return unwrap(
    await sdk.session.share({ sessionID: target.sessionId, directory: formatPathForApi(directory, target.serverId) }),
  )
}

/**
 * 取消分享 session
 */
export async function unshareSession(sessionId: string, directory?: string, serverId?: string): Promise<ApiSession> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    // v2 无 share 能力，返回当前会话（安全 no-op）
    return nativeGetSession(target.serverId, target.sessionId)
  }
  const sdk = getSDKClient(target.serverId)
  return unwrap(
    await sdk.session.unshare({ sessionID: target.sessionId, directory: formatPathForApi(directory, target.serverId) }),
  )
}

/**
 * Fork session
 */
export async function forkSession(
  sessionId: string,
  messageId?: string,
  directory?: string,
  serverId?: string,
): Promise<ApiSession> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    return nativeForkSession(target.serverId, { sessionID: target.sessionId, messageID: messageId })
  }
  const sdk = getSDKClient(target.serverId)
  return unwrap(
    await sdk.session.fork({
      sessionID: target.sessionId,
      directory: formatPathForApi(directory, target.serverId),
      messageID: messageId,
    }),
  )
}

/**
 * 总结 session
 */
export async function summarizeSession(
  sessionId: string,
  params: { providerID: string; modelID: string; auto?: boolean },
  directory?: string,
  serverId?: string,
): Promise<boolean> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    return nativeCompactSession(target.serverId, target.sessionId)
  }
  const sdk = getSDKClient(target.serverId)
  unwrap(
    await sdk.session.summarize({
      sessionID: target.sessionId,
      directory: formatPathForApi(directory, target.serverId),
      ...params,
    }),
  )
  return true
}

/**
 * 获取子 session
 */
export async function getSessionChildren(
  sessionId: string,
  directory?: string,
  serverId?: string,
): Promise<ApiSession[]> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    return nativeListChildSessions(target.serverId, target.sessionId)
  }
  const sdk = getSDKClient(target.serverId)
  return unwrap(
    await sdk.session.children({
      sessionID: target.sessionId,
      directory: formatPathForApi(directory, target.serverId),
    }),
  )
}

/**
 * Session Todo
 */
export type ApiTodo = TodoItem

/**
 * 获取 session 的 todo 列表
 * SDK 的 Todo 没有 id 字段，用 index+content+status 合成
 */
export async function getSessionTodos(sessionId: string, directory?: string, serverId?: string): Promise<ApiTodo[]> {
  const target = resolveSessionTarget(sessionId, serverId)
  if (serverStore.getApiVersion(target.serverId) === 'v2') {
    // v2 无 session.todo 主动拉取端点，todo 由 SSE 事件（session.todo）驱动，返回空
    return []
  }
  const sdk = getSDKClient(target.serverId)
  const todos = unwrap(
    await sdk.session.todo({ sessionID: target.sessionId, directory: formatPathForApi(directory, target.serverId) }),
  )
  return normalizeTodoItems(todos)
}
