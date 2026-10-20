// ============================================
// useSessionManager - Session 加载和状态管理
// ============================================
//
// 职责：
// 1. 加载 session 消息（初始加载 + 懒加载历史）
// 2. 处理 undo/redo（调用 API + 更新 store）
// 3. 只管理单个 session 的加载状态，不再承担全局当前 session 同步

import { useCallback, useEffect, useRef } from 'react'
import { logger } from '../utils/logger'
import { isUserUIMessage, toApiMessageWithParts } from '../utils/messageConversion'
import { messageStore, type RevertState, type SessionState } from '../store'
import { sessionKeyToServerId } from '../utils/sessionKey'
import {
  getSessionTurnPage,
  getSessionFirstScreen,
  getSessionMessagePage,
  getSessionLightweightMessages,
  probeLightweightSupport,
  peekLightweightSupport,
  encodeBeforeCursor,
  getSession,
  revertMessage,
  unrevertSession,
  extractUserMessageContent,
  type ApiMessageWithParts,
} from '../api'
import { sessionErrorHandler } from '../utils'
import { isSessionNotFoundError } from '../utils/sessionErrors'
import { INITIAL_TURN_LIMIT, HISTORY_TURN_BATCH_SIZE, RECENT_FULL_TURNS } from '../constants'
import i18n from '../i18n'
import type { MessageError } from '../types/message'

function toLoadMessageError(error: unknown): MessageError {
  const message = error instanceof Error ? error.message : String(error || i18n.t('chat:errors.loadSession'))
  return {
    name: 'APIError',
    data: {
      message,
      isRetryable: isRetryableLoadError(error),
      responseBody: error instanceof Error ? error.stack : undefined,
    },
  }
}

/**
 * 判定加载失败是否值得自动重试。
 *
 * 目标场景：本地 serve 进程短暂未就绪、传输层单次抖动，抛出的
 * `TypeError: Failed to fetch`（Tauri/webview 网络层失败）或超时/中止错误。
 * 这类错误是瞬态的，重试同一请求即可恢复，不必让用户手动刷新。
 *
 * 明确不重试：404/会话不存在（重试也不会出现），以及其它带 4xx 状态码的
 * 确定性错误。
 */
function isRetryableLoadError(error: unknown): boolean {
  if (isSessionNotFoundError(error)) return false
  // 主动取消不算瞬态错误，不重试
  if (error instanceof DOMException && error.name === 'AbortError') return false
  if (error instanceof Error && error.name === 'AbortError') return false

  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null
  const status =
    typeof record?.status === 'number'
      ? record.status
      : typeof record?.statusCode === 'number'
        ? record.statusCode
        : undefined
  if (status !== undefined && status >= 400 && status < 500) return false

  const message = error instanceof Error ? error.message : String(error ?? '')
  return /failed to fetch|network|timeout|timed out|aborted|econnrefused|connection (refused|reset|closed)|load failed/i.test(
    message,
  )
}

/**
 * 有限次退避重试；仅在 isRetryableLoadError 判定为可重试且未失效时重试。
 *
 * ⚠️ 退避必须短：这是**首屏阻塞路径**，用户在盯着加载动画。
 * 原先是 [500, 1500, 3000]，最坏情况单是等待就 5 秒；再叠加 4 次请求本身的耗时
 * （隧道下每次约 1s），一次失败的首屏能拖到十几秒甚至几十秒 —— 正是「加载好慢」。
 *
 * 现在改为 [300, 800]（最多 3 次尝试，总退避 1.1s）。瞬态抖动通常第一次重试就恢复；
 * 真连不上时，尽快把错误交给用户（显示重试按钮）比让他干等更有用。
 */
const LOAD_RETRY_DELAYS = [300, 800]

async function withLoadRetry<T>(fn: () => Promise<T>, isStale: () => boolean): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= LOAD_RETRY_DELAYS.length; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (isStale() || !isRetryableLoadError(error) || attempt === LOAD_RETRY_DELAYS.length) throw error
      sessionErrorHandler('load session retry', error)
      await new Promise(resolve => setTimeout(resolve, LOAD_RETRY_DELAYS[attempt]))
    }
  }
  throw lastError
}

interface UseSessionManagerOptions {
  sessionId: string | null
  directory?: string // 当前项目目录
  onLoadComplete?: () => void
  onError?: (error: Error) => void
  onSessionMissing?: (sessionId: string) => void
}

function preferCompatiblePartText(local: string, incoming: string): string {
  if (local === incoming) return incoming
  if (local.startsWith(incoming)) return local
  if (incoming.startsWith(local)) return incoming
  return incoming
}

function messageTimeIncomplete(time?: { completed?: number } | { created: number }) {
  if (!time) return true
  return !('completed' in time) || time.completed == null
}

function mergePartsForReload(
  localParts: ApiMessageWithParts['parts'],
  apiParts: ApiMessageWithParts['parts'],
): ApiMessageWithParts['parts'] {
  const localById = new Map(localParts.map(part => [part.id, part]))
  return apiParts.map(part => {
    const local = localById.get(part.id)
    if (!local || !('text' in local) || !('text' in part)) return part
    if (typeof local.text !== 'string' || typeof part.text !== 'string') return part
    const text = preferCompatiblePartText(local.text, part.text)
    if (text === part.text) return part
    return { ...part, text: text as typeof part.text }
  })
}

function mergeWithLocalStreamingMessages(
  apiMessages: ApiMessageWithParts[],
  localState?: SessionState,
): ApiMessageWithParts[] {
  if (!localState || localState.messages.length === 0) return apiMessages

  const localById = new Map(localState.messages.map(message => [message.info.id, message]))
  const apiIds = new Set(apiMessages.map(m => m.info.id))

  // 同 message：仅未定稿时 part 文本不回退；incoming 已 completed 则强制服务端
  const mergedApi = apiMessages.map(apiMessage => {
    const local = localById.get(apiMessage.info.id)
    if (!local) return apiMessage
    if (!messageTimeIncomplete(apiMessage.info.time)) return apiMessage
    const preserve = local.isStreaming || messageTimeIncomplete(local.info.time) || localState.isStreaming
    if (!preserve) return apiMessage
    return {
      ...apiMessage,
      parts: mergePartsForReload(local.content as ApiMessageWithParts['parts'], apiMessage.parts),
    }
  })

  // D6：本地独有消息（服务端快照未包含）的保留判定，不再只依赖 isStreaming。
  // setMessages 会按最后一条重算 isStreaming，completed→idle 之间可能已为 false，
  // 此时若只按 isStreaming 判定，本地刚流式完成、快照页尚未包含的消息会被整体覆盖丢失。
  // 放宽为「流式中 或 未定稿」：已定稿且不在快照里的，交给服务端；其余保留。
  const localOnly = localState.messages
    .filter(m => !apiIds.has(m.info.id))
    .filter(m => localState.isStreaming || messageTimeIncomplete(m.info.time))
    .map(toApiMessageWithParts)

  if (localOnly.length === 0) return mergedApi

  return [...mergedApi, ...localOnly].sort((a, b) => {
    const aCreated = a.info.time?.created ?? 0
    const bCreated = b.info.time?.created ?? 0
    return aCreated - bCreated
  })
}

export function useSessionManager({ sessionId, directory, onLoadComplete, onError, onSessionMissing }: UseSessionManagerOptions) {
  const loadSequenceRef = useRef<Map<string, number>>(new Map())
  /** 每个 session 是否正在加载更早的历史，防止并发 loadMore 造成分页错位 */
  const isLoadingMoreRef = useRef<Map<string, boolean>>(new Map())
  const loadSessionRef = useRef<(sid: string, options?: { force?: boolean }) => Promise<void>>(async () => {})
  /**
   * 补回「因内存预算被裁掉的最旧一段」的入口。
   *
   * loadSession 定义在 loadMoreHistory 之前，无法直接引用后者，故经 ref 转发。
   * 用途：首屏一次拉全后被裁剪时自动补缺口，避免会话最前面几轮永久不可见。
   */
  const recoverTrimmedHistoryRef = useRef<((sid: string) => Promise<void>) | null>(null)
  /**
   * 每个 session 初始页加载的 AbortController：切走时取消在途请求。
   * 快速连点多个会话时，旧会话的消息请求即使晚归也会被 seq 丢弃，但取消能
   * 立刻释放连接与解析开销，让新会话的请求更快拿到带宽。
   * 仅用于初始页（getSessionTurnPage 底层不走 singleFlight，取消不会误伤共享请求）。
   */
  const loadAbortRef = useRef<Map<string, AbortController>>(new Map())

  // 使用 ref 保存 directory，避免依赖变化
  const directoryRef = useRef(directory)

  useEffect(() => {
    directoryRef.current = directory
  }, [directory])

  // ============================================
  // Load Session
  // ============================================

  const loadSession = useCallback(
    async (sid: string, options?: { force?: boolean }) => {
      const force = options?.force ?? false

      const seq = (loadSequenceRef.current.get(sid) ?? 0) + 1
      loadSequenceRef.current.set(sid, seq)
      const isStale = () => loadSequenceRef.current.get(sid) !== seq

      // 每次加载前取消该 session 上一次在途的初始页请求（重载/切走都会走到这里）
      loadAbortRef.current.get(sid)?.abort()
      const abortController = new AbortController()
      loadAbortRef.current.set(sid, abortController)

      const dir = directoryRef.current

      // 检查是否已有消息（SSE 可能已经推送了）
      const existingState = messageStore.getSessionState(sid)
      const hasExistingMessages = existingState && existingState.messages.length > 0
      const hasLoadedBaseline = existingState?.loadState === 'loaded' && !existingState?.isStale

      // 如果已经有消息且正在 streaming，不能覆盖消息，但仍需加载元数据
      // 仅在「已经完整加载过」时才跳过覆盖；
      // 对于仅靠 SSE 暂存出来的 session（loadState=idle），仍要做一次完整拉取
      // force 模式下也不覆盖正在 streaming 且已加载的消息
      if (hasExistingMessages && existingState.isStreaming && hasLoadedBaseline) {
        // 异步加载 session 元数据（不阻塞）
        const dir = directoryRef.current
        const serverId = sessionKeyToServerId(sid)
        Promise.all([
          getSession(sid, dir, serverId).catch(() => null),
          getSessionTurnPage(sid, INITIAL_TURN_LIMIT, undefined, dir, serverId, {
            signal: abortController.signal,
          })
            .then(page => ({ ok: true as const, page }))
            .catch(() => ({
              ok: false as const,
              page: { messages: [] as ApiMessageWithParts[], nextCursor: undefined, hasMore: false },
            })),
        ])
          .then(([sessionInfo, pageResult]) => {
            if (isStale()) return

            messageStore.updateSessionMetadata(sid, {
              ...(pageResult.ok
                ? {
                    hasMoreHistory: pageResult.page.hasMore,
                    historyCursor: pageResult.page.nextCursor,
                    compactedAt: pageResult.page.compactedAt,
                    compactionMarker: pageResult.page.compaction,
                  }
                : {}),
              directory: sessionInfo?.directory ?? dir ?? '',
              title: sessionInfo?.title,
              shareUrl: sessionInfo?.share?.url,
            })
          })
          .catch(() => {
            // 元数据加载失败不影响 streaming，静默忽略
          })
        if (!isStale()) {
          onLoadComplete?.()
        }
        return
      }

      // 已有可显示内容时，刷新走「后台替换」而不打回 loading。
      //
      // ChatPane 用 `loadState === 'loaded'` 决定是否挂载 ChatArea，回落成
      // loading 会卸载已渲染的对话、闪一次全屏 loading、再重新挂载并跳回顶部
      // ——用户看到的就是「切换主机 / 重连 / 切回前台时对话整个刷新一遍」。
      // 保留 loaded 状态让旧内容留在屏上，数据到达后原地替换，滚动位置不丢。
      // 只有首次加载（屏上还没有内容）才需要 loading 占位并显示骨架。
      const hasContentToKeep =
        !!existingState && (existingState.loadState === 'loaded' || existingState.messages.length > 0)
      if (!hasContentToKeep) {
        messageStore.setLoadState(sid, 'loading')
      }

      try {
        // 并行加载 session 信息和消息（传递 directory）。
        // 瞬态网络失败（本地 serve 短暂未就绪、传输层抖动）自动重试，避免
        // 首屏或重连时一次 Failed to fetch 就把用户卡在错误页。
        const serverId = sessionKeyToServerId(sid)
        // 主机 Agent 支持轻量投影时：一次拉全整个会话（只含对话），首屏即完整、
        // 无需上滑补历史。不支持则退回按轮次分页的既有路径。
        //
        // 探测（limit=1）与 session 元数据并行发出：探测结果只决定「消息走哪条
        // 路径」，不依赖元数据。此前三者串行 —— 探测约 1.2s 往返，元数据约 1.2s，
        // 白白叠加成 ~2.4s。现在探测与 getSession 同时起飞，只有消息请求必须等
        // 探测结论（因为路径不同），总体从「探测+元数据+消息」压到「探测+消息」。
        /**
         * 轻量投影**只走缓存判断，绝不阻塞首屏**。
         *
         * 探测本身要一个完整往返，而它只决定「走轻量单请求还是轮次分页」。
         * 实测本机服务端并不支持轻量投影（不返回 X-Lightweight 头），也就是说
         * 这个往返对首屏毫无收益，却让内容晚到一个 RTT —— 经隧道就是 1 秒以上。
         *
         * 因此：
         *   - 已知结果（进程内或持久化缓存）→ 走对应路径，零额外开销；
         *   - 未知 → 立即按分页路径开始拉消息，同时在后台探测并把结果写入缓存，
         *     后续会话即可享受轻量路径。
         */
        const sessionInfoPromise = getSession(sid, dir, serverId).catch(() => null)
        const knownLightweight = peekLightweightSupport(serverId)
        if (knownLightweight === undefined) {
          // 后台探测：不 await，失败静默；结果会缓存给后续会话用。
          void probeLightweightSupport(sid, dir, serverId).catch(() => {})
        }

        /**
         * 首屏两段式：小页先出内容，剩余轮次在后台补齐。
         *
         * 大会话里「一次取够 N 轮」会让首屏等一个大响应（实测 200 条 536KB），
         * 而用户真正需要先看到的是最近几轮。因此这里先取一小页（约 60 条），
         * 拿到就立刻上屏；若轮次不够，再异步补足并原地替换。
         *
         * 已知支持轻量投影的服务器走单请求（一次拿全，无需分段）。
         */
        const lightweightMessages =
          knownLightweight === true
            ? await getSessionLightweightMessages(sid, dir, serverId, { signal: abortController.signal }).catch(
                () => null,
              )
            : null

        const firstScreen: Awaited<ReturnType<typeof getSessionFirstScreen>> | null = lightweightMessages
          ? null
          : await withLoadRetry(
              () => getSessionFirstScreen(sid, INITIAL_TURN_LIMIT, dir, serverId, { signal: abortController.signal }),
              isStale,
            )

        const page = lightweightMessages
          ? {
              messages: lightweightMessages.messages,
              nextCursor: undefined as string | undefined,
              hasMore: lightweightMessages.hasMore,
              compactedAt: lightweightMessages.compactedAt,
              compaction: lightweightMessages.compaction,
            }
          : {
              messages: firstScreen!.messages,
              nextCursor: firstScreen!.nextCursor,
              hasMore: firstScreen!.hasMore,
              compactedAt: firstScreen!.compactedAt,
              compaction: firstScreen!.compaction,
            }

        const sessionInfo = await sessionInfoPromise
        const apiMessages = page.messages

        if (isStale()) return

        // 再次检查：加载期间 SSE 可能已经推送了更多消息
        // force 模式下（重连）始终用服务器数据覆盖，因为本地数据可能不完整
        const currentState = messageStore.getSessionState(sid)
        const shouldKeepStreamingOnly =
          !force &&
          !!currentState &&
          !currentState.isStale &&
          currentState.loadState === 'loaded' &&
          currentState.messages.length > apiMessages.length

        const paging = { hasMoreHistory: page.hasMore, historyCursor: page.nextCursor }

        if (shouldKeepStreamingOnly) {
          // SSE 推送的消息比 API 返回的多，说明有新消息，跳过覆盖
          // 但仍需更新元数据，否则 hasMoreHistory 等状态可能停留在默认值
          messageStore.updateSessionMetadata(sid, {
            ...paging,
            directory: sessionInfo?.directory ?? dir ?? '',
            title: sessionInfo?.title,
            loadState: 'loaded',
            shareUrl: sessionInfo?.share?.url,
            compactedAt: page.compactedAt,
            compactionMarker: page.compaction,
          })
          onLoadComplete?.()
          return
        }

        const mergedMessages = mergeWithLocalStreamingMessages(apiMessages, currentState)

        // 设置消息到 store
        messageStore.setMessages(sid, mergedMessages, {
          directory: sessionInfo?.directory ?? dir ?? '',
          title: sessionInfo?.title,
          ...paging,
          revertState: sessionInfo?.revert ?? null,
          shareUrl: sessionInfo?.share?.url,
          compactedAt: page.compactedAt,
          compactionMarker: page.compaction,
        })
        // 首屏只覆盖最近 INITIAL_TURN_LIMIT 轮，无需压缩；保留调用以应对
        // SSE 已把更早轮次推入内存的情况。
        messageStore.compressHistoricalTurns(sid, RECENT_FULL_TURNS)

        // force 模式（如 SSE 重连）只静默刷新数据，不触发滚动
        if (!force) {
          onLoadComplete?.()
        }

        /**
         * 首屏已上屏：在后台把剩余轮次补齐，然后原地替换。
         *
         * 关键约束（不破坏体验）：
         *   - 不回到 loading 态：ChatArea 已挂载，用户看到的是可读内容；
         *   - 不跳滚动位置：setMessages 会保留同 id 消息的引用，滚动锚点不变；
         *   - 失败静默：已显示的内容仍然可用，缺口由用户上滑时按需加载。
         */
        if (firstScreen && !firstScreen.complete && firstScreen.rest) {
          const restPromise = firstScreen.rest
          void restPromise()
            .then(rest => {
              if (isStale()) return
              // 期间用户可能已切走/重新加载，只在仍是同一请求时替换
              const latest = messageStore.getSessionState(sid)
              if (!latest) return
              const merged = mergeWithLocalStreamingMessages(rest.messages, latest)
              messageStore.setMessages(sid, merged, {
                directory: latest.directory || dir || '',
                title: latest.title,
                hasMoreHistory: rest.hasMore,
                historyCursor: rest.nextCursor,
                shareUrl: latest.shareUrl,
                compactedAt: rest.compactedAt,
                compactionMarker: rest.compaction,
              })
              messageStore.compressHistoricalTurns(sid, RECENT_FULL_TURNS)
            })
            .catch(() => {
              // 补齐失败：保留首段内容，用户上滑时会再触发按需加载
            })
        }

        // 首屏若因内存预算裁掉了最旧的一段，自动把缺口补回来。
        //
        // 不这么做的话缺口只能靠用户手动上滑到顶才可能补 —— 而那条路径还有
        // userScrolled 判定问题，实际表现为「会话最前面几轮永远看不到」。
        // 这里在加载完成后主动补一次，让首屏即完整；补拉失败不影响已渲染内容。
        if (messageStore.getTrimmedCount(sid) > 0) {
          void recoverTrimmedHistoryRef.current?.(sid)
        }
      } catch (error) {
        if (isStale() || abortController.signal.aborted) return
        sessionErrorHandler('load session', error)
        messageStore.setLoadError(sid, toLoadMessageError(error))
        if (isSessionNotFoundError(error)) {
          onSessionMissing?.(sid)
        }
        onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    },
    [onLoadComplete, onError, onSessionMissing],
  )

  // 保持 ref 同步，避免 effect 依赖 loadSession 导致重复触发
  useEffect(() => {
    loadSessionRef.current = loadSession
  }, [loadSession])

  // ============================================
  // Load More History
  // ============================================

  const loadMoreHistory = useCallback(
    async (targetSessionId?: string) => {
      const sid = targetSessionId ?? sessionId
      if (!sid) return

      // 并发保护：同一 session 只允许一个 loadMore 在途
      if (isLoadingMoreRef.current.get(sid)) return

      const state = messageStore.getSessionState(sid)
      if (!state) return

      const dir = state.directory || directoryRef.current
      const before = state.historyCursor
      // 进入条件：要么有服务端游标，要么服务端说还有更早，要么本地存在被裁剪的
      // 内存缺口。最后一项必须有 —— 裁剪不再置 hasMoreHistory（否则大会话会陷入
      // 空拉循环），缺口信息只能从 trimmedCount 拿到。
      const trimmed = messageStore.getTrimmedCount(sid)
      if (!before && !state.hasMoreHistory && trimmed === 0) return

      // 与 loadSession 相同的序号校验：仅当本次请求仍是最新请求时才应用结果
      const seq = (loadSequenceRef.current.get(sid) ?? 0) + 1
      loadSequenceRef.current.set(sid, seq)
      const isStale = () => loadSequenceRef.current.get(sid) !== seq

      isLoadingMoreRef.current.set(sid, true)
      try {
        const serverId = sessionKeyToServerId(sid)
        // 按完整轮次向前加载：
        // - 有游标：以游标为界向前取一批。
        // - 无游标但有内存缺口：按「当前条数 + 缺口」重拉最新一页，把被裁掉的
        //   那段补回来；多留一档余量以便顺带探测更早内容。
        // - 无游标也无缺口：服务端说还有更早（旧版 serve 不给游标），从最新端
        //   按增大条数重拉，避免 limit 递增的 O(N²) 重拉。
        const targetTurns = HISTORY_TURN_BATCH_SIZE
        let page: Awaited<ReturnType<typeof getSessionTurnPage>>
        if (before) {
          page = await getSessionTurnPage(sid, targetTurns, before, dir, serverId)
        } else if (trimmed > 0) {
          // 有内存缺口（窗口超字节上限被从最旧端裁掉）：必须从「内存里最旧一条」
          // 向前翻页补回。此前用 before=undefined 重拉的是**最新**一页，与内存窗口
          // 高度重叠 → 去重后 0 条 → trimmedCount 永不归零 → hasTrimmedHistory 恒真
          // → ChatArea 在顶部无限自动加载（表现为「加载历史记录…」一直转）。
          const oldest = state.messages[0]
          const gapCursor = oldest
            ? encodeBeforeCursor({ info: oldest.info, parts: [] } as ApiMessageWithParts, serverId)
            : undefined
          page = await getSessionTurnPage(sid, targetTurns, gapCursor, dir, serverId)
        } else {
          // 无游标也无缺口：服务端说还有更早（旧版 serve 不给游标），从最新端
          // 按增大条数重拉，避免 limit 递增的 O(N²) 重拉。
          const wanted = Math.max(targetTurns, Math.ceil(state.messages.length / 2))
          page = await getSessionTurnPage(sid, wanted, undefined, dir, serverId)
        }

        // 期间发生了新的加载（loadSession 或再次 loadMore），丢弃本次结果
        if (isStale()) return

        const latestState = messageStore.getSessionState(sid)
        if (!latestState) return

        // 去重 + 按时间排序
        const existingIds = new Set(latestState.messages.map(m => m.info.id))
        const prependCandidates = page.messages
          .filter(m => !existingIds.has(m.info.id))
          .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))

      // 补拉结果必须与「本次是否真的补到了更早的连续内容」一致。
      //
      // 重拉路径（无游标）或 v2 边界返回的重叠页（有游标但内容全是已加载的），去重后
      // 可能一条不剩。此时若照抄 page.hasMore，就会把「其实没有更早内容」写成「还有
      // 历史」，ChatArea 随即在顶部反复自动加载 —— 空拉循环。因此只有「确实补进了更早
      // 内容」且服务端仍报 hasMore 时才认定还有历史。
      //
      // 游标：补到内容就前进到新游标；本来没游标（裁剪缺口补拉）也保留新游标，让下一次
      // 能继续向更早翻；只有在「带着游标却没补到任何内容」时清空游标——该游标已耗尽，
      // 留着只会让下一轮拿它再拉一次重叠页，循环不止。
      const madeProgress = prependCandidates.length > 0
      const hasMoreAfter = madeProgress && page.hasMore
      const nextHistoryCursor = madeProgress || !before ? page.nextCursor : undefined

      messageStore.prependMessages(sid, prependCandidates, hasMoreAfter, nextHistoryCursor)
        // 缺口补拉却没拿到任何更早内容 → 最旧一条其实就是会话第一条，缺口是误记。
        // 清掉它，否则 hasTrimmedHistory 恒真会让 ChatArea 在顶部反复空拉。
        if (trimmed > 0 && !madeProgress) messageStore.clearTrimmedGap(sid)
        // 前插后，超出最近 RECENT_FULL_TURNS 轮的旧轮次压缩，控制内存与渲染成本
        messageStore.compressHistoricalTurns(sid, RECENT_FULL_TURNS)
      } catch (error) {
        sessionErrorHandler('load more history', error)
      } finally {
        isLoadingMoreRef.current.set(sid, false)
      }
    },
    [sessionId],
  )

  /**
   * 向前翻页直到目标消息进入内存（侧边轴点到未加载轮次时调用）。
   *
   * 有界循环：最多补拉 MAX_PAGES 批，避免目标不可达时无限翻页；每批仍走
   * loadMoreHistory 的完整轮次分页，命中即停。返回是否已加载到目标。
   */  const loadUntilMessage = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (!sessionId) return false
      const MAX_PAGES = 20
      for (let i = 0; i < MAX_PAGES; i++) {
        const state = messageStore.getSessionState(sessionId)
        if (!state) return false
        if (state.messages.some(m => m.info.id === messageId)) return true
        if (!state.hasMoreHistory && !state.historyCursor) return false
        await loadMoreHistory()
        // loadMoreHistory 未产生新历史时提前结束，避免空转
        const after = messageStore.getSessionState(sessionId)
        if (!after || after.messages.length === state.messages.length) return after?.messages.some(m => m.info.id === messageId) ?? false
      }
      const finalState = messageStore.getSessionState(sessionId)
      return finalState?.messages.some(m => m.info.id === messageId) ?? false
    },
    [sessionId, loadMoreHistory],
  )

  // 把「补缺口」入口暴露给 loadSession（后者定义在前，无法直接引用）。
  useEffect(() => {
    recoverTrimmedHistoryRef.current = async (sid: string) => {
      // 补拉失败不冒泡：已渲染内容保持可用，缺口留待下次加载或用户上滑再补。
      await loadMoreHistory(sid).catch(() => {})
    }
    return () => {
      recoverTrimmedHistoryRef.current = null
    }
  }, [loadMoreHistory])

  // ============================================
  // Hydrate Compressed Turn
  // ============================================

  /**
   * 按需回拉某个轮次的完整 parts（展开被压缩的「已处理」折叠块时调用）。
   *
   * 用内存中已有消息的 {id,time} 构造游标，从「下一轮首条 user 消息」向前取
   * 本轮的若干条，恰好覆盖该轮，无需单条消息接口。回拉结果经 hydrateMessages
   * 原地替换压缩投影，清掉 isCompressed 标记。
   */
  const hydrateTurn = useCallback(
    async (turnUserMessageId: string) => {
      if (!sessionId) return

      const state = messageStore.getSessionState(sessionId)
      if (!state) return

      const messages = state.messages
      const startIndex = messages.findIndex(m => m.info.id === turnUserMessageId)
      if (startIndex === -1) return

      // 找到下一轮首条 user 消息，作为本轮结束边界
      let endIndex = messages.length
      for (let i = startIndex + 1; i < messages.length; i++) {
        if (messages[i].info.role === 'user') {
          endIndex = i
          break
        }
      }
      const turnMessages = messages.slice(startIndex, endIndex)
      if (turnMessages.length === 0) return

      // 本轮已被压缩的消息才需要回拉
      const hasCompressed = turnMessages.some(m => m.isCompressed)
      if (!hasCompressed) return

      const dir = state.directory || directoryRef.current
      const serverId = sessionKeyToServerId(sessionId)
      const nextTurnUser = endIndex < messages.length ? messages[endIndex] : undefined
      const before = nextTurnUser
        ? encodeBeforeCursor({ info: nextTurnUser.info, parts: [] } as ApiMessageWithParts, serverId)
        : undefined

      const seq = loadSequenceRef.current.get(sessionId)
      try {
        const page = await getSessionMessagePage(sessionId, turnMessages.length, before, dir, serverId)
        // 期间切走了 session 则丢弃
        if (loadSequenceRef.current.get(sessionId) !== seq) return
        messageStore.hydrateMessages(sessionId, page.messages)
      } catch (error) {
        sessionErrorHandler('hydrate turn', error)
      }
    },
    [sessionId],
  )

  // ============================================
  // Undo
  // ============================================

  /**
   * 发起撤销请求并计算 redo 历史，但不提交状态。
   *
   * 拆出「网络请求」与「状态提交」两步，是为了让动画与网络并行：
   * 调用方可先发起本请求，同时播放淡出动画，动画结束后再 commitUndo，
   * 从而把网络往返从串行路径上移出（原来先等动画再发请求，两段耗时叠加）。
   */
  const requestUndo = useCallback(
    async (userMessageId: string): Promise<RevertState | null> => {
      if (!sessionId) return null

      const state = messageStore.getSessionState(sessionId)
      if (!state) return null

      const dir = state.directory || directoryRef.current

      try {
        // 调用 API 设置 revert 点（传递 directory）
        await revertMessage(sessionId, userMessageId, undefined, dir, sessionKeyToServerId(sessionId))

        // 找到 revert 点的索引
        const revertIndex = state.messages.findIndex(m => m.info.id === userMessageId)
        if (revertIndex === -1) return null

        // 收集被撤销的用户消息，构建 redo 历史
        const revertedUserMessages = state.messages.slice(revertIndex).filter(isUserUIMessage)

        const history = revertedUserMessages.map(m => {
          const content = extractUserMessageContent(m)
          const userInfo = m.info
          return {
            messageId: m.info.id,
            text: content.text,
            attachments: content.attachments,
            model: userInfo.model,
            variant: userInfo.model.variant,
            agent: userInfo.agent,
          }
        })

        return { messageId: userMessageId, history }
      } catch (error) {
        sessionErrorHandler('undo', error)
        return null
      }
    },
    [sessionId],
  )

  /** 提交撤销状态（由 requestUndo 得到的 revertState） */
  const commitUndo = useCallback(
    (revertState: RevertState) => {
      if (!sessionId) return
      messageStore.setRevertState(sessionId, revertState)
    },
    [sessionId],
  )

  const handleUndo = useCallback(
    async (userMessageId: string) => {
      const revertState = await requestUndo(userMessageId)
      if (revertState) commitUndo(revertState)
    },
    [requestUndo, commitUndo],
  )

  // ============================================
  // Redo
  // ============================================

  const handleRedo = useCallback(async () => {
    if (!sessionId) return

    const state = messageStore.getSessionState(sessionId)
    if (!state?.revertState) return

    const { history } = state.revertState
    if (history.length === 0) return

    const dir = state.directory || directoryRef.current

    try {
      // 移除第一条历史记录（最早撤销的）
      const newHistory = history.slice(1)

      if (newHistory.length > 0) {
        // 还有更多历史，设置新的 revert 点
        const newRevertMessageId = newHistory[0].messageId
        await revertMessage(sessionId, newRevertMessageId, undefined, dir, sessionKeyToServerId(sessionId))

        messageStore.setRevertState(sessionId, {
          messageId: newRevertMessageId,
          history: newHistory,
        })
      } else {
        // 没有更多历史，完全清除 revert 状态
        await unrevertSession(sessionId, dir, sessionKeyToServerId(sessionId))
        messageStore.setRevertState(sessionId, null)
      }
    } catch (error) {
      sessionErrorHandler('redo', error)
    }
  }, [sessionId])

  // ============================================
  // Redo All
  // ============================================

  const handleRedoAll = useCallback(async () => {
    if (!sessionId) return

    const state = messageStore.getSessionState(sessionId)
    const dir = state?.directory || directoryRef.current

    try {
      await unrevertSession(sessionId, dir, sessionKeyToServerId(sessionId))
      messageStore.setRevertState(sessionId, null)
    } catch (error) {
      sessionErrorHandler('redo all', error)
    }
  }, [sessionId])

  // ============================================
  // Clear Revert
  // ============================================

  const clearRevert = useCallback(() => {
    if (!sessionId) return
    messageStore.setRevertState(sessionId, null)
  }, [sessionId])

  // ============================================
  // Effects
  // ============================================

  // 根据 sessionId 切换缓存视图。
  // focused pane / URL 的同步由 App 顶层统一负责，
  // 这里不再写任何“全局当前 session”状态。
  useEffect(() => {
    if (sessionId) {
      const cached = messageStore.getSessionState(sessionId)
      const canUseCached = !!cached && cached.loadState === 'loaded' && !cached.isStale && cached.messages.length > 0

      if (canUseCached) {
        logger.log('[SessionManager] switch:use-cached', {
          sessionId,
          cachedCount: cached.messages.length,
        })
        return
      }

      logger.log('[SessionManager] switch:fetch-session', { sessionId })
      void loadSessionRef.current(sessionId)
    }

    // 切走时取消上一个 session 在途的初始页请求，避免其占用连接与带宽
    const abortMap = loadAbortRef.current
    return () => {
      if (sessionId) abortMap.get(sessionId)?.abort()
    }
  }, [sessionId])

  // 卸载时取消所有在途请求
  useEffect(() => {
    const abortMap = loadAbortRef.current
    return () => {
      for (const controller of abortMap.values()) controller.abort()
      abortMap.clear()
    }
  }, [])

  return {
    loadSession,
    loadMoreHistory,
    loadUntilMessage,
    hydrateTurn,
    handleUndo,
    requestUndo,
    commitUndo,
    handleRedo,
    handleRedoAll,
    clearRevert,
  }
}
