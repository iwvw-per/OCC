// ============================================
// useChatSession - 聊天会话管理
// ============================================

import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  messageStore,
  useSessionFamily,
  useSessionState,
  useSessionStatus,
  autoApproveStore,
  childSessionStore,
  activeSessionStore,
  notificationStore,
  type RevertHistoryItem,
} from '../store'
import {
  useSessionManager,
  registerSessionConsumer,
  updateConsumerSessionId,
  hasOtherConsumerForSession,
} from '../hooks'
import { usePermissionHandler, useMessageAnimation, useDirectory, useSessionContext } from '../hooks'
import { useNotification } from './useNotification'
import { notificationEventSettingsStore } from '../store/notificationEventSettingsStore'
import {
  sendMessageAsync,
  getSessionMessages,
  abortSession,
  backgroundSessionTools,
  getSelectableAgents,
  getPendingPermissions,
  getPendingQuestions,
  prefetchCommands,
  prefetchRootDirectory,
  getSessionChildren,
  getSessionStatus,
  executeCommand,
  summarizeSession,
  updateSession,
  forkSession,
  extractUserMessageContent,
  type ApiPermissionRequest,
  type ApiSession,
  type ApiAgent,
  type Attachment,
  type ModelInfo,
} from '../api'
import { getMessageText, isUserMessage, type AssistantMessageInfo, type Message as UIMessage } from '../types/message'
import { clipboardErrorHandler, copyTextToClipboard, createErrorHandler } from '../utils'
import { logger } from '../utils/logger'
import { clearSessionRuntimeState } from '../utils/sessionLifecycle'
import { serverStorage } from '../utils/perServerStorage'
import { sessionKeyToServerId, splitSessionKey, makeSessionKey } from '../utils/sessionKey'
import { serverStore } from '../store/serverStore'
import { sessionListIndexStore } from '../store/sessionListIndexStore'
import { STORAGE_KEY_SELECTED_AGENT } from '../constants'
import type { ChatAreaHandle } from '../features/chat'
import { followupQueueStore } from '../store/followupQueueStore'
import i18n from '../i18n'

const handleError = createErrorHandler('session')

/**
 * Stable empty session state singleton.
 *
 * When routeSessionId is null (e.g. an empty split pane), useChatSession
 * uses this instead of creating a new object on every render.  A fresh
 * literal `{ messages: [], ... }` would give a different reference each
 * time, defeating React.memo on ChatArea and causing pointless re-renders
 * of the entire message tree.
 */
const EMPTY_SESSION_STATE = {
  messages: [] as import('../types/message').Message[],
  isStreaming: false,
  loadState: 'idle' as const,
  loadError: undefined,
  revertState: null,
  canUndo: false,
  canRedo: false,
  redoSteps: 0,
  revertedContent: null,
  hasMoreHistory: false,
  hasTrimmedHistory: false,
  loadedFromSkeleton: false,
  directory: '',
  title: null,
  compactedAt: undefined as number | undefined,
  model: undefined as { providerID: string; modelID: string; variant?: string } | undefined,
  agent: undefined as string | undefined,
} as const

interface UseChatSessionOptions {
  paneId: string
  chatAreaRef: React.RefObject<ChatAreaHandle | null>
  currentModel: ModelInfo | undefined
  refetchModels: () => Promise<void>
  sessionId: string | null
  navigateToSession: (sessionId: string, directory?: string) => void
  navigateHome: () => void
}

interface LiveRetryStatus {
  sessionID: string
  attempt: number
  message: string
  next: number
}

export function useChatSession({
  paneId,
  chatAreaRef,
  currentModel,
  refetchModels,
  sessionId: routeSessionId,
  navigateToSession,
  navigateHome,
}: UseChatSessionOptions) {
  const routeStatus = useSessionStatus(routeSessionId)

  // Agents
  const [agents, setAgents] = useState<ApiAgent[]>([])
  const [selectedAgent, setSelectedAgentRaw] = useState<string>(
    () => serverStorage.get(`${STORAGE_KEY_SELECTED_AGENT}:${paneId}`, serverStore.getActiveServerId()) || '',
  )
  const [restoredContent, setRestoredContent] = useState<{ sessionId: string; content: RevertHistoryItem } | null>(null)

  const setSelectedAgent = useCallback(
    (agentName: string) => {
      setSelectedAgentRaw(agentName)
      serverStorage.set(`${STORAGE_KEY_SELECTED_AGENT}:${paneId}`, agentName, serverStore.getActiveServerId())
    },
    [paneId],
  )

  // Hooks
  const { currentDirectory } = useDirectory()
  const { createSession, sessions } = useSessionContext()
  const { sendNotification } = useNotification()

  const routeSessionIdRef = useRef(routeSessionId)

  useEffect(() => {
    routeSessionIdRef.current = routeSessionId
  }, [routeSessionId])

  /** 当前 pane 绑定的服务器（sessionId 为复合 key，split 出 serverId；home 状态跟随 active server） */
  const activeServerId = useSyncExternalStore(
    cb => serverStore.subscribe(cb),
    () => serverStore.getActiveServerId(),
    () => serverStore.getActiveServerId(),
  )
  const paneServerId = useMemo(
    () => (routeSessionId ? sessionKeyToServerId(routeSessionId) : activeServerId),
    [routeSessionId, activeServerId],
  )

  const handleMissingRouteSession = useCallback(
    (missingSessionId: string) => {
      if (routeSessionIdRef.current !== missingSessionId) return
      clearSessionRuntimeState(missingSessionId)
      navigateHome()
    },
    [navigateHome],
  )

  // 排队消息改由「发送即打断」语义承载（见 handleSend），本机不再有待发队列。
  // 仍保留 store 仅供清理历史遗留条目（sessionLifecycle 里会 clearSession）。

  const perSessionStateRaw = useSessionState(routeSessionId)
  const perSessionState = perSessionStateRaw ?? EMPTY_SESSION_STATE

  const messages = perSessionState.messages
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const isStreaming = perSessionState.isStreaming
  const sessionDirectory = perSessionState.directory
  const canUndo = perSessionState.canUndo
  const canRedo = perSessionState.canRedo
  const redoSteps = perSessionState.redoSteps
  const revertedContent = perSessionState.revertedContent
  const hasMoreHistory = perSessionState.hasMoreHistory
  const hasTrimmedHistory = perSessionState.hasTrimmedHistory
  const sessionLoadedFromSkeleton = perSessionState.loadedFromSkeleton
  const compactedAt = perSessionState.compactedAt
  const loadState = routeSessionId ? perSessionState.loadState : ('idle' as const)
  const loadError = routeSessionId ? perSessionState.loadError : undefined

  // OpenAPI SessionStatus.retry: { attempt, message, next }
  const retryStatus = useMemo<LiveRetryStatus | null>(() => {
    if (!routeSessionId || routeStatus?.type !== 'retry') return null
    return {
      sessionID: routeSessionId,
      attempt: routeStatus.attempt,
      message: routeStatus.message,
      next: routeStatus.next,
    }
  }, [routeSessionId, routeStatus])

  const isSessionBusy = useMemo(() => Boolean(routeStatus) || isStreaming, [routeStatus, isStreaming])

  const getSessionTitle = useCallback(
    (sessionId?: string) => {
      const session = sessions.find(s => s.id === sessionId)
      if (session?.title) return session.title
      if (sessionId) return i18n.t('chat:header.sessionFallback', { id: sessionId.slice(0, 6) })
      return 'OCC'
    },
    [sessions],
  )

  const buildNotificationTitle = useCallback(
    (sessionId: string | undefined, label: string) => {
      const base = getSessionTitle(sessionId)
      return `${base} - ${label}`
    },
    [getSessionTitle],
  )

  // Session family for permission polling
  const sessionFamily = useSessionFamily(routeSessionId)

  // Session Manager
  const {
    loadSession,
    loadMoreHistory,
    loadUntilMessage,
    hydrateTurn,
    requestUndo,
    commitUndo,
    handleRedo,
    handleRedoAll,
    clearRevert,
  } = useSessionManager({
    sessionId: routeSessionId,
    directory: currentDirectory,
    onSessionMissing: handleMissingRouteSession,
  })

  /**
   * 健康状态恢复 → 重新加载当前会话。
   *
   * 只在「该服务器从明确的故障态（offline/error/unauthorized）变为 online」
   * 时触发：本地 serve 短暂未就绪、或服务重启后 health 恢复，此时若当前会话
   * 正因加载失败停在错误页，自动补一次 force 加载，避免用户手动刷新。
   *
   * 健康轮询每次都会先置 checking 再落终态，因此必须忽略 checking，否则每 15s
   * 的轮询都会被误判成一次「恢复」。
   *
   * 与 SSE onReconnected 互补：onReconnected 只覆盖长连接真正断开的情况，
   * 覆盖不到「SSE 未断、只是单次 HTTP 请求失败」。
   */
  const prevHealthStatusRef = useRef<string | null>(null)
  useEffect(() => {
    const check = () => {
      const status = serverStore.getHealth(paneServerId)?.status ?? null
      // checking 是轮询的中间态，不更新基线，否则会把 offline→checking→online
      // 的恢复过程误判成「从 checking 变 online」而漏掉恢复
      if (status === 'checking') return
      const prev = prevHealthStatusRef.current
      prevHealthStatusRef.current = status
      if (status === null) return
      const recovered = prev === 'offline' || prev === 'error' || prev === 'unauthorized'
      if (!recovered || status !== 'online') return
      if (!routeSessionId || sessionKeyToServerId(routeSessionId) !== paneServerId) return
      // 只有「尚未成功加载」时才补拉，避免对已加载会话做无谓重拉
      const state = messageStore.getSessionState(routeSessionId)
      if (state?.loadState === 'loaded' && !state.isStale && state.messages.length > 0) return
      void loadSession(routeSessionId, { force: true })
    }
    check()
    return serverStore.subscribe(check)
  }, [paneServerId, routeSessionId, loadSession])

  // Permission handling
  const {
    pendingPermissionRequests,
    pendingQuestionRequests,
    setPendingPermissionRequests,
    setPendingQuestionRequests,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    refreshPendingRequests,
    resetPendingRequests,
    isReplying,
  } = usePermissionHandler(paneServerId)

  // Prevent infinite retry loops when auto-approve API calls fail
  // but the server may have already processed the request (lost response).
  const autoRetriedIdsRef = useRef(new Set<string>())

  // Message animations
  const { registerMessage, registerInputBox, animateUndo, animateRedo } = useMessageAnimation()

  // Effective directory (used in multiple places)
  const effectiveDirectory = sessionDirectory || currentDirectory

  const fullAutoMode = useSyncExternalStore(
    cb => autoApproveStore.onFullAutoChange(cb),
    () => autoApproveStore.getPaneFullAutoMode(paneId),
  )
  const approvePendingOnFullAuto = useSyncExternalStore(
    autoApproveStore.subscribe,
    () => autoApproveStore.approvePendingOnFullAuto,
  )

  const replyPermissionOnceAutomatically = useCallback(
    (request: ApiPermissionRequest) => {
      if (!autoApproveStore.claimAutoReply(request.id)) return

      void handlePermissionReply(request.id, 'once', effectiveDirectory, request.sessionID).then(success => {
        if (!success) {
          autoApproveStore.releaseAutoReply(request.id)
          // Retry once on failure. handlePermissionReply already retries 3× via withRetry,
          // but the server may have processed the request and the response was lost.
          // Force effect re-run by creating a new array reference.
          if (!autoRetriedIdsRef.current.has(request.id)) {
            autoRetriedIdsRef.current.add(request.id)
            setPendingPermissionRequests(prev => [...prev])
          }
        }
      })
    },
    [effectiveDirectory, handlePermissionReply, setPendingPermissionRequests],
  )

  // Clear retry tracking on each auto-approve batch
  useEffect(() => {
    autoRetriedIdsRef.current.clear()
  }, [approvePendingOnFullAuto, fullAutoMode])

  useEffect(() => {
    if (!routeSessionId || !approvePendingOnFullAuto || fullAutoMode !== 'session') return
    void refreshPendingRequests(sessionFamily, effectiveDirectory)
  }, [
    approvePendingOnFullAuto,
    effectiveDirectory,
    fullAutoMode,
    refreshPendingRequests,
    routeSessionId,
    sessionFamily,
  ])

  useEffect(() => {
    if (!approvePendingOnFullAuto || fullAutoMode === 'off' || pendingPermissionRequests.length === 0) return

    for (const request of pendingPermissionRequests) {
      replyPermissionOnceAutomatically(request)
    }
  }, [approvePendingOnFullAuto, fullAutoMode, pendingPermissionRequests, replyPermissionOnceAutomatically])

  const buildLocalQueuedMessage = useCallback(
    (input: {
      sessionId: string
      messageId: string
      text: string
      attachments: Attachment[]
      agent?: string
      model: { providerID: string; modelID: string; variant?: string }
      createdAt: number
    }): UIMessage => {
      const content: UIMessage['content'] = [
        {
          id: `${input.messageId}:text`,
          type: 'text',
          text: input.text,
          synthetic: false,
          sessionID: input.sessionId,
          messageID: input.messageId,
        },
      ]

      const attachments: Attachment[] = []
      for (const attachment of input.attachments) {
        if (attachment.type === 'agent' || attachment.type === 'file' || attachment.type === 'folder') {
          attachments.push(attachment)
        }
      }

      return {
        info: {
          id: input.messageId,
          sessionID: input.sessionId,
          role: 'user',
          time: { created: input.createdAt },
          agent: input.agent || '',
          model: input.model,
          attachments,
        },
        content,
        isStreaming: false,
      }
    },
    [],
  )

  // ============================================
  // SSE 事件回调（permission / question / scroll / idle / error / reconnect）
  // 每个 pane 都注册自己的 consumer，由 App 顶层统一建立 SSE 连接
  // ============================================
  const sseCallbacks = useMemo(
    () => ({
      onPermissionAsked: (request: import('../api').ApiPermissionRequest) => {
        // Full Auto 会话级：当前 session 的 handler 天然只处理当前 session 的请求
        const effectiveFullAutoMode = autoApproveStore.getPaneFullAutoMode(paneId)
        if (effectiveFullAutoMode === 'session') {
          replyPermissionOnceAutomatically(request)
          return
        }

        // 自动批准检查（实验性功能）
        if (
          autoApproveStore.enabled &&
          autoApproveStore.shouldAutoApprove(request.sessionID, request.permission, request.patterns)
        ) {
          // 匹配规则，自动用 once 批准，不弹框
          replyPermissionOnceAutomatically(request)
          return
        }

        setPendingPermissionRequests(prev => {
          if (prev.some(r => r.id === request.id)) return prev
          return [...prev, request]
        })

        // 页面不在前台时通知用户有权限请求等待批准
        const permDesc = request.patterns?.length ? `${request.permission}: ${request.patterns[0]}` : request.permission
        const title = buildNotificationTitle(request.sessionID, i18n.t('chat:notification.permissionRequired'))
        if (notificationEventSettingsStore.isSystemEnabled('permission')) {
          sendNotification(title, permDesc, {
            sessionId: request.sessionID,
            directory: effectiveDirectory,
          })
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onPermissionReplied: (data: { sessionID: string; requestID: string }) => {
        setPendingPermissionRequests(prev =>
          prev.some(r => r.id === data.requestID) ? prev.filter(r => r.id !== data.requestID) : prev,
        )
      },
      onQuestionAsked: (request: import('../api').ApiQuestionRequest) => {
        setPendingQuestionRequests(prev => {
          if (prev.some(r => r.id === request.id)) return prev
          return [...prev, request]
        })

        // 页面不在前台时通知用户有问题等待回答
        const questionDesc = request.questions?.[0]?.header || i18n.t('chat:notification.aiWaitingForInput')
        const title = buildNotificationTitle(request.sessionID, i18n.t('chat:notification.question'))
        if (notificationEventSettingsStore.isSystemEnabled('question')) {
          sendNotification(title, questionDesc, {
            sessionId: request.sessionID,
            directory: effectiveDirectory,
          })
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onQuestionReplied: (data: { sessionID: string; requestID: string }) => {
        setPendingQuestionRequests(prev => prev.filter(r => r.id !== data.requestID))
      },
      onQuestionRejected: (data: { sessionID: string; requestID: string }) => {
        setPendingQuestionRequests(prev => prev.filter(r => r.id !== data.requestID))
      },
      onScrollRequest: () => {
        chatAreaRef.current?.scrollToBottomIfAtBottom()
      },
      onSessionIdle: (sessionID: string) => {
        // 页面不在前台时发送浏览器通知
        const title = buildNotificationTitle(sessionID, i18n.t('chat:notification.sessionCompleted'))
        if (notificationEventSettingsStore.isSystemEnabled('completed')) {
          sendNotification(title, i18n.t('chat:notification.sessionCompleted'), {
            sessionId: sessionID,
            directory: effectiveDirectory,
          })
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onSessionCompacted: (data: import('../types/api/event').SessionCompactedPayload) => {
        // 压缩改写了历史（摘要 + 裁剪旧轮次），强制重拉当前会话，
        // 否则界面仍显示压缩前的完整历史，看不到「历史已压缩」分隔。
        //
        // 只在 completed 时重拉：started 也会走这个回调（压缩 part 开始时没有
        // tail_start_id），压缩进行中反复重拉既浪费又会打断滚动位置。
        if (data.status !== 'completed') return
        if (routeSessionId) void loadSession(routeSessionId, { force: true })
      },
      onSessionError: (sessionID: string) => {
        // 页面不在前台时通知用户 session 出错
        const title = buildNotificationTitle(sessionID, i18n.t('chat:notification.sessionError'))
        if (notificationEventSettingsStore.isSystemEnabled('error')) {
          sendNotification(title, i18n.t('chat:notification.sessionError'), {
            sessionId: sessionID,
            directory: effectiveDirectory,
          })
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onReconnected: (reason: 'network' | 'server-switch', reconnectedServerId: string) => {
        // 重连按 serverId 独立：只处理该服务器的缓存，其它服务器不受影响。
        // 此前是无差别 markAllSessionsStale，导致任一台服务器抖动/切换都会让
        // 全部会话缓存作废，切回任何会话都要重新拉取。
        //
        // server-switch 是主动强制的断开重连（连接从未真正中断），期间不会丢事件，
        // 因此不必失效缓存；只有 network 重连（真实断线）才可能遗漏事件。
        const isNetworkReconnect = reason === 'network'

        if (isNetworkReconnect) {
          messageStore.markServerSessionsStale(reconnectedServerId)

          if (routeSessionId && sessionKeyToServerId(routeSessionId) === reconnectedServerId) {
            // 断线期间可能丢事件，强制覆盖补齐
            loadSession(routeSessionId, { force: true })
            refreshPendingRequests(sessionFamily, effectiveDirectory)
          }
        }

        // 模型/agents 是服务器级资源：只有当前 pane 就绑在这台服务器时才刷新，
        // 避免切换服务器时对所有 pane 重复拉取。
        if (paneServerId === reconnectedServerId) {
          refetchModels().catch(() => {})
          getSelectableAgents(currentDirectory, paneServerId)
            .then(setAgents)
            .catch(() => {})
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable functions
    [
      paneId,
      effectiveDirectory,
      routeSessionId,
      sessionFamily,
      currentDirectory,
      replyPermissionOnceAutomatically,
      setPendingPermissionRequests,
      setPendingQuestionRequests,
      buildNotificationTitle,
      sendNotification,
      loadSession,
      refreshPendingRequests,
      refetchModels,
    ],
  )

  // 保存 callbacks ref 供 consumer 注册使用（避免频繁重新注册）
  const sseCallbacksRef = useRef(sseCallbacks)
  useEffect(() => {
    sseCallbacksRef.current = sseCallbacks
  }, [sseCallbacks])

  // 注册 pane 级 consumer，SSE 事件按 sessionId 分发到此
  useEffect(() => {
    const unregister = registerSessionConsumer(paneId, routeSessionId, {
      onPermissionAsked: req => sseCallbacksRef.current.onPermissionAsked(req),
      onPermissionReplied: data => sseCallbacksRef.current.onPermissionReplied(data),
      onQuestionAsked: req => sseCallbacksRef.current.onQuestionAsked(req),
      onQuestionReplied: data => sseCallbacksRef.current.onQuestionReplied(data),
      onQuestionRejected: data => sseCallbacksRef.current.onQuestionRejected(data),
      onScrollRequest: () => sseCallbacksRef.current.onScrollRequest(),
      onSessionIdle: sid => sseCallbacksRef.current.onSessionIdle(sid),
      onSessionCompacted: data => sseCallbacksRef.current.onSessionCompacted?.(data),
      onSessionError: sid => sseCallbacksRef.current.onSessionError(sid),
      onReconnected: (reason, serverId) => sseCallbacksRef.current.onReconnected(reason, serverId),
    })

    return unregister
  }, [paneId, routeSessionId])

  // sessionId 变化时更新 consumer 关注的 session（无需重新注册）
  useEffect(() => {
    updateConsumerSessionId(paneId, routeSessionId)
  }, [paneId, routeSessionId])

  const handleVisibleMessageIdsChange = useCallback((_ids: string[]) => {
    // No-op: parts are always in memory now
  }, [])

  // Load agents
  useEffect(() => {
    getSelectableAgents(currentDirectory, paneServerId)
      .then(setAgents)
      .catch(err => handleError('fetch agents', err))
    // paneServerId 必须入依赖：切换主机后 agent 清单可能完全不同，
    // 漏掉它会让面板继续显示上一台主机的 agent。
  }, [currentDirectory, paneServerId])

  // Preload @ root directory and / commands for current session directory
  //
  // 这两个预取都只在「用户真的要用 @ 提及或 / 命令」时才需要，但它们不小
  // （实测 /file?path=. 约 6KB、/command 约 369KB），且经隧道时每个请求约 1.1s
  // 固定往返。若在会话打开时立刻发出，会和消息拉取抢同一条隧道的并发额度，
  // 把首屏往后推。
  //
  // 因此推迟到首屏渲染完成之后（用 requestIdleCallback 让出主线程，退化为
  // setTimeout）。预取仍然发生，只是不再挡在首屏前面。
  useEffect(() => {
    if (!routeSessionId || !effectiveDirectory) return

    let cancelled = false
    const run = () => {
      if (cancelled) return
      prefetchRootDirectory(effectiveDirectory, paneServerId).catch(() => {})
      prefetchCommands(effectiveDirectory, paneServerId).catch(() => {})
    }

    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
      .requestIdleCallback
    let handle: number
    if (typeof idle === 'function') {
      handle = idle(run, { timeout: 2000 })
    } else {
      handle = globalThis.setTimeout(run, 300) as unknown as number
    }

    return () => {
      cancelled = true
      const cancelIdle = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback
      if (typeof cancelIdle === 'function') cancelIdle(handle)
      else globalThis.clearTimeout(handle)
    }
    // paneServerId 入依赖：切换主机后需要对新主机重新预取
  }, [routeSessionId, effectiveDirectory, paneServerId])

  // agents 列表加载后，校验当前选中的 agent 是否存在于列表中
  useEffect(() => {
    if (agents.length === 0) return
    const primaryAgents = agents.filter(a => a.mode !== 'subagent' && !a.hidden)
    if (primaryAgents.length === 0) return

    // 当前选中的 agent 在列表中存在就不动
    if (selectedAgent && primaryAgents.some(a => a.name === selectedAgent)) return

    // 否则选第一个 primary agent
    const frameId = requestAnimationFrame(() => {
      setSelectedAgent(primaryAgents[0].name)
    })

    return () => cancelAnimationFrame(frameId)
  }, [agents, selectedAgent, setSelectedAgent])

  // Load child sessions and pending permissions on session change
  // 页面刷新时 childSessionStore 是空的，需要先从 API 恢复子 session 关系
  // 然后再加载权限请求（包括子 session 的权限）
  //
  // D10：清空 pending 的 effect 只依赖 routeSessionId，与「加载 family 权限」的
  // effect 分开。此前 reset 与加载同在一个 effect 里、依赖含 effectiveDirectory，
  // 而 effectiveDirectory = sessionDirectory || currentDirectory，会话刚打开时
  // sessionDirectory 先空后回填，导致 effect 二次执行、把两次之间经 SSE 到达的
  // 当前会话请求误清。
  useEffect(() => {
    resetPendingRequests()
  }, [routeSessionId, resetPendingRequests])

  useEffect(() => {
    if (!routeSessionId) {
      return
    }

    let cancelled = false

    async function loadChildSessionsAndPermissions() {
      // 子会话关系与待处理请求**互不依赖**，必须并行。
      //
      // 原实现把 getSessionChildren 串行 await 掉，才开始拉 permissions/questions：
      // 经网关时每次新建隧道要 700-900ms 反向握手，这一串行就多付一个完整往返。
      // 打开会话时这类串行叠加正是「要等十几秒」的主要来源。
      //
      // 另外 useGlobalEvents 的 fetchActiveScopeData 已经在拉同一份全局
      // permissions/questions；两处都会命中 microCache，因此这条路径几乎不额外
      // 产生网络请求，纯粹是「别让它挡住别的请求」。
      const needsChildren = childSessionStore.getChildSessionIds(routeSessionId!).length === 0

      const childrenPromise = needsChildren
        ? getSessionChildren(routeSessionId!, effectiveDirectory, paneServerId).catch(() => [])
        : Promise.resolve([])

      const requestsPromise = Promise.all([
        getPendingPermissions(undefined, effectiveDirectory, paneServerId).catch(() => []),
        getPendingQuestions(undefined, effectiveDirectory, paneServerId).catch(() => []),
      ])

      // 先等子会话（需要它才能算出 family），但请求已经同时在飞了。
      const children = await childrenPromise
      if (cancelled) return
      for (const child of children) {
        // 刷新后拉回的是历史会话，可能早已结束——不能让它们默认成「正在工作」。
        // 依据服务端的实时状态判断：busy/retry 才算运行中，其余一律视为已完成。
        const childKey = makeSessionKey(paneServerId, child.id)
        const status = activeSessionStore.getSessionStatus(childKey)
        const running = status?.type === 'busy' || status?.type === 'retry'
        childSessionStore.registerChildSession(child, paneServerId, running ? 'running' : 'idle')
      }

      // Step 2: 获取完整的 session family（主 session + 所有子孙）
      const family = new Set(childSessionStore.getSessionAndDescendants(routeSessionId!))
      // family 是复合 key；API 返回的 sessionID 是原始 id，兼容两种形式比较
      const familyRaw = new Set([...family].map(k => splitSessionKey(k).sessionId))
      const matchesFamily = (rawSessionId: string) =>
        familyRaw.has(rawSessionId) || familyRaw.has(splitSessionKey(rawSessionId).sessionId)

      // Step 3: 取待处理请求（与子会话并发，此处只是收口）
      // GET /permission 和 GET /question 返回全量数据，不传 sessionId 避免 N 次重复请求
      const [allPerms, allQuestions] = await requestsPromise

      if (cancelled) return

      // 只保留属于当前 session family 的请求。
      // OMO background subagents may publish permission.asked over SSE before
      // /permission can list it for this routed instance. Refresh 时序下子 session 关系
      // 可能尚未注册（family 不含子 session），因此 SSE 已知请求必须无条件保留，
      // 否则刷新后子任务的权限弹窗会被 family 过滤误删。
      const nextPerms = allPerms.filter(p => matchesFamily(p.sessionID))
      setPendingPermissionRequests(prev => {
        const merged = new Map(nextPerms.map(p => [p.id, p]))
        for (const request of prev) {
          if (!merged.has(request.id)) merged.set(request.id, request)
        }
        return Array.from(merged.values())
      })
      setPendingQuestionRequests(prev => {
        const merged = new Map(allQuestions.filter(q => matchesFamily(q.sessionID)).map(q => [q.id, q]))
        for (const q of prev) {
          if (!merged.has(q.id)) merged.set(q.id, q)
        }
        return Array.from(merged.values())
      })
    }

    loadChildSessionsAndPermissions()

    return () => {
      cancelled = true
    }
  }, [routeSessionId, effectiveDirectory, paneServerId, setPendingPermissionRequests, setPendingQuestionRequests])

  const sendMessageNow = useCallback(
    async (input: {
      sessionId?: string | null
      content: string
      attachments: Attachment[]
      directory: string
      model: { providerID: string; modelID: string }
      options?: { agent?: string; variant?: string }
      allowCreateSession?: boolean
      /**
       * 发送前先终止当前正在进行的轮次（用户语义：我发了新消息，旧的就该停）。
       *
       * v2 实测：`interrupt` 返回 200 后立刻 `prompt` 完全可用（11ms，
       * 事件顺序 interrupted → started → 新消息 delivered），服务端会先落定旧轮次
       * 再开始新的。因此这里不需要等 idle 事件再发，串行两个请求即可。
       */
      interruptCurrentTurn?: boolean
    }) => {
      let sessionId = input.sessionId ?? routeSessionId

      if (sessionId && input.allowCreateSession) {
        const state = messageStore.getSessionState(sessionId)
        if (state?.loadState === 'error' && state.messages.length === 0) {
          clearSessionRuntimeState(sessionId)
          sessionId = null
        }
      }

      let rollbackSnapshot = sessionId ? messageStore.createSendRollbackSnapshot(sessionId) : null
      let optimisticMessageId: string | null = null

      try {
        if (!sessionId) {
          if (!input.allowCreateSession) return false
          // 必须把 pane 绑定的服务器传下去：SessionContext.createSession 原先只
          // 用「活动服务器」，于是在 pane 绑着 A 主机、而活动服务器已被切到 B 时，
          // 新会话会建到 B 上（并把这条消息发到 B）——正是「刚发出就切服务器，
          // 消息跑到新服务器、旧服务器没发出去」的根因。
          const newSession = await createSession(undefined, input.directory, paneServerId)
          sessionId = newSession.id
          navigateToSession(sessionId, newSession.directory)
        }

        if (rollbackSnapshot) {
          messageStore.truncateAfterRevert(sessionId)
        }

        // SSE 是最终事实来源，但可能在请求返回后才到达；先显示用户输入，
        // 让新建会话和网络抖动时的发送反馈保持即时。
        // 用 opencode 的 message id 格式（msg 开头）：服务端 prompt 会复用该 id
        // （input.messageID ?? ascending()），使乐观消息与 canonical 消息共用同一 id，
        // 靠 id 精确替换而非文本匹配，避免出现重复的两条用户消息。
        optimisticMessageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`
        messageStore.upsertLocalMessage(
          buildLocalQueuedMessage({
            sessionId,
            messageId: optimisticMessageId,
            text: input.content,
            attachments: input.attachments,
            agent: input.options?.agent,
            model: input.model,
            createdAt: Date.now(),
          }),
          input.directory,
        )
        // 基线在乐观消息之后取，兜底回拉仍能识别服务端的 canonical user message。
        const msgCountBeforeSend = messageStore.getSessionState(sessionId)?.messages.length ?? 0

        // 不要在 send 前 setStreaming：新 user 往往还没入列，过程折叠会把
        // 「上一轮已收工」误判成最新 Working 再展开，造成一闪。
        // streaming 在 send 成功后、或 SSE 推到 assistant 时再打开。
        // D7：记录发送前的结束世代，await 返回后比对——若本轮在请求返回前已 idle，
        // 不再置 streaming，避免永久 Working。
        const idleGenerationBeforeSend = messageStore.getIdleGeneration(sessionId)
        // 本地乐观置忙：请求往返期间侧栏/项目行立即显示「运行中」，停止按钮也可用。
        // 服务端 status 到达后会转成「有佐证」；若这一轮根本没跑起来，超时自动回收。
        activeSessionStore.applyOptimisticBusy(sessionId)

        // 「发新消息 = 终止旧轮次」。
        //
        // 先 abort 再 prompt，而不是靠 delivery=steer 去挤：steer 是把新消息插进
        // 正在跑的轮次，旧回复会继续往下写；用户要的是「这条新消息取代旧的」。
        //
        // 两步都必须是同一台主机（paneServerId）。abort 失败不阻断发送：最坏情况
        // 是新消息排队到旧轮次之后，比「消息发不出去」好得多。
        //
        // 顺序不能并行：prompt 若先到，服务端会把它排进旧轮次（steer），旧回复仍会
        // 继续写。所以这里必须等 abort 返回。好在 abort 本身很轻（实测 7ms，隧道下
        // 约 1 个往返），而「本地立刻落定」让用户不会看到旧回复继续闪。
        //
        // ⚠️ 中止前先把**前台阻塞的工具**转入后台（`session.background`）。
        // 直接 abort 会把正在跑的命令一起杀掉：实测用户反复打断一个 26 分钟
        // timeout 的 `cargo test`，四次中断全部把进程杀死，测试永远跑不完，
        // 用户看到的就是「一直卡住 → 再打断 → 又卡住」的死循环。
        // 转后台后命令继续跑、结果由完成通知带回，会话也能立刻接受新消息。
        // 空闲会话上这个调用是 no-op，没有副作用。
        if (input.interruptCurrentTurn) {
          // 本地立刻落定：不等 HTTP 往返，否则用户点了发送后旧回复还会继续闪。
          activeSessionStore.updateStatus(sessionId, { type: 'idle' })
          messageStore.handleSessionIdle(sessionId)
          try {
            await backgroundSessionTools(sessionId, input.directory, paneServerId)
          } catch (error) {
            // 旧服务端可能没有这个端点：退回「直接 abort」，行为与之前一致
            logger.warn('[send] move foreground tools to background failed', error)
          }
          try {
            await abortSession(sessionId, input.directory, paneServerId)
          } catch (error) {
            logger.warn('[send] interrupt before send failed', error)
          }
        }

        await sendMessageAsync(
          {
            sessionId,
            text: input.content,
            attachments: input.attachments,
            model: input.model,
            agent: input.options?.agent,
            variant: input.options?.variant,
            directory: input.directory,
            messageID: optimisticMessageId,
            // 显式声明投递语义，不依赖服务端默认值。
            //
            // 实测（opencode v2.0.32，源码 packages/core/src/session/prompt.ts:50）：
            //   `delivery: request.input.delivery ?? "steer"`
            // 也就是**默认就是 steer**。steer 的语义是：
            //   - session 空闲时：立即开始执行（实测 3s 内出结果）；
            //   - session 忙碌时：入队，在**下一个 step 边界**注入上下文，
            //     不会打断当前正在跑的工具/模型请求（实测 12s 的 sleep 跑完后
            //     才处理新消息）。
            //
            // 我们在忙碌时已经先 abort 了（用户要的是「新消息取代旧轮次」），
            // 所以这里必然走「空闲 → 立即执行」。显式写出来是为了：
            //   1. 服务端未来改默认值时行为不漂移；
            //   2. 读代码的人不必去翻服务端实现才知道语义。
            delivery: 'steer',
          },
          paneServerId,
        )

        messageStore.setStreaming(sessionId, true, idleGenerationBeforeSend)

        // 兜底：等待短暂时间后检查 SSE 是否已推送用户消息，
        // 若未收到则主动拉取补齐，避免 SSE 断流导致用户消息不显示
        const pullSessionId = sessionId
        const pullDir = input.directory
        setTimeout(() => {
          const state = messageStore.getSessionState(pullSessionId)
          if (!state) return
          // 消息数量增加了，说明 SSE 已正常推送
          if (state.messages.length > msgCountBeforeSend) return

          getSessionMessages(pullSessionId, 5, pullDir, paneServerId)
            .then(apiMessages => {
              for (const msg of apiMessages) {
                messageStore.handleMessageUpdated(msg.info)
                if (msg.parts) {
                  for (const part of msg.parts) {
                    messageStore.handlePartUpdated({
                      ...part,
                      sessionID: pullSessionId,
                      messageID: msg.info.id,
                    })
                  }
                }
              }
            })
            .catch(() => {
              // 拉取失败不影响主流程，SSE 重连后仍可补齐
            })
        }, 250)

        return true
      } catch (error) {
        handleError('send message', error)
        if (sessionId) {
          if (optimisticMessageId) messageStore.removeMessage(sessionId, optimisticMessageId)
          if (rollbackSnapshot) {
            messageStore.restoreSendRollback(sessionId, rollbackSnapshot)
            rollbackSnapshot = null
          } else {
            messageStore.setStreaming(sessionId, false)
          }
          // 发送失败：回收本地乐观的「运行中」，否则会话会一直显示在跑
          activeSessionStore.updateStatus(sessionId, { type: 'idle' })
        }

        return false
      }
    },
    [routeSessionId, navigateToSession, createSession, paneServerId, buildLocalQueuedMessage],
  )

  // Send message handler
  const handleSend = useCallback(
    async (content: string, attachments: Attachment[], options?: { agent?: string; variant?: string }) => {
      if (!currentModel) {
        handleError('send message', new Error('No model selected'))
        return false
      }

      // 发送新消息 = 终止当前轮次，然后用这条新消息重新开始。
      //
      // 这是用户明确要的语义：不要让旧回复继续跑，也不要把新消息排到队列里等。
      // 旧实现把这类消息塞进本机队列（id 为 `queued_*`，服务端不知道它存在），
      // 于是刷新就丢、别的端也看不到 —— 那是「吞消息」的来源之一。
      //
      // 现在：先在服务端 abort 当前轮次（实测 abort 返回后立刻 prompt 完全可用，
      // 服务端会先落定旧轮次再开始新的），再发这条消息。
      const shouldInterrupt = !!routeSessionId && isSessionBusy

      return sendMessageNow({
        sessionId: routeSessionId,
        content,
        attachments,
        model: {
          providerID: currentModel.providerId,
          modelID: currentModel.id,
        },
        options,
        directory: effectiveDirectory || '',
        allowCreateSession: true,
        interruptCurrentTurn: shouldInterrupt,
      })
    },
    [currentModel, routeSessionId, isSessionBusy, effectiveDirectory, sendMessageNow],
  )

  // 排队消息已改由服务端承载（prompt delivery=queue），本机不再有「待发队列」，
  // 因此既不需要 sendQueuedFollowup，也不需要「忙转闲时自动发出队头」的 effect：
  // 服务端会在当前轮次结束后自行读取队列里的下一条。
  //
  // 这样还顺带修掉一个跨端不一致：本地队列里 `queued_*` 的消息在其它端不存在，
  // 让两端看到不同的「待发」状态。

  // New chat handler
  const handleNewChat = useCallback(() => {
    if (routeSessionId) {
      followupQueueStore.clearSession(routeSessionId)
      if (!hasOtherConsumerForSession(routeSessionId, paneId)) {
        messageStore.clearSession(routeSessionId)
      }
    }
    resetPendingRequests()
  }, [routeSessionId, paneId, resetPendingRequests])

  const handleForkMessage = useCallback(
    async (message: UIMessage, forkMessageId?: string) => {
      const targetMessageId = forkMessageId || message.info.id

      try {
        if (message.info.role === 'assistant') {
          const assistantInfo = message.info as AssistantMessageInfo
          // 后端 fork 语义：messageID 指定的消息**不包含**在新 session 里。
          // 要保留这条 assistant 回复，需要传它之后的下一条用户消息 ID；
          // 如果它已经是最末尾，不传 messageID，fork 整个 session。
          const currentMessages = messagesRef.current
          const idx = currentMessages.findIndex(m => m.info.id === targetMessageId)
          let forkAtMessageId: string | undefined
          if (idx >= 0) {
            for (let i = idx + 1; i < currentMessages.length; i++) {
              if (currentMessages[i].info.role === 'user') {
                forkAtMessageId = currentMessages[i].info.id
                break
              }
            }
          }
          const forkedSession = await forkSession(
            assistantInfo.sessionID,
            forkAtMessageId,
            effectiveDirectory,
            paneServerId,
          )
          setRestoredContent(null)
          navigateToSession(forkedSession.id, forkedSession.directory)
          return
        }

        if (message.info.role !== 'user') return

        if (!isUserMessage(message.info)) return

        const userInfo = message.info
        const content = extractUserMessageContent(message)
        const forkedSession = await forkSession(userInfo.sessionID, targetMessageId, effectiveDirectory, paneServerId)

        setRestoredContent({
          sessionId: forkedSession.id,
          content: {
            messageId: userInfo.id,
            text: content.text,
            attachments: content.attachments,
            model: userInfo.model,
            variant: userInfo.model.variant,
            agent: userInfo.agent,
          },
        })

        navigateToSession(forkedSession.id, forkedSession.directory)
      } catch (error) {
        handleError('fork session', error)
      }
    },
    [effectiveDirectory, navigateToSession, paneServerId],
  )

  // Abort handler
  const handleAbort = useCallback(async () => {
    if (!routeSessionId) return
    // 乐观置 idle：abort 是 HTTP 请求，服务端不一定立刻补推 session.status。
    // 只清 messageStore 清不掉 activeSessionStore 里的 status，
    // 而 isSessionBusy 由它主导——按钮点了像没反应就是这里空窗。
    // 真正的服务端 status 到达后会覆盖本次本地值。
    //
    // 两处必须一起做：
    //   1. activeSessionStore → idle（按钮/侧栏立即停止转圈）
    //   2. messageStore.handleSessionIdle → 定稿流式消息、落定悬空工具
    // 第 2 步还会抬高 idleGeneration，使「发送请求返回后置 streaming」的兜底
    // 逻辑不会把刚停下的会话重新点亮。
    activeSessionStore.updateStatus(routeSessionId, { type: 'idle' })
    messageStore.handleSessionIdle(routeSessionId)
    const directory = sessionDirectory || currentDirectory
    try {
      await abortSession(routeSessionId, directory, paneServerId)
    } catch (error) {
      handleError('abort session', error)
      // 取消失败：拉一次服务端状态并合并，让服务端重新成为唯一依据，
      // 避免本地乐观置的 idle 掩盖真实的运行中状态。
      getSessionStatus(directory, paneServerId)
        .then(statusMap => activeSessionStore.mergeStatusRefresh(statusMap))
        .catch(() => {})
    }
  }, [routeSessionId, sessionDirectory, currentDirectory, paneServerId])

  // Command handler (slash commands)
  const handleCommand = useCallback(
    async (commandStr: string) => {
      // 解析命令："/help arg1 arg2" => command="help", args="arg1 arg2"
      const trimmed = commandStr.trim()
      const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
      const spaceIndex = withoutSlash.indexOf(' ')
      const command = spaceIndex > 0 ? withoutSlash.slice(0, spaceIndex) : withoutSlash
      const args = spaceIndex > 0 ? withoutSlash.slice(spaceIndex + 1) : ''

      if (!command) return false

      if (command === 'new') {
        navigateHome()
        handleNewChat()
        return true
      }

      let sessionId = routeSessionId

      try {
        if (sessionId) {
          const state = messageStore.getSessionState(sessionId)
          if (state?.loadState === 'error' && state.messages.length === 0) {
            clearSessionRuntimeState(sessionId)
            sessionId = null
          }
        }

        // Create session if needed (like handleSend does)
        if (!sessionId) {
          // 同 sendMessageNow：带上 pane 的目录与服务器，避免建到活动服务器上。
          const newSession = await createSession(undefined, effectiveDirectory || undefined, paneServerId)
          sessionId = newSession.id
          navigateToSession(sessionId, newSession.directory)
        }

        if (command === 'compact') {
          if (!currentModel) {
            handleError('execute command', new Error('No model selected'))
            return false
          }

          // 命令也可能启动一轮生成（如 /compact 之后继续、自定义命令模板）：
          // 同样先本地乐观置忙；纯本地命令（不发消息）不会被任何事件佐证，超时后自动回收。
          activeSessionStore.applyOptimisticBusy(sessionId)

          // Commands should count as sent once they are accepted for execution.
          // Do not keep the draft alive until the long-running compaction finishes.
          void summarizeSession(
            sessionId,
            { providerID: currentModel.providerId, modelID: currentModel.id },
            effectiveDirectory,
            paneServerId,
          ).catch(err => {
            handleError('execute command', err)
            // 失败回收乐观 busy：压缩没跑起来，不应让项目行一直显示运行中
            if (sessionId) activeSessionStore.updateStatus(sessionId, { type: 'idle' })
          })

          return true
        }

        // Keep command submission semantics aligned with normal messages:
        // once the command is dispatched, clear the draft immediately.
        void executeCommand(sessionId, command, args, effectiveDirectory, paneServerId).catch(err => {
          handleError('execute command', err)
          if (sessionId) activeSessionStore.updateStatus(sessionId, { type: 'idle' })
        })

        return true
      } catch (err) {
        handleError('execute command', err)
        if (sessionId) activeSessionStore.updateStatus(sessionId, { type: 'idle' })
        return false
      }
    },
    [
      routeSessionId,
      effectiveDirectory,
      createSession,
      navigateToSession,
      currentModel,
      navigateHome,
      handleNewChat,
      paneServerId,
    ],
  )

  // Undo with animation
  const handleUndoWithAnimation = useCallback(
    async (userMessageId: string) => {
      const currentMessages = messagesRef.current
      const messageIndex = currentMessages.findIndex(m => m.info.id === userMessageId)
      if (messageIndex === -1) return

      const messageIdsToRemove = currentMessages.slice(messageIndex).map(m => m.info.id)

      // 网络请求与淡出动画并行：原来先 await 动画再发请求，两段耗时叠加，
      // 体感就是「点了以后要等一下才开始」。并行后总耗时约为二者较大者。
      //
      // 另外要「先落状态、再等网络」：requestUndo 成功返回后才 commit 的话，
      // 网络慢时动画放完了界面却还停在原样，用户以为没生效（这就是「重编辑延迟
      // 好大」的直接来源）。这里用本地已知信息立即构造 revertState 提交，
      // 服务端返回后用它的 revert 点做一次校正；失败则回滚。
      const history = currentMessages
        .slice(messageIndex)
        .filter(m => isUserMessage(m.info))
        .map(m => {
          const content = extractUserMessageContent(m)
          const userInfo = m.info as import('../types/message').UserMessageInfo
          return {
            messageId: m.info.id,
            text: content.text,
            attachments: content.attachments,
            model: userInfo.model,
            variant: userInfo.model.variant,
            agent: userInfo.agent,
          }
        })
      const optimisticRevert = { messageId: userMessageId, history }
      commitUndo(optimisticRevert)

      const undoRequest = requestUndo(userMessageId)
      await animateUndo(messageIdsToRemove)
      const revertState = await undoRequest
      if (revertState) {
        // 服务端确认：用权威 revert 点覆盖（历史条目可能因并发编辑而不同）
        commitUndo(revertState)
      } else {
        // 失败：撤销本地乐观状态，避免界面显示「已撤销」而服务端并未回退
        clearRevert()
      }
    },
    [animateUndo, requestUndo, commitUndo, clearRevert],
  )

  // Redo with animation
  const handleRedoWithAnimation = useCallback(async () => {
    await animateRedo()
    await handleRedo()
  }, [animateRedo, handleRedo])

  // Session selection
  const handleSelectSession = useCallback(
    (session: ApiSession) => {
      navigateToSession(session.id, session.directory)
    },
    [navigateToSession],
  )

  // New session
  const handleNewSession = useCallback(() => {
    navigateHome()
    handleNewChat()
  }, [navigateHome, handleNewChat])

  // Archive current session
  const handleArchiveSession = useCallback(async () => {
    if (!routeSessionId) return
    try {
      await updateSession(routeSessionId, { time: { archived: Date.now() } }, effectiveDirectory, paneServerId)
      // 归档后会话不再出现在侧栏：清掉活跃状态与通知，否则项目行/会话行会残留
      // 「运行中」标识或未读点（归档前正在跑的会话会永久留在 busy 集合）。
      activeSessionStore.removeSession(routeSessionId)
      notificationStore.removeSessionNotifications(routeSessionId)
      // 让归档视图过期：本端动作不等 SSE 回环，下次打开面板就能看到这条。
      sessionListIndexStore.invalidateArchivedView(
        paneServerId ?? serverStore.getActiveServerId(),
      )
      navigateHome()
      handleNewChat()
    } catch (error) {
      handleError('archive session', error)
    }
  }, [routeSessionId, effectiveDirectory, navigateHome, handleNewChat, paneServerId])

  // Navigate to previous session
  const handlePreviousSession = useCallback(() => {
    if (!sessions.length) return
    const currentIndex = sessions.findIndex(s => s.id === routeSessionId)
    if (currentIndex > 0) {
      const target = sessions[currentIndex - 1]
      navigateToSession(target.id, target.directory)
    } else if (currentIndex === -1 && sessions.length > 0) {
      // Not in any session, go to first
      navigateToSession(sessions[0].id, sessions[0].directory)
    }
  }, [sessions, routeSessionId, navigateToSession])

  // Navigate to next session
  const handleNextSession = useCallback(() => {
    if (!sessions.length) return
    const currentIndex = sessions.findIndex(s => s.id === routeSessionId)
    if (currentIndex >= 0 && currentIndex < sessions.length - 1) {
      const target = sessions[currentIndex + 1]
      navigateToSession(target.id, target.directory)
    }
  }, [sessions, routeSessionId, navigateToSession])

  // Toggle agent (cycle through primary agents only, matching toolbar display)
  const handleToggleAgent = useCallback(() => {
    const primaryAgents = agents.filter(a => a.mode !== 'subagent' && !a.hidden)
    if (primaryAgents.length <= 1) return
    const currentIndex = primaryAgents.findIndex(a => a.name === selectedAgent)
    const nextIndex = (currentIndex + 1) % primaryAgents.length
    setSelectedAgent(primaryAgents[nextIndex].name)
  }, [agents, selectedAgent, setSelectedAgent])

  // 从消息中恢复 agent 选择（用于切换 session 时）
  const restoreAgentFromMessage = useCallback(
    (agentName: string | null | undefined) => {
      if (!agentName) return
      // 只有当 agent 存在于列表中时才恢复
      const exists = agents.some(a => a.name === agentName && a.mode !== 'subagent' && !a.hidden)
      if (exists) {
        setSelectedAgent(agentName)
      }
    },
    [agents, setSelectedAgent],
  )

  // Copy last AI response to clipboard
  const handleCopyLastResponse = useCallback(async () => {
    const lastAssistant = [...messages].reverse().find(m => m.info.role === 'assistant')
    if (!lastAssistant) return

    const text = getMessageText(lastAssistant)
    if (text) {
      try {
        await copyTextToClipboard(text)
      } catch (err) {
        clipboardErrorHandler('copy last response', err)
      }
    }
  }, [messages])

  const clearRestoredContent = useCallback(() => {
    setRestoredContent(null)
    clearRevert()
  }, [clearRevert])

  const activeRestoredContent = useMemo(() => {
    if (!restoredContent || restoredContent.sessionId !== routeSessionId) return null
    return restoredContent.content
  }, [restoredContent, routeSessionId])

  return {
    // State
    messages,
    // UI 活跃态：对齐官方 webui 的 session_working（session.status busy/retry）
    // 不能只信 messageStore.isStreaming——多步 agent 间隙消息可能已 completed，但 session 仍 busy
    isStreaming: isSessionBusy,
    /** 消息级流式（不含 session.status）；一般 UI 用 isStreaming 即可 */
    messageIsStreaming: isStreaming,
    sessionDirectory,
    /** 会话在服务端绑定的模型（无痕/新设备靠它恢复，而不是全局默认） */
    sessionModel: perSessionState.model,
    /** 会话绑定的 agent（服务端权威） */
    sessionAgent: perSessionState.agent,
    canUndo,
    canRedo,
    redoSteps,
    revertedContent,
    restoredContent: activeRestoredContent,
    loadState,
    loadError,
    hasMoreHistory,
    hasTrimmedHistory,
    sessionLoadedFromSkeleton,
    compactedAt,
    retryStatus,
    agents,
    selectedAgent,
    setSelectedAgent,
    routeSessionId,
    effectiveDirectory,

    // Permissions
    pendingPermissionRequests,
    pendingQuestionRequests,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    isReplying,

    // Session management
    loadMoreHistory,
    loadUntilMessage,
    hydrateTurn,
    handleRedoAll,
    clearRevert: clearRestoredContent,
    /** 强制重载当前会话（用于加载失败后的“重新加载”按钮） */
    reloadSession: () => {
      if (routeSessionId) void loadSession(routeSessionId, { force: true })
    },
    /**
     * 从后台返回时补拉当前会话，并报告是否带来了新内容。
     *
     * 移动端切后台会冻结 JS（墓碑机制），期间的 SSE 事件不会被处理，
     * 而长连接靠心跳仍显示存活、不触发 onReconnected —— 所以这条路径
     * 必须自己补拉，否则界面会停在离开时那一刻。
     *
     * 返回值用于 UI 给出「已更新」反馈：对比补拉前后的消息条数，
     * 让用户知道「刚回来的这一下确实刷到了东西」。
     */
    refreshOnResume: async (): Promise<boolean> => {
      if (!routeSessionId) return false
      const before = messageStore.getSessionState(routeSessionId)?.messages.length ?? 0
      await loadSession(routeSessionId, { force: true })
      const after = messageStore.getSessionState(routeSessionId)?.messages.length ?? 0
      return after > before
    },

    // Animation
    registerMessage,
    registerInputBox,

    // Handlers
    handleSend,
    handleAbort,
    handleCommand,
    handleUndoWithAnimation,
    handleRedoWithAnimation,
    handleForkMessage,
    handleSelectSession,
    handleNewSession,
    handleVisibleMessageIdsChange,
    handleArchiveSession,
    handlePreviousSession,
    handleNextSession,
    handleToggleAgent,
    handleCopyLastResponse,
    restoreAgentFromMessage,
  }
}
