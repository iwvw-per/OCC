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
import { isUserUIMessage, toApiMessageWithParts, toUIMessage } from '../utils/messageConversion'
import { messageStore, type RevertState, type SessionState } from '../store'
import { sessionKeyToServerId } from '../utils/sessionKey'
import {
  getSessionTurnPage,
  getSessionFirstScreen,
  getSessionMessagePage,
  getSessionLightweightMessages,
  peekLightweightSupport,
  probeLightweightSupport,
  encodeBeforeCursor,
  getSession,
  revertMessage,
  unrevertSession,
  extractUserMessageContent,
  LIGHTWEIGHT_MESSAGE_LIMIT,
  type ApiMessageWithParts,
  type ApiSession,
} from '../api'
import { sessionErrorHandler } from '../utils'
import { backfillSessionUsage } from '../api/contextBackfill'
import { isSessionNotFoundError } from '../utils/sessionErrors'
import { INITIAL_TURN_LIMIT, HISTORY_TURN_BATCH_SIZE, RECENT_FULL_TURNS } from '../constants'
import { extractTurnOutlineEntries } from '../components/outlineIndexModel'
import { turnOutlineStore } from '../store/turnOutlineStore'
import { backgroundJobStore } from '../store/backgroundJobStore'
import type { BackgroundJobStatus } from '../features/workStatus/backgroundJobs'
import { estimateHistoryPageSize } from '../constants/pagination'
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

/**
 * 历史分页的页大小按「本会话实际的每轮消息数」自适应。
 *
 * 服务端的 limit 是**消息条数**，而我们想要的是**轮次**。固定一个页大小，
 * 普通会话会为 3 轮下载 200 条（实测 947KB），工具密集会话则要翻好几页才凑够
 * 轮次（往返次数翻倍）。自适应后每次上滑基本是「一次往返取够需要的量」。
 */

function messageTimeIncomplete(time?: { completed?: number } | { created: number }) {
  if (!time) return true
  return !('completed' in time) || time.completed == null
}

/**
 * 从 `GET /api/session/{id}` 的返回值里取「会话绑定的模型」。
 *
 * v2 的形状是 `model: { id, providerID, variant }`（注意字段是 `id` 而不是
 * `modelID`），少数路径可能已经归一成 `{ providerID, modelID }`。两种都接受。
 * 缺 providerID 或 modelID 时返回 undefined —— 宁可不恢复，也不要用半条信息
 * 去覆盖用户的正确选择。
 */
function toSessionModelRef(session: ApiSession | null | undefined): { providerID: string; modelID: string } | undefined {
  if (!session) return undefined
  const raw = (session as { model?: { id?: string; modelID?: string; providerID?: string; variant?: string } }).model
  const providerID = raw?.providerID
  const modelID = raw?.modelID ?? raw?.id
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
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

/**
 * 把服务端快照与本地消息合并。
 *
 * 导出仅为可测试：这是「切后台再回前台后对话变空」这类问题的关键路径，
 * 需要能直接构造「本地有历史 + 快照只有一窗口」的场景来回归。
 */
export function mergeWithLocalStreamingMessages(
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
  //
  // ⚠️ 已定稿且不在快照里的消息**也必须保留**，不能「交给服务端」。
  //
  // 快照天然只覆盖一段窗口（v2 单次 limit 上限 200；骨架首屏更是只有最近几页）。
  // 移动端切后台再回前台会触发 network 重连 → force 重载，若只保留「流式中/未定稿」
  // 的消息，窗口之外的历史会被整段丢掉 —— 实测表现为助手消息全部消失、只剩用户
  // 消息（用户看到的就是「切回来后对话空了一半」）。
  //
  // 服务端快照仍是权威：**在快照里**的消息一律用服务端版本（见上面的 mergedApi），
  // 这里只在「本地有、快照没有」时保留本地副本，属于补集而非覆盖。
  const localOnly = localState.messages
    .filter(m => !apiIds.has(m.info.id))
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
        /**
         * 首屏优先走**轮次骨架**，拿不到再退回按量分页。
         *
         * 骨架由主机 Agent（agent-rust）实现：按轮投影成「用户提问 + 最终回复 +
         * 过程计数」，reasoning 与工具过程留在服务端。实测同一个 168 轮 / 7000 条
         * 消息的会话：
         *   - 按量分页（多页 × 数百 KB，加上 18MB 的大纲补全）
         *   - 骨架（单请求）                 0.39 MB
         * 而且骨架天然是「整段」的，首屏一次到手，不必上滑补历史。
         *
         * ⚠️ 前置条件是主机 Agent 已升级。旧版 Agent 不认识 `X-Lightweight: skeleton`，
         * 会把它原样透传给 opencode（不带 X-Lightweight 响应头）——此时请求拿到的是
         * **单条**普通消息，不是整段，退回分页即可，不会白下载。
         *
         * 探测本身很便宜（只要响应头，body 立刻 cancel），因此**首次加载等它一下**
         * 比「先分页、下次才用骨架」更划算：探测约一个隧道往返，而分页要多拉几 MB。
         * 已知支持时直接命中缓存，不额外等待。
         */
        const sessionInfoPromise = getSession(sid, dir, serverId).catch(() => null)

        let skeletonSupported = peekLightweightSupport(serverId) === true
        if (peekLightweightSupport(serverId) === undefined) {
          skeletonSupported = await probeLightweightSupport(sid, dir, serverId).catch(() => false)
        }
        const skeleton = skeletonSupported
          ? await withLoadRetry(
              () => getSessionLightweightMessages(sid, dir, serverId, { signal: abortController.signal }),
              isStale,
            ).catch(() => null)
          : null

        if (skeleton && skeleton.messages.length > 0) {
          const sessionInfo = await sessionInfoPromise
          if (isStale()) return

          /**
           * 骨架 + 未定稿轮次补拉（方案 A）。
           *
           * 骨架只覆盖**已定稿**的历史轮次。正在生成的那一轮被 Agent 标成
           * `settled: false` 并从骨架里剔除 —— 因为骨架给的是「此刻的截断快照」，
           * 而后续 `session.text.delta` 是 ephemeral（不重放、不带 seq），
           * 前端无法判断新 delta 与快照是否重叠，直接拼会重复或错位。
           *
           * 所以这一轮单独用完整消息拉取：轮次规模通常几十条，成本可控，
           * 而且拿到的是「当前完整正文」，后续 delta 可以安全追加。
           */
          /**
           * ⚠️ 这一段失败 = **正在进行的回复整段消失**（骨架里没有它，补拉也没
           * 拿到）。此前 catch 静默吞掉、锚点找不到时 tailMessages 为空，
           * 于是页面只剩历史轮次 —— 用户看到的就是「刷新后最新回复一片空白」。
           *
           * 因此这里：失败自动重试；锚点找不到时退化为「从最后一条 user 开始」，
           * 而不是直接放弃。
           */
          let tailMessages: ApiMessageWithParts[] = []
          const unsettledTurns = skeleton.unsettledTurns ?? []
          if (unsettledTurns.length > 0) {
            const page = await withLoadRetry(
              () =>
                getSessionMessagePage(sid, LIGHTWEIGHT_MESSAGE_LIMIT, undefined, dir, serverId, {
                  signal: abortController.signal,
                }),
              isStale,
            ).catch(() => null)

            if (page) {
              const unsettledSet = new Set(unsettledTurns)
              const firstUnsettledIndex = page.messages.findIndex(
                m => m.info.role === 'user' && unsettledSet.has(m.info.id),
              )

              if (firstUnsettledIndex >= 0) {
                tailMessages = page.messages.slice(firstUnsettledIndex)
              } else {
                /**
                 * 锚点不在这页里（这一轮很长超过单页上限，或 Agent 给的 turn id
                 * 与消息 id 不同源）。不能直接放弃 —— 放弃就等于正在进行的这一轮
                 * 彻底不显示。退化为「从最后一条 user 消息开始」，那是本轮最可能
                 * 的起点。
                 */
                const lastUserIndex = page.messages.reduce(
                  (acc, m, idx) => (m.info.role === 'user' ? idx : acc),
                  -1,
                )
                tailMessages = lastUserIndex >= 0 ? page.messages.slice(lastUserIndex) : page.messages
              }
            }
          }

          const currentState = messageStore.getSessionState(sid)
          const mergedMessages = mergeWithLocalStreamingMessages(
            tailMessages.length > 0 ? [...skeleton.messages, ...tailMessages] : skeleton.messages,
            currentState,
          )

          const sessionModel = toSessionModelRef(sessionInfo)
          const sessionAgent = sessionInfo?.agent || undefined
          const configModel = skeleton.config?.model
          const configAgent = skeleton.config?.agent
          const resolvedModel = configModel
            ? { providerID: configModel.providerID, modelID: configModel.modelID }
            : sessionModel
          const resolvedAgent = configAgent?.agent ?? sessionAgent
          const lastTurn = skeleton.idle
            ? {
                at: skeleton.idle.at,
                outcome: skeleton.idle.outcome,
                ...(skeleton.idle.error ? { error: skeleton.idle.error } : {}),
              }
            : undefined

          messageStore.setMessages(sid, mergedMessages, {
            directory: sessionInfo?.directory ?? dir ?? '',
            title: sessionInfo?.title,
            /**
             * 骨架首屏只取最近几页（约 0.7s），更早的轮次留待上滑再取。
             *
             * `nextCursor` 是主机 Agent 回的 v2 消息游标：带着它再请求一次骨架
             * 就能拿到更早一段。此前这里写死 `hasMoreHistory: false`，于是
             * 「一次取全」变成「永远只有最近几页」——上滑到底也拉不到更早的历史。
             */
            hasMoreHistory: skeleton.nextCursor != null,
            historyCursor: skeleton.nextCursor,
            revertState: sessionInfo?.revert ?? null,
            shareUrl: sessionInfo?.share?.url,
            compactedAt: skeleton.compactedAt,
            compactionMarker: skeleton.compaction,
          })
          if (resolvedModel || resolvedAgent || lastTurn) {
            messageStore.updateSessionMetadata(sid, {
              ...(resolvedModel ? { model: resolvedModel } : {}),
              ...(resolvedAgent ? { agent: resolvedAgent } : {}),
              ...(lastTurn ? { lastTurn } : {}),
            })
          }
          if (skeleton.turns) messageStore.setTurnSkeleton(sid, skeleton.turns)
          /**
           * 骨架带回的后台任务。
           *
           * 骨架剥掉了工具 part，前端无法自己从消息推导（判据 metadata.shellID
           * 与被剥掉的回执文本），所以由主机 Agent 单独带回并在这里落到实时表。
           *
           * ⚠️ 这些状态是**主机 Agent 从历史消息推导**出来的，只能证明任务曾经
           * 启动过，不能证明它已经结束。因此标记为非权威：随后 `shell.list`
           * 校正或 `shell.created` 事件可以立刻把它纠正成 running。
           * 之前这里没做这个区分，叠加 store 的「终态不可回退」，
           * 真正在跑的后台任务就被永久钉在「已完成」上。
           */
          for (const job of skeleton.backgroundJobs ?? []) {
            /**
             * 状态交给 `shell.list` 校正，这里只放一个**非权威**占位。
             *
             * 主机 Agent 对「轮次已定稿但没收到完成通知」的后台任务写 unknown
             * —— 它从历史消息无法判断任务是否还在跑。这里先按已完成占位
             * （历史任务绝大多数确实已结束），随后 `useReconcileRunningShells`
             * 会用 `shell.list` 把真正还在跑的改成 running。
             *
             * ⚠️ 不能把 unknown 当成 running 占位：那样面板会在没有任何任务
             * 运行时显示一大片「运行中」（实测出现 13/30 的误报）。
             */
            backgroundJobStore.set(sid, {
              id: job.id,
              status: job.status === 'unknown' ? 'completed' : (job.status as BackgroundJobStatus),
              // 骨架里没有任务时间戳：用会话最后一条消息的时间兜底，
              // 而不是 Date.now()（否则「已结束」会显示成刚刚结束）
              at: skeleton.messages[skeleton.messages.length - 1]?.info.time?.created ?? Date.now(),
              title: job.title,
              // 骨架里任务挂在轮次上：用轮次 id 当跳转锚点（此前为空，
              // 于是面板点条目毫无反应）
              ...(job.messageId ? { messageId: job.messageId } : {}),
              // 推导出来的状态：允许被实时事件 / shell.list 校正
              authoritative: false,
            })
          }
          onLoadComplete?.()

          /**
           * 后台把剩余骨架页补全，**只用来补侧边轴大纲**。
           *
           * 为什么值得做：骨架全量实测只有 451KB / 186 轮（8.7s），而侧边轴的
           * 轮次大纲原先要另发一条 18MB 的请求。补全之后轴上就有**全部**轮次，
           * 点哪轮都能跳，而且不必再发大纲请求（`loadedFromSkeleton` 已跳过它）。
           *
           * ⚠️ 刻意**不**把结果 prepend 进消息列表：那会让正在阅读的用户视图
           * 突然被插入几百条消息，视口跳动。用户点轴跳到某轮时，`loadUntilMessage`
           * 会按同一游标正常续取，锚点逻辑在那条路径上是完整的。
           */
          const tailCursor = skeleton.nextCursor
          if (tailCursor) {
            void (async () => {
              try {
                const older = await getSessionLightweightMessages(sid, dir, serverId, {
                  cursor: tailCursor,
                  pages: 60,
                })
                if (isStale() || older.messages.length === 0) return
                const entries = extractTurnOutlineEntries(older.messages.map(toUIMessage))
                if (entries.length > 0) turnOutlineStore.merge(serverId, sid, entries)
              } catch {
                // 静默：大纲只是导航辅助，点轴时仍会按需续取
              }
            })()
          }

          /**
           * 骨架路径**必须**也补用量 —— 它是唯一需要补的路径。
           *
           * 骨架投影每轮只留「提问 + 最终回复 + 过程计数」，assistant 消息
           * 不带 tokens。于是 `lastAssistantWithTokens` 为 null，圆环只能按
           * 字符估算、轮次统计全是「—」、TPS 为 0 —— 正是用户看到的
           * 「上下文 0%、发一条消息后才对」（发消息会拉完整消息）。
           *
           * 这条分支下面直接 `return` 了，所以不能指望末尾那个统一调用。
           */
          void backfillSessionUsage(sid)
          return
        }

        /**
         * 退回按量分页（主机 Agent 未升级，或骨架拉取失败）。
         *
         * 此时首屏只发「刚好够看」的小页（FIRST_SCREEN_PAGE_LIMIT），其余按需分页：
         * 大会话里「一次取够 N 轮」会让首屏等一个大响应（实测 200 条 947KB），
         * 而用户真正需要先看到的是最近几轮。
         */
        const firstScreen = await withLoadRetry(
          () => getSessionFirstScreen(sid, INITIAL_TURN_LIMIT, dir, serverId, { signal: abortController.signal }),
          isStale,
        )

        const page = firstScreen

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

        /**
         * 会话级权威状态，三个来源，优先级从高到低：
         *
         * 1. 消息列表里的 `model-switched` / `agent-switched` / `idle` 记录
         *    （`page.config` / `page.idle`）——最精确，记录了「什么时候切成了什么」；
         * 2. `GET /api/session/{id}` 的 `model` / `agent` 字段——当前生效值；
         * 3. 本地缓存（不在服务端返回值里的情况下兜底）。
         *
         * v2 的 user 消息**没有** model 字段（实测只有 time/text/files），
         * 所以「无痕窗口/新设备打开同一会话显示成默认模型」只能靠前两者还原。
         */
        const sessionModel = toSessionModelRef(sessionInfo)
        const sessionAgent = sessionInfo?.agent || undefined
        const configModel = page.config?.model
        const configAgent = page.config?.agent
        const resolvedModel = configModel
          ? { providerID: configModel.providerID, modelID: configModel.modelID }
          : sessionModel
        const resolvedAgent = configAgent?.agent ?? sessionAgent
        const lastTurn = page.idle
          ? { at: page.idle.at, outcome: page.idle.outcome, ...(page.idle.error ? { error: page.idle.error } : {}) }
          : undefined

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
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(resolvedAgent ? { agent: resolvedAgent } : {}),
            ...(lastTurn ? { lastTurn } : {}),
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
        // 会话绑定的模型/agent 与轮次结论单独写一次（setMessages 的入参不含这些，
        // 它们不属于「消息页」的语义，而是会话级元数据）。
        if (resolvedModel || resolvedAgent || lastTurn) {
          messageStore.updateSessionMetadata(sid, {
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(resolvedAgent ? { agent: resolvedAgent } : {}),
            ...(lastTurn ? { lastTurn } : {}),
          })
        }
        // 首屏只覆盖最近 INITIAL_TURN_LIMIT 轮，无需压缩；保留调用以应对
        // SSE 已把更早轮次推入内存的情况。
        messageStore.compressHistoricalTurns(sid, RECENT_FULL_TURNS)

        /**
         * 用消息列表里的 `idle` 记录校正「残留的流式态」。
         *
         * 事件负责**及时**（`session.execution.succeeded` 到了就立刻收尾），
         * 而 idle 记录负责**正确**：只要存在一条不早于最后一条 assistant 消息的
         * idle 记录，就说明那一轮在服务端已经结束 —— 此时界面还显示「生成中」
         * 纯粹是事件丢失（断线重连、隧道抖动、进程重启）造成的假象。
         *
         * 这一步在下面 `settleByAuthoritativeIdle` 里做了严格的时序校验。
         */
        if (lastTurn) messageStore.settleByAuthoritativeIdle(sid)

        // force 模式（如 SSE 重连）只静默刷新数据，不触发滚动
        if (!force) {
          onLoadComplete?.()
        }

        /**
         * 首屏已上屏：在后台把剩余轮次补齐，然后**增量前插**。
         *
         * 关键约束（不破坏体验）：
         *   - 不回到 loading 态：ChatArea 已挂载，用户看到的是可读内容；
         *   - 不跳滚动位置：前插保留既有消息对象引用，滚动锚点不变；
         *   - 失败静默：已显示的内容仍然可用，缺口由用户上滑时按需加载。
         *
         * ⚠️ 这里必须用「前插」而不是 setMessages 整表替换：
         * setMessages 会把每条消息都重新构造成新对象（toUIMessage），
         * 于是 React 认为「所有消息都变了」，整条会话被全量重渲染 ——
         * 用户在补齐期间正好开始操作/滚动，就会被这轮重渲染卡住。
         * 前插只新增更早的消息，已渲染的消息对象引用不变，React 直接跳过。
         */
        if (!firstScreen.complete && firstScreen.rest) {
          const restPromise = firstScreen.rest
          void restPromise()
            .then(rest => {
              if (isStale()) return
              // 期间用户可能已切走/重新加载，只在仍是同一请求时替换
              const latest = messageStore.getSessionState(sid)
              if (!latest) return
              // 只取「本次新拿到的更早消息」：首屏那些已经在内存里了。
              const existingIds = new Set(latest.messages.map(m => m.info.id))
              const older = rest.messages.filter(m => !existingIds.has(m.info.id))
              if (older.length === 0) {
                // 没有新内容：只更新分页游标，避免停在旧游标上反复空拉。
                messageStore.prependMessages(sid, [], rest.hasMore, rest.nextCursor, {
                  compactedAt: rest.compactedAt,
                  compaction: rest.compaction,
                })
                return
              }
              messageStore.prependMessages(sid, older, rest.hasMore, rest.nextCursor, {
                compactedAt: rest.compactedAt,
                compaction: rest.compaction,
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

        // 后台补会话累计用量：`session.usage.updated` 是 ephemeral 事件，重连/刷新
        // 后不会再补发，此时统计会退化成「按已加载消息累加」（首屏仅 50 条，
        // 真实上下文 300+ 条 → 数字小一个数量级）。`session.context` 能补上这个洞。
        // 不 await：纯补数据，失败/慢都不该影响首屏。
        void backfillSessionUsage(sid)
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

        /**
         * 骨架路径：上滑继续取更早的**骨架页**。
         *
         * 首屏只翻最近几页（保 0.7s 出内容），更早的轮次在这里按同一游标续取。
         * 不能退回按量分页 —— 那会把已被剥掉的过程正文重新拉一遍（单页可达
         * 数百 KB），而用户当前只想看到更早的「用户提问 + 回复」。
         */
        if (state.loadedFromSkeleton && before) {
          const older = await getSessionLightweightMessages(sid, dir, serverId, {
            cursor: before,
          })
          if (isStale()) return
          const latest = messageStore.getSessionState(sid)
          if (!latest) return
          const existing = new Set(latest.messages.map(m => m.info.id))
          const prepend = older.messages
            .filter(m => !existing.has(m.info.id))
            .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
          messageStore.prependMessages(sid, prepend, older.nextCursor != null, older.nextCursor)
          if (older.turns && older.turns.size > 0) {
            messageStore.mergeTurnSkeleton(sid, older.turns)
          }
          return
        }

        /**
         * 页大小按「本会话实际的每轮消息数」自适应。
         *
         * 服务端的 limit 是**消息条数**，而我们想要的是**轮次**。两者比例差别极大：
         * 普通聊天一轮 2~4 条消息；工具密集的会话一轮可达 30+ 条（实测某会话
         * 4810 条消息只有 135 个用户轮次 ≈ 35 条/轮）。
         *
         * 固定一个大的 limit（比如 200）时，普通会话会为了 3 轮去下载 200 条
         * （实测 947KB）；固定一个小的 limit 时，工具密集会话要翻好几页才能凑够
         * 轮次，字节数一样但往返次数翻倍。
         *
         * 所以按已加载部分的密度反推需要多少条，一次取够，**一轮往返搞定**，
         * 且不超出实际需要的量。
         */
        const userCount = state.messages.reduce((count, m) => count + (m.info.role === 'user' ? 1 : 0), 0)
        // 样本不足 2 个用户轮次时密度不可信（首屏那十几条常常一条用户消息都没有），
        // 交给 estimateHistoryPageSize 用默认值。
        const messagesPerTurn = userCount >= 2 ? state.messages.length / userCount : 0
        const pageLimit = estimateHistoryPageSize(messagesPerTurn, HISTORY_TURN_BATCH_SIZE)
        // 按完整轮次向前加载：
        // - 有游标：以游标为界向前取一批。
        // - 无游标但有内存缺口：按「当前条数 + 缺口」重拉最新一页，把被裁掉的
        //   那段补回来；多留一档余量以便顺带探测更早内容。
        // - 无游标也无缺口：服务端说还有更早（旧版 serve 不给游标），从最新端
        //   按增大条数重拉，避免 limit 递增的 O(N²) 重拉。
        const targetTurns = HISTORY_TURN_BATCH_SIZE
        let page: Awaited<ReturnType<typeof getSessionTurnPage>>
        if (before) {
          page = await getSessionTurnPage(sid, targetTurns, before, dir, serverId, { pageLimit })
        } else if (trimmed > 0) {
          // 有内存缺口（窗口超字节上限被从最旧端裁掉）：必须从「内存里最旧一条」
          // 向前翻页补回。此前用 before=undefined 重拉的是**最新**一页，与内存窗口
          // 高度重叠 → 去重后 0 条 → trimmedCount 永不归零 → hasTrimmedHistory 恒真
          // → ChatArea 在顶部无限自动加载（表现为「加载历史记录…」一直转）。
          const oldest = state.messages[0]
          const gapCursor = oldest
            ? encodeBeforeCursor({ info: oldest.info, parts: [] } as ApiMessageWithParts, serverId)
            : undefined
          page = await getSessionTurnPage(sid, targetTurns, gapCursor, dir, serverId, { pageLimit })
        } else {
          // 无游标也无缺口：服务端说还有更早（旧版 serve 不给游标），从最新端
          // 按增大条数重拉，避免 limit 递增的 O(N²) 重拉。
          const wanted = Math.max(targetTurns, Math.ceil(state.messages.length / 2))
          page = await getSessionTurnPage(sid, wanted, undefined, dir, serverId, {
            // 这里要的是「更多」而不是「更早」，页大小跟着 wanted 走，
            // 但同样受自适应上限约束，避免一次性拖回几百 KB。
            pageLimit: Math.min(pageLimit, estimateHistoryPageSize(messagesPerTurn, wanted)),
          })
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
   * 两种压缩形态，处理方式不同：
   *
   * 1. **压缩态**（老轮次只是被剥字段，消息本身还在）：按 id 原地替换。
   * 2. **骨架态**（整轮 40 条被压成 2 条，消息已不在内存里）：必须整段替换，
   *    把中间消息补回来，否则展开后仍只有「用户 + 回复」。
   *
   * 两种都用「下一轮首条 user 消息」构造游标向前取，恰好覆盖本轮，无需单条接口。
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

      /**
       * 请求条数。
       *
       * 骨架态下 turnMessages 只有 2 条，但真实轮次可能有几十条 —— 用它当 limit
       * 只会拉回两条，展开后依旧缺内容。骨架轮次无法据此推断规模，因此直接按
       * 单页上限取（游标本身限定了区间，服务端不会跨轮返回）。
       *
       * 骨架轮的判定：该轮助手消息带 `isCompressed` 且**没有 tool part**。
       * 压缩态（老轮次）剥掉了工具大输出但 tool part 壳还在，两者可以区分。
       * 纯工具轮（骨架里 reply 为 null）同样符合「没有 tool part」+ 压缩标记。
       */
      const assistantOfTurn = turnMessages.filter(m => m.info.role === 'assistant')
      const isSkeletonTurn =
        assistantOfTurn.length > 0 &&
        assistantOfTurn.every(m => m.isCompressed) &&
        assistantOfTurn.every(m => !m.content.some(part => part.type === 'tool'))
      /**
       * 请求条数。
       *
       * ⚠️ 不能用 `turnMessages.length` 当 limit：骨架/压缩态下本轮在内存里只有
       * 两条（user + 最终回复），而真实轮次可能有几十上百条 —— 只拉 2 条回来，
       * 展开后依旧几乎空白，且因为不报错，表现为「偶发加载不出来」
       * （取决于内存里恰好留了几条）。
       *
       * 统一按单页上限取：游标（`before`）本身已经限定了区间，服务端不会跨轮
       * 返回，多取的部分在下面的时间过滤里会被剔掉。
       */
      /**
       * 请求条数统一按单页上限。
       *
       * ⚠️ 不能用 `turnMessages.length`：骨架/压缩态下本轮在内存里只有两条
       * （user + 最终回复），而真实轮次可能有几十上百条 —— 只拉 2 条回来，
       * 展开后依旧几乎空白，而且不报错，表现为「偶发加载不出来」
       * （取决于内存里恰好留了几条）。
       *
       * 游标（`before`）本身已限定区间，服务端不会跨轮返回，多取的部分
       * 由下面的区间切分剔除。
       */
      const requestLimit = LIGHTWEIGHT_MESSAGE_LIMIT

      try {
        const page = await getSessionMessagePage(sessionId, requestLimit, before, dir, serverId)

        /**
         * 并发保护。
         *
         * ⚠️ 这里刻意**不**比对 loadSequenceRef：那个序号在每次 loadSession /
         * loadMoreHistory 时都会 +1，而刷新后展开折叠块（配合布局恢复、
         * 视口滚动触发补页）极易与首屏加载并发。原实现一比就丢弃结果且不重试
         * —— 这正是「偶发加载不出来，多刷几次就好了」。
         *
         * 同会话内一律允许写入：hydrateMessages 按 id 合并，
         * replaceTurnMessages 按区间替换，重复都是幂等的。
         * 切走会话时 store 里已无对应 state，写入自然落空，无需额外判断。
         */

        /**
         * 切出本轮区间：用**消息 id 锚点**，不依赖时间戳。
         *
         * 时间比较（`created >= turnStart && created < turnEnd`）在这里不可靠：
         * 骨架的 `time.created` 是轮次起点，真实消息的 `created` 可能与之相差
         * 几毫秒，严格比较会把整轮剔光；随后 `fetched.length === 0` 静默返回，
         * 用户看到的就是「展开后一片空白」。
         */
        const anchorId = turnMessages[0].info.id
        const nextTurnId = nextTurnUser?.info.id

        let fetched = page.messages
        const anchorIndex = fetched.findIndex(m => m.info.id === anchorId)
        if (anchorIndex >= 0) {
          const nextIndex = nextTurnId ? fetched.findIndex(m => m.info.id === nextTurnId) : -1
          fetched = nextIndex > anchorIndex ? fetched.slice(anchorIndex, nextIndex) : fetched.slice(anchorIndex)
        } else {
          // 锚点不在这一页（本轮有 200+ 条、且用户点的是更早的轮次）：
          // 退化为时间过滤，但边界取两侧最近值，不苛求精确相等。
          const turnStart = turnMessages[0].info.time?.created ?? 0
          const turnEnd = nextTurnUser?.info.time?.created ?? Number.POSITIVE_INFINITY
          fetched = fetched.filter(m => {
            const created = m.info.time?.created ?? 0
            return created >= turnStart && created < turnEnd
          })
        }

        /**
         * 空结果不再静默返回。
         *
         * 原本这里是 `if (fetched.length === 0) return`，任何一次切分失配都会
         * 变成「点了展开没反应」且无重试。兜底地把服务端返回的原始一页交给
         * store（按 id 合并，重复不会重复渲染），好过让折叠块永远空着。
         */
        const usable = fetched.length > 0 ? fetched : page.messages
        if (usable.length === 0) return

        if (isSkeletonTurn) {
          /**
           * 骨架轮：整段替换。
           *
           * 但必须先确认这批数据**真的属于本轮** —— 替换是破坏性的，
           * 若因锚点/游标错位拿到相邻轮次的内容，会把本轮彻底换掉，
           * 表现为「展开后显示的是别的内容」或「一片空白」。
           *
           * 判据：本轮 user 消息 id 必须在这批数据开头附近出现；
           * 不满足就退回合并（不删原有内容）。
           */
          const containsAnchor = usable.some(m => m.info.id === turnUserMessageId)
          if (containsAnchor) {
            messageStore.replaceTurnMessages(sessionId, turnUserMessageId, usable)
          } else {
            messageStore.hydrateMessages(sessionId, usable)
          }
        } else {
          messageStore.hydrateMessages(sessionId, usable)
        }
      } catch (error) {
        sessionErrorHandler('hydrate turn', error)
        /**
         * 向上抛：调用方（ProcessCollapseBlock）据此显示「回拉失败，点击重试」。
         *
         * 不抛的话 Promise 永远 resolve，UI 无法区分「拉失败了」与
         * 「本来就没有内容」—— 两者都只表现为一片空白，用户只能反复刷新。
         */
        throw error
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
