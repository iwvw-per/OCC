import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react'
import {
  getSessions,
  createSession,
  deleteSession,
  subscribeToEvents,
  subscribeToServerEvents,
  type ApiSession,
  type SessionListParams,
} from '../api'
import { serverStore } from '../store/serverStore'
import { pinnedSessionsStore } from '../store/pinnedSessionsStore'
import {
  sessionListIndexStore,
  isIndexableQuery,
  type SessionListBucketKey,
} from '../store/sessionListIndexStore'
import { autoDetectPathStyle } from '../utils'
import { normalizeForComparison } from '../utils/directoryUtils'
import { isEphemeralSession } from '../utils/ephemeralSessions'
import { sortSessionsByAnchor } from '../store/sessionActivityStore'
import i18n from '../i18n'

interface UseSessionsOptions {
  /** 每页数量 */
  pageSize?: number
  /** 初始搜索词 */
  initialSearch?: string
  /** 只加载根会话 */
  rootsOnly?: boolean
  /** 按目录过滤 */
  directory?: string
  /**
   * 多目录聚合：传入时把这些目录（如同一 git 项目的多个 worktree）的会话合并成
   * 一个列表，不再区分分支/子目录层级。与 directory 二选一，优先本项。
   */
  directories?: string[]
  /** 延迟启用，用于懒加载 */
  enabled?: boolean
  /** 指定服务器（缺省用活动服务器）。多服务器模式下每个服务器一个实例 */
  serverId?: string
}

interface UseSessionsResult {
  sessions: ApiSession[]
  isLoading: boolean
  isLoadingMore: boolean
  error: Error | null
  hasMore: boolean
  /** 搜索词 */
  search: string
  setSearch: (search: string) => void
  /** 加载更多 */
  loadMore: () => Promise<void>
  /** 收起：重置回初始分页并重新拉取 */
  collapse: () => Promise<void>
  /** 刷新列表 */
  refresh: () => Promise<void>
  /** 创建新会话 */
  create: (title?: string) => Promise<ApiSession>
  /** 删除会话 */
  remove: (sessionId: string) => Promise<void>
  /** 本地更新会话 */
  patchLocalSession: (sessionId: string, patch: Partial<ApiSession>) => void
  /** 本地移除会话 */
  removeLocalSession: (sessionId: string) => void
}

/** 搜索态的结果保存在组件内：搜索是瞬态高基数查询，不入索引 */
type SearchState = {
  sessions: ApiSession[]
  isLoading: boolean
  error: Error | null
  /** D25：服务端是否还有更多。此前靠 `sessions.length >= limit` 推断，条数正好等于
   *  limit 时会误判「还有更多」，点击后返回同样条数、按钮无反应。 */
  hasMore: boolean
}

const EMPTY_SESSIONS: ApiSession[] = []

export function useSessions(options: UseSessionsOptions = {}): UseSessionsResult {
  const { pageSize = 20, initialSearch = '', rootsOnly = true, directory, directories, enabled = true, serverId } =
    options

  // 标准化 directory 路径 (移除末尾斜杠，统一正斜杠)
  const normalizedDirectory = directory ? directory.replace(/\\/g, '/').replace(/\/$/, '') : undefined

  // 多目录聚合：规范化 + 去重 + 稳定排序，作为依赖键避免每帧重算。
  const normalizedDirectories = useMemo(() => {
    if (!directories || directories.length === 0) return null
    const set = new Set(directories.map(dir => dir.replace(/\\/g, '/').replace(/\/$/, '')))
    return Array.from(set).sort()
  }, [directories])
  const isAggregate = normalizedDirectories !== null
  const directoriesKey = normalizedDirectories ? normalizedDirectories.join('\u0001') : ''

  const [search, setSearch] = useState(initialSearch)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [searchState, setSearchState] = useState<SearchState>({ sessions: EMPTY_SESSIONS, isLoading: false, error: null, hasMore: false })
  // 非搜索态（索引桶）的加载失败：重试耗尽后置位，供列表区展示错误态
  const [listError, setListError] = useState<Error | null>(null)

  // 缺省跟随活动服务器时要响应切换：用订阅而非一次性读取
  const activeServerId = useSyncExternalStore(
    cb => serverStore.subscribe(cb),
    () => serverStore.getActiveServerId(),
    () => serverStore.getActiveServerId(),
  )
  const resolvedServerId = serverId ?? activeServerId
  const searching = search !== ''
  // 搜索态不进索引：索引用「无 search」的桶
  const indexable = enabled && !searching && isIndexableQuery({ search })

  /** 索引桶：服务器 + 目录 + 活跃视图（本 hook 只查活跃列表）。
   *  scope 固定 'sidebar'：侧栏列表按 pageSize 分页，与上下条导航（30 条）分开存，
   *  否则两者会互相覆盖 loadedLimit。 */
  // 聚合模式：为每个目录各建一个真实桶（SSE 按 directory 路由才能落到正确桶），
  // 读取侧再把各桶快照合并；单目录模式保持原单桶不变。
  const bucket: SessionListBucketKey = {
    serverId: resolvedServerId,
    directory: normalizedDirectory,
    view: 'active',
    scope: 'sidebar',
  }
  const directoryBuckets = useMemo<SessionListBucketKey[]>(() => {
    if (!isAggregate || !normalizedDirectories) return []
    return normalizedDirectories.map(dir => ({
      serverId: resolvedServerId,
      directory: dir,
      view: 'active' as const,
      scope: 'sidebar',
    }))
  }, [isAggregate, normalizedDirectories, resolvedServerId])
  const bucketIdKey = `${resolvedServerId}\u0000${isAggregate ? directoriesKey : (normalizedDirectory ?? '')}`

  // 全局版本订阅：任何桶变化都触发重算（聚合需要感知所有目录桶）。
  const indexVersion = useSyncExternalStore(
    cb => sessionListIndexStore.subscribe(cb),
    () => sessionListIndexStore.getVersion(),
    () => sessionListIndexStore.getVersion(),
  )

  // 索引快照（同步、引用稳定）：这是「切回旧主机首帧即有内容」的关键。
  // 搜索态返回空，由 searchState 接管。
  // 聚合模式：合并各目录桶（按 loadedLimit 切片）去重后按锚点排序，结果随版本稳定。
  const indexSessions = useMemo(() => {
    if (!indexable) return EMPTY_SESSIONS
    if (!isAggregate) return sessionListIndexStore.getSnapshot(bucket)
    const seen = new Set<string>()
    const merged: ApiSession[] = []
    for (const dirBucket of directoryBuckets) {
      const limit = sessionListIndexStore.getLoadedLimit(dirBucket) || pageSize
      for (const session of sessionListIndexStore.getSnapshot(dirBucket).slice(0, limit)) {
        if (seen.has(session.id)) continue
        seen.add(session.id)
        merged.push(session)
      }
    }
    return sortSessionsByAnchor(merged)
    // bucket 每帧新建，用 bucketIdKey 代替；indexVersion 覆盖内容变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexable, isAggregate, directoryBuckets, bucketIdKey, indexVersion, pageSize])

  const hasIndexContent = useMemo(() => {
    if (!indexable) return false
    if (!isAggregate) return sessionListIndexStore.has(bucket)
    return directoryBuckets.some(dirBucket => sessionListIndexStore.has(dirBucket))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexable, isAggregate, directoryBuckets, bucketIdKey, indexVersion])

  const [isLoading, setIsLoading] = useState(enabled && !hasIndexContent)

  // 用于跟踪最后一次请求，避免竞态条件
  const requestIdRef = useRef(0)
  const searchTimerRef = useRef<number | null>(null)
  const currentLimitRef = useRef(pageSize)
  const searchRef = useRef(search)
  // 防止 onReconnected 密集触发时重复请求
  const isFetchingRef = useRef(false)
  const queuedReconnectRefreshRef = useRef(false)
  const retryTimerRef = useRef<number | null>(null)

  useEffect(() => {
    searchRef.current = search
  }, [search])

  const fetchSessionsRef = useRef<
    (
      params?: SessionListParams & { append?: boolean; retryAttempt?: number; skipCache?: boolean; silent?: boolean },
    ) => Promise<void>
  >(() => Promise.resolve())

  // 获取会话列表
  // append 仅用于控制 loading 状态：true 时用 isLoadingMore，false 时用 isLoading
  // 数据始终全量替换（递增 limit 策略）
  const fetchSessions = useCallback(
    async (
      params: SessionListParams & { append?: boolean; retryAttempt?: number; skipCache?: boolean; silent?: boolean } = {},
    ) => {
      if (!enabled) return

      const { append = false, retryAttempt = 0, silent = false, ...queryParams } = params
      const requestId = ++requestIdRef.current
      isFetchingRef.current = true

      const isSearch = Boolean(queryParams.search ?? searchRef.current)
      // 搜索态的结果落在组件 state；常规列表落索引。
      // 静默刷新（回前台/重连）不动 loading，也不清已有内容。
      if (append) {
        setIsLoadingMore(true)
      } else if (!silent && (!isSearch || !hasIndexContent)) {
        if (isSearch) setSearchState(prev => ({ ...prev, isLoading: true, error: null }))
        else if (!hasIndexContent) setIsLoading(true)
      }

try {
          // 多取一条用于判断是否还有更多：仅凭 data.length >= limit 无法区分
          // 「刚好这么多」和「还有更多」——会话数正好等于 pageSize 时会多出一个
          // 点了没反应的「展开更多会话」按钮（取回同样条数后 hasMore 立刻变 false）。
          const requestedLimit = currentLimitRef.current
          let data: ApiSession[]
          let hasMore: boolean
          // 聚合模式：记录每个目录各自的列表，写回各自桶（SSE 按目录路由才一致）
          let perDirectoryLists: { bucket: SessionListBucketKey; list: ApiSession[] }[] | null = null
          // D2：记录请求发出前的成员版本。回包时若桶成员已变（期间 SSE 新增/删除
          // 会话），说明这份响应已过时，直接丢弃，避免抹掉期间到达的增量。
          const expectedMembership = sessionListIndexStore.getMembershipRevision(bucket)
          const expectedPerDirectory =
            isAggregate && normalizedDirectories
              ? normalizedDirectories.map(dir =>
                  sessionListIndexStore.getMembershipRevision({
                    serverId: resolvedServerId,
                    directory: dir,
                    view: 'active',
                    scope: 'sidebar',
                  }),
                )
              : null
          if (isAggregate && normalizedDirectories) {
            // 聚合：每个目录各拉一次（多取一条判 hasMore），合并去重后按时间排序。
            const perDirectory = await Promise.all(
              normalizedDirectories.map(dir =>
                getSessions(
                  { roots: rootsOnly, limit: requestedLimit + 1, directory: dir, ...queryParams },
                  serverId,
                ).catch(() => [] as ApiSession[]),
              ),
            )
            const seen = new Set<string>()
            const merged: ApiSession[] = []
            let anyHasMore = false
            perDirectoryLists = []
            normalizedDirectories.forEach((dir, i) => {
              const list = perDirectory[i]
              if (list.length > requestedLimit) anyHasMore = true
              perDirectoryLists!.push({
                bucket: { serverId: resolvedServerId, directory: dir, view: 'active', scope: 'sidebar' },
                list,
              })
              for (const session of list) {
                if (seen.has(session.id)) continue
                seen.add(session.id)
                merged.push(session)
              }
            })
            data = merged
            hasMore = anyHasMore
          } else {
            data = await getSessions(
              {
                roots: rootsOnly,
                limit: requestedLimit + 1,
                directory: normalizedDirectory,
                ...queryParams,
              },
              serverId,
            )
            hasMore = data.length > requestedLimit
          }

          // 检查是否是最新的请求
          if (requestId !== requestIdRef.current) return

          if (data.length > 0 && data[0].directory) {
            // 按服务器记录路径风格（多服务器连接不同操作系统时互不干扰）
            autoDetectPathStyle(data[0].directory, serverId)
          }

          if (isSearch) {
            setSearchState({ sessions: sortSessionsByAnchor(data.slice(0, requestedLimit)), isLoading: false, error: null, hasMore })
          } else if (perDirectoryLists) {
            // 每个目录写回自己的桶；loadedLimit 记为 requestedLimit（与单目录语义一致，
            // 空目录也算「已加载」），否则 SSE 增量会因 loadedLimit===0 被丢弃。
            perDirectoryLists.forEach(({ bucket: dirBucket, list }, i) => {
              sessionListIndexStore.replace(dirBucket, list, {
                limit: requestedLimit,
                hasMore: list.length > requestedLimit,
                expectedMembershipRevision: expectedPerDirectory?.[i],
              })
            })
            setListError(null)
          } else {
            // 索引存全量页数据（含多取的那条），由读取侧按 loadedLimit 切片
            sessionListIndexStore.replace(bucket, data, {
              limit: requestedLimit,
              hasMore,
              expectedMembershipRevision: expectedMembership,
            })
            // 拉取成功：清掉失败态（列表有内容后错误不再展示）
            setListError(null)
          }
        } catch (e) {
          if (requestId !== requestIdRef.current) return
          const error = e instanceof Error ? e : new Error(i18n.t('chat:errors.fetchSessions'))
          if (!append) {
            if (retryAttempt < 3) {
              if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
              retryTimerRef.current = window.setTimeout(() => {
                if (requestId !== requestIdRef.current) return
                void fetchSessions({ ...queryParams, silent, retryAttempt: retryAttempt + 1 })
              }, [500, 1500, 3000][retryAttempt])
            } else if (isSearch) {
              setSearchState({ sessions: EMPTY_SESSIONS, isLoading: false, error, hasMore: false })
            } else if (!silent) {
              // 非静默且索引为空才留下空列表；索引有内容时保留旧数据
              sessionListIndexStore.replace(bucket, [], { limit: 0, hasMore: false })
              setListError(error)
            }
          }
        } finally {
        if (requestId === requestIdRef.current) {
          isFetchingRef.current = false
          setIsLoading(false)
          setIsLoadingMore(false)
          setSearchState(prev => (prev.isLoading ? { ...prev, isLoading: false } : prev))
          if (queuedReconnectRefreshRef.current) {
            queuedReconnectRefreshRef.current = false
            void fetchSessionsRef.current({ search: searchRef.current || undefined, skipCache: true, silent: true })
          }
        }
      }
    },
    // bucket 是每帧新建对象，用它做依赖会无限重跑；用稳定的 id 字符串代替。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootsOnly, normalizedDirectory, normalizedDirectories, enabled, serverId, bucketIdKey, hasIndexContent],
  )

  fetchSessionsRef.current = fetchSessions

  // 初始加载和搜索变化时重新加载。
  // 关键差异：索引已有内容时首帧不显示 loading（同步读到旧数据），
  // 只在过旧（超过 TTL）时才后台静默刷新。
  useEffect(() => {
    if (!enabled) {
      setIsLoading(false)
      setIsLoadingMore(false)
      return
    }

    // 搜索或 enabled 变化时重置 limit
    currentLimitRef.current = pageSize

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
    }

    const run = () => {
      if (searching) {
        void fetchSessionsRef.current({ search: search || undefined })
        return
      }
      // 索引有内容：先上屏，再按需后台刷新（陈旧才拉）。
      // 直接读 store（而非闭包里的 memo），避免 setTimeout 期间内容已到达却仍判空。
      const buckets = isAggregate ? directoryBuckets : [bucket]
      const hasContent = buckets.some(b => sessionListIndexStore.has(b))
      if (hasContent) {
        setIsLoading(false)
        let oldest = Number.POSITIVE_INFINITY
        for (const b of buckets) {
          const at = sessionListIndexStore.getFetchedAt(b)
          if (at === 0) {
            oldest = 0
            break
          }
          if (at < oldest) oldest = at
        }
        if (oldest > 0 && Date.now() - oldest > SESSION_LIST_TTL_MS) {
          void fetchSessionsRef.current({ search: undefined, skipCache: true, silent: true })
        }
        return
      }
      void fetchSessionsRef.current({ search: undefined })
    }

    searchTimerRef.current = window.setTimeout(run, searching ? 300 : 0) // 有搜索词时延迟 300ms

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, searching, fetchSessions, enabled, pageSize, bucketIdKey])

  // 订阅 SSE 事件，实时更新列表。
  // 非搜索态：索引由 useGlobalEvents 统一增量维护，这里不再自维护一份，
  // 避免同一事件两处写入产生分歧。搜索态仍在此就地过滤。
  useEffect(() => {
    if (!enabled) return

    // 聚合模式下会话可能来自任一目录，搜索态过滤要按目录集合判断
    const dirMatch = (session: ApiSession) =>
      normalizedDirectories
        ? normalizedDirectories.some(dir => matchesDirectory(session, dir))
        : matchesDirectory(session, normalizedDirectory)

    const subscribe = serverId
      ? (cb: Parameters<typeof subscribeToServerEvents>[1]) => subscribeToServerEvents(serverId, cb)
      : subscribeToEvents

    const unsubscribe = subscribe({
      onSessionCreated: session => {
        if (isEphemeralSession(session.id)) return
        if (session.parentID) return
        if (!searchRef.current) return // 索引路径由 useGlobalEvents 维护
        if (!dirMatch(session)) return
        void fetchSessionsRef.current({ search: searchRef.current || undefined })
      },
      onSessionUpdated: session => {
        if (isEphemeralSession(session.id)) return
        if (session.parentID) return
        if (!searchRef.current) return
        if (session.time?.archived) {
          setSearchState(prev => ({ ...prev, sessions: prev.sessions.filter(item => item.id !== session.id) }))
          return
        }
        if (dirMatch(session)) {
          void fetchSessionsRef.current({ search: searchRef.current || undefined })
        } else {
          setSearchState(prev => ({ ...prev, sessions: prev.sessions.filter(item => item.id !== session.id) }))
        }
      },
      onSessionDeleted: sessionId => {
        if (isEphemeralSession(sessionId)) return
        if (!searchRef.current) return
        setSearchState(prev => ({ ...prev, sessions: prev.sessions.filter(item => item.id !== sessionId) }))
      },
      onReconnected: reason => {
        if (reason === 'server-switch') return
        if (isFetchingRef.current) {
          queuedReconnectRefreshRef.current = true
          return
        }
        // 网络重连/回前台：保留屏上旧列表，静默拉最新覆盖（stale-while-revalidate）
        void fetchSessionsRef.current({ search: searchRef.current || undefined, skipCache: true, silent: true })
      },
    })

    return unsubscribe
  }, [enabled, normalizedDirectory, normalizedDirectories, pageSize, serverId])

  // 切服务器：不在此清索引。索引按 serverId 分桶，新服务器的桶要么有内容
  // （切回旧主机即时出）要么为空（走上面的初始加载）。旧服务器的桶保留复用。

  // 读取侧：按 loadedLimit 切片。排序由 index store 负责（就地更新语义，
  // 避免流式期间并行会话交替更新导致列表来回跳）。
  // 聚合模式：indexSessions 已按各桶 loadedLimit 合并，无需再切。
  const sessions = useMemo(() => {
    if (searching) return searchState.sessions
    if (!indexable) return EMPTY_SESSIONS
    if (isAggregate) return indexSessions
    const limit = sessionListIndexStore.getLoadedLimit(bucket) || pageSize
    return indexSessions.slice(0, limit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, searchState.sessions, indexable, isAggregate, indexSessions, bucketIdKey, indexVersion, pageSize])

  const hasMore = searching
    ? searchState.hasMore
    : isAggregate
      ? directoryBuckets.some(dirBucket => sessionListIndexStore.getHasMore(dirBucket))
      : sessionListIndexStore.getHasMore(bucket)

  // 加载更多：递增 limit 重新拉取完整列表
  const loadMore = useCallback(async () => {
    if (!enabled || isLoadingMore || !hasMore || sessions.length === 0) return

    currentLimitRef.current += pageSize
    await fetchSessions({ search: search || undefined, append: true })
  }, [enabled, isLoadingMore, hasMore, sessions.length, pageSize, search, fetchSessions])

  // 收起：把 limit 重置回初始 pageSize，重新拉取（对应「展开更多会话」的收起入口）
  const collapse = useCallback(async () => {
    if (!enabled || isLoadingMore || currentLimitRef.current <= pageSize) return

    currentLimitRef.current = pageSize
    await fetchSessions({ search: search || undefined, append: true })
  }, [enabled, isLoadingMore, pageSize, search, fetchSessions])

  // 刷新：显式下拉/重新拉取时绕过列表缓存，保证拿到最新数据
  const refresh = useCallback(async () => {
    if (!enabled) return
    await fetchSessions({ search: search || undefined, skipCache: true })
  }, [search, fetchSessions, enabled])

  // 创建新会话
  const create = useCallback(
    async (title?: string) => {
      const newSession = await createSession(
        {
          title,
          directory: normalizedDirectory,
        },
        serverId,
      )

      if (searchRef.current) {
        void fetchSessionsRef.current({ search: searchRef.current || undefined })
      } else if (isAggregate && normalizedDirectories) {
        // D14：聚合模式读取侧按 directoryBuckets 合并，且每个桶要求 directory 一致。
        // 新会话落到它自身 directory 对应的桶（服务端可能把它归到任一 worktree）。
        const targetDir = normalizeForComparison(newSession.directory)
        const targetBucket =
          directoryBuckets.find(b => normalizeForComparison(b.directory) === targetDir) ?? null
        if (targetBucket) {
          sessionListIndexStore.upsert(targetBucket, newSession)
        } else {
          // 目录不在聚合集合内：刷新列表，避免新会话不可见
          void fetchSessionsRef.current({ search: undefined, skipCache: true, silent: true })
        }
      } else {
        sessionListIndexStore.upsert(bucket, newSession)
      }

      return newSession
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [normalizedDirectory, normalizedDirectories, isAggregate, directoryBuckets, serverId, bucketIdKey],
  )

  // 删除会话
  const remove = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId, normalizedDirectory, serverId)
      pinnedSessionsStore.unpin(sessionId)
      if (searchRef.current) {
        setSearchState(prev => ({ ...prev, sessions: prev.sessions.filter(s => s.id !== sessionId) }))
      } else if (isAggregate) {
        // D13：聚合模式会话可能落在任一个目录桶，逐个移除并记墓碑
        for (const dirBucket of directoryBuckets) sessionListIndexStore.remove(dirBucket, sessionId)
      } else {
        sessionListIndexStore.remove(bucket, sessionId)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [normalizedDirectory, isAggregate, directoryBuckets, serverId, bucketIdKey],
  )

  const patchLocalSession = useCallback(
    (sessionId: string, patch: Partial<ApiSession>) => {
      if (searchRef.current) {
        setSearchState(prev => ({
          ...prev,
          sessions: prev.sessions.map(session => (session.id === sessionId ? { ...session, ...patch } : session)),
        }))
        return
      }
      // 聚合模式：会话可能落在任一个目录桶，逐个尝试（命中即改）
      if (isAggregate) {
        for (const dirBucket of directoryBuckets) sessionListIndexStore.patch(dirBucket, sessionId, patch)
        return
      }
      sessionListIndexStore.patch(bucket, sessionId, patch)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bucketIdKey, isAggregate, directoryBuckets],
  )

  const removeLocalSession = useCallback(
    (sessionId: string) => {
      if (searchRef.current) {
        setSearchState(prev => ({ ...prev, sessions: prev.sessions.filter(session => session.id !== sessionId) }))
        return
      }
      if (isAggregate) {
        for (const dirBucket of directoryBuckets) sessionListIndexStore.remove(dirBucket, sessionId)
        return
      }
      sessionListIndexStore.remove(bucket, sessionId)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bucketIdKey, isAggregate, directoryBuckets],
  )

  return {
    sessions,
    isLoading: searching ? searchState.isLoading : isLoading,
    isLoadingMore,
    error: searching ? searchState.error : listError,
    hasMore,
    search,
    setSearch,
    loadMore,
    collapse,
    refresh,
    create,
    remove,
    patchLocalSession,
    removeLocalSession,
  }
}

/** 索引 TTL：超过此时长再次挂载会触发一次后台静默刷新 */
const SESSION_LIST_TTL_MS = 30_000

/** 目录匹配（与索引分桶语义一致：正斜杠 + 去尾斜杠 + 小写） */
function matchesDirectory(session: ApiSession, directory: string | undefined): boolean {
  if (!directory) return true
  const normalize = (value: string | undefined) => (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(session.directory) === normalize(directory)
}
