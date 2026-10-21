import { useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import {
  getSessions,
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  subscribeToEvents,
  type ApiSession,
  type SessionListParams,
} from '../api'
import { todoStore } from '../store/todoStore'
import { serverStore } from '../store/serverStore'
import { pinnedSessionsStore } from '../store/pinnedSessionsStore'
import {
  sessionListIndexStore,
  type SessionListBucketKey,
} from '../store/sessionListIndexStore'
import { useDirectory } from './useDirectory'
import { sessionErrorHandler, normalizeToForwardSlash, autoDetectPathStyle, isSameDirectory } from '../utils'
import { makeSessionKey } from '../utils/sessionKey'
import { sortSessionsByAnchor } from '../store/sessionActivityStore'
import { clearSessionRuntimeState } from '../utils/sessionLifecycle'
import { isEphemeralSession } from '../utils/ephemeralSessions'
import { SessionContext, type SessionContextValue } from './SessionContext.shared'

const DEFAULT_LIMIT = 30
/** 索引 TTL：超过此时长再次挂载会触发一次后台静默刷新 */
const SESSION_LIST_TTL_MS = 30_000
const EMPTY_SESSIONS: ApiSession[] = []

export function SessionProvider({ children }: { children: ReactNode }) {
  const { currentDirectory } = useDirectory()

  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  // 搜索态结果保存在组件内（瞬态高基数查询不入索引）
  const [searchSessions, setSearchSessions] = useState<ApiSession[]>(EMPTY_SESSIONS)

  const activeServerId = useSyncExternalStore(
    cb => serverStore.subscribe(cb),
    () => serverStore.getActiveServerId(),
    () => serverStore.getActiveServerId(),
  )

  const requestIdRef = useRef(0)
  const searchTimerRef = useRef<number | null>(null)
  const currentDirectoryRef = useRef(currentDirectory)
  const searchRef = useRef(search)
  const isLoadingMoreRef = useRef(false) // 防止并发 loadMore
  const isFetchingRef = useRef(false) // 防止 onReconnected 密集触发时重复请求
  const queuedReconnectRefreshRef = useRef(false)
  const retryTimerRef = useRef<number | null>(null)
  const fetchSessionsRef = useRef<
    (
      params?: SessionListParams & { append?: boolean; retryAttempt?: number; skipCache?: boolean; silent?: boolean },
    ) => Promise<void>
  >(() => Promise.resolve())
  const currentLimitRef = useRef(DEFAULT_LIMIT) // 当前 limit，loadMore 时递增

  // 保持 ref 同步
  useEffect(() => {
    currentDirectoryRef.current = currentDirectory
  }, [currentDirectory])

  useEffect(() => {
    searchRef.current = search
  }, [search])

  const targetDir = normalizeToForwardSlash(currentDirectory) || undefined
  const searching = search !== ''
  const indexable = !searching

  const bucket: SessionListBucketKey = {
    serverId: activeServerId,
    directory: targetDir,
    view: 'active',
    // 上下条导航按 30 条分页，与侧栏项目列表（5 条）分开存
    scope: 'navigation',
  }
  const bucketIdKey = `${activeServerId}\u0000${targetDir ?? ''}`

  // 索引快照（同步、引用稳定）：切回旧主机/旧目录首帧即有内容
  const indexSessions = useSyncExternalStore(
    cb => sessionListIndexStore.subscribe(cb),
    () => (indexable ? sessionListIndexStore.getSnapshot(bucket) : EMPTY_SESSIONS),
    () => (indexable ? sessionListIndexStore.getSnapshot(bucket) : EMPTY_SESSIONS),
  )
  const loadedLimit = indexable ? sessionListIndexStore.getLoadedLimit(bucket) : 0

  // 核心获取逻辑
  // 注意：directory 传给 getSessions 时使用正斜杠格式
  // http 层的 fetchWithBothSlashesAndMerge 会处理两种斜杠格式的兼容
  const fetchSessions = useCallback(
    async (
      params: SessionListParams & { append?: boolean; retryAttempt?: number; skipCache?: boolean; silent?: boolean } = {},
    ) => {
      const { append = false, retryAttempt = 0, silent = false, ...queryParams } = params
      const requestId = ++requestIdRef.current
      isFetchingRef.current = true

      const isSearch = Boolean(queryParams.search ?? searchRef.current)
      const hasIndexContent = sessionListIndexStore.has(bucket)

      // silent（后台静默刷新）：不动 loading 态、不清已有内容，拿到新数据后原地替换。
      // 回前台/重连时用，避免列表先空白再出现。
      if (append) {
        setIsLoadingMore(true)
      } else if (!silent && (isSearch || !hasIndexContent)) {
        setIsLoading(true)
      }

      try {
        // 多取一条用于判断是否还有更多：仅凭 data.length >= limit 无法区分
        // 「刚好这么多」和「还有更多」——会话数正好等于 pageSize 时会多出一个
        // 点了没反应的「展开更多会话」按钮（取回同样条数后 hasMore 立刻变 false）。
        const requestedLimit = currentLimitRef.current
        // D2：记录请求发出前的成员版本，回包时校验；期间 SSE 增删过则丢弃这份响应。
        const expectedMembership = sessionListIndexStore.getMembershipRevision(bucket)
        const data = await getSessions({
          roots: true,
          limit: requestedLimit + 1,
          directory: targetDir,
          search: search || undefined,
          ...queryParams,
        })

        if (requestId !== requestIdRef.current) return

        // 自动检测路径风格（从后端返回的 directory 字段）
        if (data.length > 0 && data[0].directory) {
          autoDetectPathStyle(data[0].directory)
        }

        if (isSearch) {
          setSearchSessions(sortSessionsByAnchor(data.slice(0, requestedLimit)))
        } else {
          // 索引存全量页数据（含多取的那条），读取侧按 loadedLimit 切片
          sessionListIndexStore.replace(bucket, data, {
            limit: requestedLimit,
            hasMore: data.length > requestedLimit,
            expectedMembershipRevision: expectedMembership,
          })
        }
      } catch (e) {
        if (requestId === requestIdRef.current && !append) {
          if (retryAttempt < 3) {
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
            retryTimerRef.current = window.setTimeout(() => {
              if (requestId !== requestIdRef.current) return
              void fetchSessions({ ...queryParams, silent, retryAttempt: retryAttempt + 1 })
            }, [500, 1500, 3000][retryAttempt])
          } else if (isSearch) {
            setSearchSessions(EMPTY_SESSIONS)
          } else if (!silent) {
            sessionListIndexStore.replace(bucket, [], { limit: 0, hasMore: false })
          }
        }
        sessionErrorHandler('fetch sessions', e)
      } finally {
        if (requestId === requestIdRef.current) {
          isFetchingRef.current = false
          setIsLoading(false)
          setIsLoadingMore(false)
          if (queuedReconnectRefreshRef.current) {
            queuedReconnectRefreshRef.current = false
            // 静默补拉：不清空列表，旧内容留在屏上直到新数据到达
            void fetchSessionsRef.current({ search: searchRef.current || undefined, skipCache: true, silent: true })
          }
        }
      }
    },
    // bucket 每帧新建，用它做依赖会无限重跑；用稳定 id 字符串代替
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetDir, search, bucketIdKey],
  )

  // 保持 ref 同步（用于 SSE onReconnected / 目录变化的补拉）
  fetchSessionsRef.current = fetchSessions

  const matchesCurrentDirectory = useCallback((session: ApiSession) => {
    const target = currentDirectoryRef.current
    return !target || isSameDirectory(target, session.directory)
  }, [])

  // 监听 directory 和 search 变化
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)

    // 切换目录或搜索时重置 limit
    currentLimitRef.current = DEFAULT_LIMIT

    const run = () => {
      if (searching) {
        void fetchSessionsRef.current({ search: search || undefined })
        return
      }
      // 索引有内容：先上屏，再按需后台刷新（陈旧才拉）
      if (sessionListIndexStore.has(bucket)) {
        setIsLoading(false)
        const age = Date.now() - sessionListIndexStore.getFetchedAt(bucket)
        if (age > SESSION_LIST_TTL_MS) {
          void fetchSessionsRef.current({ search: undefined, skipCache: true, silent: true })
        }
        return
      }
      void fetchSessionsRef.current({ search: undefined })
    }

    searchTimerRef.current = window.setTimeout(run, searching ? 300 : 0)

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, searching, fetchSessions, bucketIdKey])

  // 订阅 SSE 事件，实时更新 session 列表。
  // 非搜索态：索引由 useGlobalEvents 统一增量维护，避免两处写入产生分歧。
  // 搜索态仍在此就地过滤。
  useEffect(() => {
    const unsubscribe = subscribeToEvents({
      onSessionCreated: session => {
        // 忽略子 session（有 parentID 的是子 agent 创建的）与内部临时会话
        if (session.parentID || isEphemeralSession(session.id)) return
        if (!searchRef.current) return
        if (!matchesCurrentDirectory(session)) return
        // 搜索态下交给服务端重新给出结果，避免本地过滤和服务端逻辑不一致
        void fetchSessionsRef.current({ search: searchRef.current || undefined })
      },
      onSessionUpdated: session => {
        if (session.parentID || isEphemeralSession(session.id)) return
        if (!searchRef.current) return

        if (session.time?.archived) {
          setSearchSessions(prev => prev.filter(s => s.id !== session.id))
          return
        }

        if (matchesCurrentDirectory(session)) {
          void fetchSessionsRef.current({ search: searchRef.current || undefined })
        } else {
          setSearchSessions(prev => prev.filter(s => s.id !== session.id))
        }
      },
      onTodoUpdated: data => {
        // todoStore 一律以「服务器作用域复合 key」为键（与底部面板/侧栏读取一致）。
        // SSE 事件里的 sessionID 是服务端原始 id，这里补上服务器前缀。
        const sessionKey = data.sessionID.includes('::')
          ? data.sessionID
          : makeSessionKey(serverStore.getActiveServerId(), data.sessionID)
        todoStore.setTodos(sessionKey, data.todos)
      },
      onSessionDeleted: sessionId => {
        clearSessionRuntimeState(sessionId)
        if (isEphemeralSession(sessionId)) return
        if (searchRef.current) {
          setSearchSessions(prev => prev.filter(s => s.id !== sessionId))
        }
      },
      onReconnected: reason => {
        if (reason === 'server-switch') return
        if (isFetchingRef.current) {
          queuedReconnectRefreshRef.current = true
          return
        }
        // 网络重连/回前台：保留屏上旧列表，静默拉最新覆盖（stale-while-revalidate）
        void fetchSessionsRef.current({ skipCache: true, silent: true })
      },
    })

    return unsubscribe
  }, [matchesCurrentDirectory])

  // Actions
  const refresh = useCallback(() => fetchSessions({ skipCache: true }), [fetchSessions])

  // 读取侧：按 loadedLimit 切片 + 排序。
  // 索引里存的是「多取一条」的原始页数据，切片后才是调用方要的条数。
  const sessions = useMemo(() => {
    if (searching) return searchSessions
    const limit = loadedLimit || DEFAULT_LIMIT
    // 排序由 index store 负责；这里只按已加载条数切片
    return indexSessions.slice(0, limit)
  }, [searching, searchSessions, indexSessions, loadedLimit])

  const hasMore = searching
    ? searchSessions.length >= currentLimitRef.current
    : sessionListIndexStore.getHasMore(bucket)

  const loadMore = useCallback(async () => {
    // 使用 ref 检查，防止并发请求
    if (isLoadingMoreRef.current || !hasMore || sessions.length === 0) return
    isLoadingMoreRef.current = true

    try {
      // 跟官方 webui 一样，递增 limit 重新请求整个列表
      currentLimitRef.current += 15
      setIsLoadingMore(true)
      await fetchSessions()
    } finally {
      isLoadingMoreRef.current = false
      setIsLoadingMore(false)
    }
  }, [hasMore, sessions.length, fetchSessions])

  const createSession = useCallback(
    async (title?: string, directory?: string, serverId?: string) => {
      // 使用正斜杠格式传给后端；directory 用于在创建瞬间切换工作目录，
      // targetDir 是渲染时冻结的值，同一时机传入可避免「切换项目后立即新建」
      // 与目录同步到达顺序竞争，导致新会话仍落到旧目录。
      //
      // serverId 缺省时退回活动服务器（老调用方的语义），但 pane 场景必须显式传：
      // 否则「pane 在 A 主机、活动服务器已切到 B」时会把会话建到 B 上。
      const newSession = await apiCreateSession(
        {
          title,
          directory: directory ?? (serverId ? undefined : targetDir),
        },
        serverId,
      )
      // D30：创建后立即 upsert 进索引，与 useSessions.create 行为一致。此前完全依赖
      // SSE session.created，SSE 未连/事件丢失时新会话不立即出现。
      if (!searchRef.current) sessionListIndexStore.upsert(bucket, newSession)
      return newSession
    },
    // bucket 每帧新建，用稳定 id 代替
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetDir, bucketIdKey],
  )

  const deleteSession = useCallback(
    async (id: string) => {
      await apiDeleteSession(id, targetDir)
      pinnedSessionsStore.unpin(id)
      clearSessionRuntimeState(id)
      if (searchRef.current) {
        setSearchSessions(prev => prev.filter(s => s.id !== id))
      } else {
        sessionListIndexStore.remove(bucket, id)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetDir, bucketIdKey],
  )

  // 稳定化 Provider value，避免每次渲染创建新对象导致子组件不必要重渲染
  const value = useMemo<SessionContextValue>(
    () => ({
      sessions,
      isLoading,
      isLoadingMore,
      hasMore,
      search,
      setSearch,
      refresh,
      loadMore,
      createSession,
      deleteSession,
    }),
    [sessions, isLoading, isLoadingMore, hasMore, search, refresh, loadMore, createSession, deleteSession],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
