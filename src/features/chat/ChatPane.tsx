/**
 * ChatPane — The single chat surface primitive.
 *
 * Single-pane and split-pane both render ChatPane. The only difference is displayMode:
 * single mode uses the full header and app viewport, split mode uses PaneHeader and a
 * compact viewport wrapper.
 */

import { memo, useRef, useEffect, useState, useCallback, useMemo, useDeferredValue, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { ChatArea, Header, PermissionDialog, QuestionDialog, type ChatAreaHandle } from '.'
import { type ModelSelectorHandle } from './ModelSelector'
import { OutlineIndex } from '../../components/OutlineIndex'
import { LoadingState } from '../../components/ui/LoadingState'
import { Spinner } from '../../components/ui/Spinner'
import { CheckIcon } from '../../components/Icons'
import { useResumeRefresh } from '../../hooks/useResumeRefresh'
import { PaneHeader } from './PaneHeader'
import { PaneDropOverlay, resolveDropZone, type DropZone, type PaneDropOverlayHandle } from './PaneDropOverlay'
import { useFolderProjectDrop } from './useFolderProjectDrop'
import { FolderProjectDropOverlay } from './FolderProjectDropOverlay'
import {
  useChatSession,
  useModels,
  useModelSelection,
  useTurnOutlineEntries,
  useMergeTurnOutline,
  useBackfillTurnOutline,
} from '../../hooks'
import { useServerStore } from '../../hooks/useServerStore'
import { useHostSlideState } from './sidebar/hostSwitchDirection'
import { useCancelHint } from '../../hooks/useCancelHint'
import { makeSessionKey, sessionKeyToServerId, sessionKeyToSessionId } from '../../utils/sessionKey'
import { summarizeHeavyContent, formatHeavyBytes } from './heavyContent'
import { serverStore } from '../../store/serverStore'
import {
  InlineToolRequestContext,
  findUnmatchedQuestions,
  type InlineToolRequestContextValue,
} from './InlineToolRequestContext'
import { ChatViewportProvider, canUseSplitPane, useChatViewportMaybe, type ChatViewportValue } from './chatViewport'
import { ChatWidthControls } from './ChatWidthControls'
import { useChatPageViewModel } from './useChatPageViewModel'
import { PaneInputDock } from './PaneInputDock'
import { SessionNavigationContext } from '../../contexts/SessionNavigationContext'
import { useDirectory } from '../../contexts/useDirectory'
import { usesCustomDesktopTitlebar } from '../../utils/tauri'
import { paneLayoutStore } from '../../store/paneLayoutStore'
import { autoApproveStore } from '../../store/autoApproveStore'
import { messageStore, paneControllerStore, useHiddenModelKeys } from '../../store'
import { restoreModelSelection } from '../../utils/sessionHelpers'
import { findModelByKey, getModelKey } from '../../utils/modelUtils'
import { attachTodoBridge, detachTodoBridge } from '../../utils/todoSyncBridge'
import { useTheme } from '../../hooks/useTheme'
import { useWorkStatus } from '../../store/workStatusStore'
import { WorkStatusPanel } from '../workStatus/WorkStatusPanel'
import { useWorkStatusVisibility } from '../workStatus/useWorkStatusVisibility'
import { setWorkStatusPanelVisible, clearWorkStatusPanelVisible } from '../workStatus/workStatusVisibilityStore'
import type { Attachment, QuestionAnswer } from '../../api'
import type { MessageError } from '../../types/message'
import { getInternalDragSnapshot, subscribeInternalDrag, subscribeInternalDrop } from '../../lib/internalDragCore'
import { ErrorBoundary } from '../../components/ErrorBoundary'

interface ChatPaneProps {
  paneId: string
  sessionId: string | null
  isFocused: boolean
  paneCount: number
  displayMode: 'single' | 'split'
  isPaneFullscreen?: boolean
  onOpenSidebar?: () => void
  onToggleRightPanel?: () => void
  onOpenSettings?: () => void
  onOpenProject?: () => void
  showSidebarButton?: boolean
  onSplitPane?: () => void
  onTogglePaneFullscreen?: () => void
  navigatePaneToSession: (paneId: string, sessionId: string, directory?: string) => void
  navigatePaneHome: (paneId: string) => void
}

// ============================================
// Compact viewport shell for split panes.
// Layout/presentation stay fixed; enableCollapsedInputDock is inherited from the
// app viewport so the desktop "collapse input dock" setting still works in split.
// ============================================
const PANE_VIEWPORT: ChatViewportValue = {
  presentation: {
    surfaceVariant: 'compact',
    isCompact: true,
  },
  interaction: {
    mode: 'pointer',
    touchCapable: false,
    sidebarBehavior: 'overlay',
    rightPanelBehavior: 'overlay',
    bottomPanelBehavior: 'overlay',
    outlineInteraction: 'pointer',
    enableCollapsedInputDock: false,
  },
  layout: {
    viewportWidth: 800,
    viewportHeight: 600,
    surfaceWidth: 800,
    surfaceMinWidth: 380,
    sidebar: {
      railWidth: 0,
      requestedWidth: 0,
      openWidth: 0,
      dockedWidth: 0,
      overlayWidth: 0,
      hardMinWidth: 0,
      preferredMinWidth: 0,
      maxWidth: 0,
      resizeMaxWidth: 0,
    },
    rightPanel: {
      requestedWidth: 0,
      dockedWidth: 0,
      hardMinWidth: 0,
      maxWidth: 0,
      resizeMaxWidth: 0,
    },
    bottomPanel: {
      maxHeight: 0,
    },
  },
  actions: {
    setSidebarRequestedWidth: () => {},
  },
}

let splitSessionNavigationToken = 0

function scheduleSplitSessionNavigation(callback: () => void) {
  const token = ++splitSessionNavigationToken

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== splitSessionNavigationToken) return
      splitSessionNavigationToken = 0
      callback()
    })
  })
}

function cancelPendingSplitSessionNavigation() {
  if (splitSessionNavigationToken !== 0) {
    splitSessionNavigationToken += 1
  }
}

export const ChatPane = memo(function ChatPane({
  paneId,
  sessionId,
  isFocused,
  paneCount,
  displayMode,
  isPaneFullscreen = false,
  onOpenSidebar,
  onToggleRightPanel,
  onOpenSettings,
  onOpenProject,
  showSidebarButton = false,
  onSplitPane,
  onTogglePaneFullscreen,
  navigatePaneToSession,
  navigatePaneHome,
}: ChatPaneProps) {
  const { t } = useTranslation(['chat', 'common'])
  const showCompactShell = displayMode === 'split' && !isPaneFullscreen

  // Read the outer (App-level) viewport BEFORE this component's own Provider shadows it.
  // When fullscreen we pass this through so children keep the real desktop viewport;
  // in normal split mode we use the static PANE_VIEWPORT instead.
  const outerViewport = useChatViewportMaybe()
  const splitPaneEnabled = canUseSplitPane(outerViewport ?? PANE_VIEWPORT)

  // 分屏 pane 顶栏的高度是否要与侧栏 logo 区（h-11 = 2.75rem）对齐。
  // 判据必须取外层（App 级）视口：分屏时 PaneHeader 读到的是 PANE_VIEWPORT，
  // 它的 sidebarBehavior 固定为 overlay，无法区分「移动端」与「网页桌面端」。
  // Windows/macOS 桌面 pane 顶栏位于标题栏之下，移动端另有 3.5rem 顶部栏，
  // 两者都保持 2.5rem，仅网页/Linux 桌面端需要对齐。
  const alignHeaderWithSidebar =
    !usesCustomDesktopTitlebar() && (outerViewport?.interaction.sidebarBehavior ?? 'docked') !== 'overlay'

  // ============================================
  // Refs
  // ============================================
  const chatAreaRef = useRef<ChatAreaHandle>(null)
  const modelSelectorRef = useRef<ModelSelectorHandle>(null)
  const [chatContentEl, setChatContentEl] = useState<HTMLDivElement | null>(null)
  const setChatContentRef = useCallback((node: HTMLDivElement | null) => setChatContentEl(node), [])
  const { addDirectory, setCurrentDirectory } = useDirectory()

  // 当前 pane 绑定的服务器（sessionId 为复合 key，split 出 serverId；home 状态跟随 active server 实时变化）
  const activeServerId = useSyncExternalStore(
    cb => serverStore.subscribe(cb),
    () => serverStore.getActiveServerId(),
    () => serverStore.getActiveServerId(),
  )
  const paneServerId = useMemo(
    () => (sessionId ? sessionKeyToServerId(sessionId) : activeServerId),
    [sessionId, activeServerId],
  )

  // ============================================
  // Models（per-server：模型列表跟随当前 pane 绑定的服务器）
  // ============================================
  const { models, isLoading: modelsLoading, refetch: refetchModels } = useModels(paneServerId)
  const { servers, activeServer, getHealth } = useServerStore()
  const activeServerHealth = activeServer ? getHealth(activeServer.id) : null
  // 切换主机时主聊天区同样按方位平移，与侧栏项目列表方向一致。
  // switching 为真时抑制输入框停靠与欢迎层的入场过渡，避免与平移打架。
  const hostSlideState = useHostSlideState(
    useMemo(() => servers.map(server => server.id), [servers]),
    activeServerId,
  )
  const hostSlide = hostSlideState.className
  const hiddenModelKeys = useHiddenModelKeys()
  const visibleModels = useMemo(
    () => models.filter(model => !hiddenModelKeys.includes(getModelKey(model))),
    [models, hiddenModelKeys],
  )
  const {
    selectedModelKey,
    selectedVariant,
    currentModel,
    handleModelChange,
    handleVariantChange,
    restoreFromMessage,
  } = useModelSelection({ models: visibleModels, sessionId })

  // ============================================
  // Full Auto Hint
  // ============================================
  const [fullAutoHint, setFullAutoHint] = useState<string | null>(null)
  const fullAutoHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return autoApproveStore.onFullAutoChange((mode, changePaneId) => {
      // 只响应全局变更（changePaneId 为 undefined）或本 pane 的变更
      if (changePaneId && changePaneId !== paneId) return
      if (fullAutoHintTimerRef.current) clearTimeout(fullAutoHintTimerRef.current)
      const label =
        mode === 'global'
          ? t('chat:hints.autoApproveAll')
          : mode === 'session'
            ? t('chat:hints.autoApproveSession')
            : t('chat:hints.autoApproveOffHint')
      setFullAutoHint(label)
      fullAutoHintTimerRef.current = setTimeout(() => setFullAutoHint(null), 2000)
    })
  }, [t, paneId])

  // ============================================
  // Pane-local navigation
  // ============================================
  /** 规范化 session 标识为复合 key：已是复合 key 则原样，原始 id 用 pane 的服务器合成 */
  const normalizeSessionKey = useCallback(
    (sid: string): string => {
      return sid.includes('::') ? sid : makeSessionKey(paneServerId, sid)
    },
    [paneServerId],
  )

  const navigateToSession = useCallback(
    (sid: string, directory?: string) => {
      navigatePaneToSession(paneId, normalizeSessionKey(sid), directory)
    },
    [paneId, navigatePaneToSession, normalizeSessionKey],
  )

  /**
   * 子任务「在分屏中打开」：
   * 1. 若已有 pane 正在展示该子会话，直接聚焦它，避免同一子会话重复出现；
   * 2. 已经存在一个子代理 pane 时，复用它（替换内容），不再新开——
   *    子代理是「辅助查看」，点多个时应该互相覆盖，而不是堆满屏幕；
   * 3. 没有子代理 pane 且视口支持分屏时，向右侧新开一个；
   * 4. 不支持分屏 / 无 pane 时返回 false，调用方回退到 navigateToSession。
   */
  const openSessionInSplit = useCallback(
    (sid: string, directory?: string): boolean => {
      if (!splitPaneEnabled) return false

      const sessionKey = normalizeSessionKey(sid)

      // 同一子会话只占一个 pane：已存在则聚焦，不重复打开
      const existing = paneLayoutStore.findPaneBySession(sessionKey)
      if (existing) {
        paneLayoutStore.markSubtaskSession(sessionKey)
        paneLayoutStore.focusPane(existing.id)
        return true
      }

      // 已有子代理 pane → 复用最靠后的那个，替换其内容。
      // 这样连续点击多个子代理只占一个 pane，后点到的覆盖先前的。
      const reusablePane = paneLayoutStore
        .allLeaves()
        .filter(leaf => leaf.id !== paneId && leaf.sessionId && paneLayoutStore.isSubtaskSession(leaf.sessionId))
        .pop()
      if (reusablePane) {
        paneLayoutStore.markSubtaskSession(sessionKey)
        navigatePaneToSession(reusablePane.id, sessionKey, directory)
        return true
      }

      const previousFocusedPaneId = paneLayoutStore.getFocusedPaneId()
      const newPaneId = paneLayoutStore.splitPaneToSide(paneId, 'right', null)
      if (!newPaneId) return false
      paneLayoutStore.markSubtaskSession(sessionKey)

      // 焦点保持在原 pane（用户在主任务视图继续操作）；新 pane 只负责展示子会话
      if (previousFocusedPaneId && paneLayoutStore.findLeaf(previousFocusedPaneId)) {
        paneLayoutStore.focusPane(previousFocusedPaneId)
      }

      scheduleSplitSessionNavigation(() => {
        if (!paneLayoutStore.findLeaf(newPaneId)) return
        navigatePaneToSession(newPaneId, sessionKey, directory)
      })
      return true
    },
    [splitPaneEnabled, paneId, normalizeSessionKey, navigatePaneToSession],
  )

  const navigateHome = useCallback(() => {
    navigatePaneHome(paneId)
  }, [paneId, navigatePaneHome])

  // ============================================
  // Visible Message IDs (for outline index)
  // ============================================
  const [visibleMessageIds, setVisibleMessageIds] = useState<string[]>([])
  const visibleMessageIdsRef = useRef<string[]>([])
  const setVisibleMessageIdsStable = useCallback((ids: string[]) => {
    const prev = visibleMessageIdsRef.current
    if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return
    visibleMessageIdsRef.current = ids
    setVisibleMessageIds(ids)
  }, [])
  const [isAtBottom, setIsAtBottom] = useState(true)

  // ============================================
  // Input Box Height
  // ============================================
  const [inputBoxHeight, setInputBoxHeight] = useState(0)
  const inputBoxWrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = inputBoxWrapperRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setInputBoxHeight(entry.contentRect.height)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 对话区可用高度：欢迎态输入框需要垂直居中，用整数像素 top 定位避免
  // translateY(50%) 造成的半像素位移（会让文字子像素模糊）。
  const [chatContentHeight, setChatContentHeight] = useState(0)
  useEffect(() => {
    if (!chatContentEl) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setChatContentHeight(entry.contentRect.height)
      }
    })
    ro.observe(chatContentEl)
    return () => ro.disconnect()
  }, [chatContentEl])

  // ============================================
  // Chat Session
  // ============================================
  const {
    messages,
    isStreaming, // session busy（statusMap busy/retry || message streaming）
    canUndo,
    canRedo,
    redoSteps,
    revertedContent,
    restoredContent,
    agents,
    selectedAgent,
    setSelectedAgent,
    routeSessionId,
    loadState,
    loadError,
    hasMoreHistory,
    hasTrimmedHistory,
    compactedAt,
    retryStatus,
    effectiveDirectory,
    sessionLoadedFromSkeleton,

    pendingPermissionRequests,
    pendingQuestionRequests,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    isReplying,

    loadMoreHistory,
    loadUntilMessage,
    hydrateTurn,
    handleRedoAll,
    clearRevert,
    reloadSession,
    refreshOnResume,

    registerMessage,
    registerInputBox,

    handleSend,
    handleAbort,
    handleCommand,
    handleUndoWithAnimation,
    handleRedoWithAnimation,
    handleForkMessage,
    handleNewSession,
    handleVisibleMessageIdsChange,
    handleArchiveSession,
    handlePreviousSession,
    handleNextSession,
    handleCopyLastResponse,
    restoreAgentFromMessage,
  } = useChatSession({
    paneId,
    chatAreaRef,
    currentModel,
    refetchModels,
    sessionId,
    navigateToSession,
    navigateHome,
  })

  const handleOutlineScrollToMessage = useCallback(
    (messageId: string) => {
      // 轴现在可能含未加载的轮次：先补拉到目标进入内存再滚动
      const scroll = () => chatAreaRef.current?.scrollToMessageId(messageId)
      const state = routeSessionId ? messageStore.getSessionState(routeSessionId) : undefined
      if (state?.messages.some(m => m.info.id === messageId)) {
        scroll()
        return
      }
      void loadUntilMessage(messageId).then(scroll)
    },
    [routeSessionId, loadUntilMessage],
  )

  // 分屏时把重派生降到低优先级渲染车道。聚焦 pane 在流式期间必须保持实时，
  // 不能延迟（用户正在看）；非聚焦 pane 即使正在流式也走延迟：多对话并发时
  // 让未在看的那个把 CPU 让给聚焦 pane，聚焦切换或流式结束后自然追平。
  const shouldDeferMessages = displayMode === 'split' && messages.length > 20 && (!isStreaming || !isFocused)
  const messageView = useMemo(() => ({ sessionId: routeSessionId, messages }), [routeSessionId, messages])
  const deferredMessageView = useDeferredValue(shouldDeferMessages ? messageView : null)
  const renderedMessagesView = shouldDeferMessages && deferredMessageView ? deferredMessageView : messageView
  const renderedMessages = useMemo(
    () => (renderedMessagesView.sessionId === routeSessionId ? renderedMessagesView.messages : []),
    [renderedMessagesView, routeSessionId],
  )
  const isRenderingDeferredMessages = renderedMessages !== messages
  const renderedLoadState = loadState === 'loaded' && isRenderingDeferredMessages ? 'loading' : loadState
  // 对齐 oc：session 消息 ready 后再 mount ChatArea，避免空 virtualizer 先建再跳
  const messagesReady = !routeSessionId || loadState === 'loaded' || loadState === 'error'
  const chatAreaMountKey = messagesReady ? (routeSessionId ?? 'home') : null
  const inputDisabled = !!routeSessionId && loadState === 'error' && messages.length === 0
  // 子代理 pane：只读展示子代理会话，不提供输入框
  const isSubtaskPane = !!routeSessionId && paneLayoutStore.isSubtaskSession(routeSessionId)
  const chatPageViewModel = useChatPageViewModel(renderedMessages)

  // 独立轮次大纲：把已加载消息里的轮次增量并入持久化 store，
  // 并用 store 的完整大纲渲染侧边轴，历史未加载完也能显示全部轮次。
  const routeRawSessionId = routeSessionId ? sessionKeyToSessionId(routeSessionId) : null
  useMergeTurnOutline(paneServerId, routeRawSessionId, renderedMessages)
  /**
   * 后台补全完整轮次大纲（侧边轴据此显示**全部**轮次，而不只是已加载的）。
   *
   * 只在会话已加载完成后再触发：这条请求可能十几 MB（见 useTurnOutline 说明），
   * 必须等首屏渲染完、应用空闲时再做，绝不能和首屏抢带宽。
   *
   * 走骨架路径时跳过：骨架本身就是整段全部轮次（含用户正文），
   * `useMergeTurnOutline` 一次就把轴上的点补齐了，再发这条 18MB 请求纯属浪费。
   * 判定用 `sessionLoadedFromSkeleton`（由 messageStore 记录加载来源），
   * 比「有没有更早历史」准确 —— 小会话在分页路径下同样没有更早历史。
   */
  useBackfillTurnOutline(
    paneServerId,
    routeRawSessionId,
    loadState === 'loaded' && !sessionLoadedFromSkeleton,
  )
  const turnOutlineEntries = useTurnOutlineEntries(paneServerId, routeRawSessionId)

  /**
   * 上下文过重预警。
   *
   * 真实故障：用户只发「继续」两个字却收到 413。原因是 agent 读了 5 张截图，
   * base64 累计 8MB+ 留在服务端上下文里，转发给模型时超过上游 16MB 上限。
   * 前端无法减小它，但提前说明能让用户理解并主动脱困。
   */
  const heavyContent = useMemo(() => summarizeHeavyContent(renderedMessages), [renderedMessages])
  const heavyWarning = useMemo(() => {
    if (!heavyContent.shouldWarn) return undefined
    /**
     * 用字符串拼接而不是 i18next 插值。
     *
     * 实测 `t('chat:inputBox.heavyContext', { size })` 在这里会原样渲染出
     * `{size}` —— 该命名空间的插值在本项目的 i18next 配置下不生效
     * （同类 key 在 InputBox 里能生效，是因为那里用的是不带 `chat:` 前缀的
     * 默认命名空间解析路径）。这里只需要拼一个数字，不值得去动全局配置。
     */
    const sizeLabel = formatHeavyBytes(heavyContent.totalBytes)
    return {
      label: t('chat:inputBox.heavyContextLabel', { defaultValue: 'heavy' }).replace('{{size}}', sizeLabel),
      title: t('chat:inputBox.heavyContextTitle'),
    }
  }, [heavyContent, t])

  const outlineSourceEntries = useMemo(() => {
    /**
     * 已加载轮次的标记。
     *
     * 侧边轴现在包含**全部**轮次（含尚未加载进内存的），所以必须让用户能看出
     * 哪些点一下就到、哪些需要先补拉。判定依据就是 messageStore 里当前有哪些
     * 消息 id —— 这与「点击时走 scroll 还是 loadUntilMessage」用的是同一判据
     * （见 handleOutlineScrollToMessage），不会出现「看起来已加载、点下去却在转圈」。
     */
    const loadedIds = new Set(renderedMessages.map(message => message.info.id))
    const withLoaded = (entry: { messageId: string; title: string }) => ({
      messageId: entry.messageId,
      title: entry.title,
      loaded: loadedIds.has(entry.messageId),
    })
    // store 有数据时以它为准（含未加载轮次）；否则退回消息派生的条目
    if (turnOutlineEntries.length >= chatPageViewModel.outlineSourceEntries.length && turnOutlineEntries.length > 0) {
      return turnOutlineEntries.map(withLoaded)
    }
    return chatPageViewModel.outlineSourceEntries.map(withLoaded)
  }, [turnOutlineEntries, chatPageViewModel.outlineSourceEntries, renderedMessages])

  // 切 session remount 时默认视为贴底，避免回底按钮闪一下
  useEffect(() => {
    if (chatAreaMountKey == null) return
    setIsAtBottom(true)
    setVisibleMessageIdsStable([])
  }, [chatAreaMountKey, setVisibleMessageIdsStable])

  const connectionError = useMemo<MessageError | undefined>(() => {
    if (!activeServer) {
      return {
        name: 'APIError',
        data: {
          message: t('connectionError.noActiveServer'),
          isRetryable: false,
        },
      }
    }

    if (!activeServerHealth || activeServerHealth.status === 'checking' || activeServerHealth.status === 'online') {
      return undefined
    }

    const lines = [
      t('connectionError.serverLine', { name: activeServer.name }),
      `URL: ${activeServer.url}`,
      t('connectionError.statusLine', { status: activeServerHealth.status }),
      activeServerHealth.error ? t('connectionError.errorLine', { error: activeServerHealth.error }) : '',
      activeServerHealth.status === 'error' || activeServerHealth.status === 'offline'
        ? t('connectionError.expectedHealth')
        : '',
    ].filter(Boolean)

    // Summary only: raw headers/body/stack must not be part of the always-rendered
    // error text. They stay in metadata for the explicit "view raw diagnostics" disclosure.
    const responseBody = lines.join('\n')

    return {
      name: 'APIError',
      data: {
        message: activeServerHealth.error || t('connectionError.unableToConnect', { name: activeServer.name }),
        statusCode: activeServerHealth.status === 'unauthorized' ? 401 : undefined,
        isRetryable: activeServerHealth.status !== 'unauthorized',
        responseBody,
        metadata: activeServerHealth.details ? { rawDiagnostics: activeServerHealth.details } : undefined,
      },
    }
  }, [activeServer, activeServerHealth, t])

  const navigationCtx = useMemo(
    () => ({
      navigateToSession,
      openSessionInSplit,
      currentSessionId: routeSessionId,
      currentDirectory: effectiveDirectory,
    }),
    [navigateToSession, openSessionInSplit, routeSessionId, effectiveDirectory],
  )

  // ============================================
  // Protect session from eviction while this pane is viewing it
  // ============================================
  useEffect(() => {
    if (routeSessionId) {
      messageStore.protectSession(routeSessionId)
    }
    return () => {
      if (routeSessionId) {
        messageStore.unprotectSession(routeSessionId)
      }
    }
  }, [routeSessionId])

  // ============================================
  // Todo 投影桥
  // ============================================
  // v2 没有 todo 的数据通道（无 todo.updated 事件、无查询端点），todo 只存在于
  // agent 的 todowrite 工具调用里。这里订阅该会话的消息流，把「最后一条
  // todowrite」投影进 todoStore —— 历史加载完成与流式增量都走这条路径。
  useEffect(() => {
    if (!routeSessionId) return
    attachTodoBridge(routeSessionId)
    return () => detachTodoBridge(routeSessionId)
  }, [routeSessionId])

  // ============================================
  // Cancel Hint
  // ============================================
  const { showCancelHint, handleCancelMessage } = useCancelHint(isStreaming, handleAbort)

  // ============================================
  // Visible IDs bridge
  // ============================================
  const handleVisibleMessageIdsChangeRef = useRef<((ids: string[]) => void) | null>(null)
  useEffect(() => {
    handleVisibleMessageIdsChangeRef.current = handleVisibleMessageIdsChange
  }, [handleVisibleMessageIdsChange])

  const handleVisibleIdsChange = useCallback(
    (ids: string[]) => {
      handleVisibleMessageIdsChangeRef.current?.(ids)
      setVisibleMessageIdsStable(ids)
    },
    [setVisibleMessageIdsStable],
  )

  // ============================================
  // Agent Change with Model Sync
  // ============================================
  const syncModelForAgent = useCallback(
    (agentName: string) => {
      const agent = agents.find(a => a.name === agentName)
      if (agent?.model) {
        const modelKey = `${agent.model.providerID}:${agent.model.modelID}`
        const model = findModelByKey(visibleModels, modelKey)
        if (model) {
          handleModelChange(modelKey, model)
        }
      }
    },
    [agents, visibleModels, handleModelChange],
  )

  const handleAgentChange = useCallback(
    (agentName: string) => {
      setSelectedAgent(agentName)
      syncModelForAgent(agentName)
    },
    [setSelectedAgent, syncModelForAgent],
  )

  const handleToggleAgentWithSync = useCallback(() => {
    const primaryAgents = agents.filter(a => a.mode !== 'subagent' && !a.hidden)
    if (primaryAgents.length <= 1) return
    const currentIndex = primaryAgents.findIndex(a => a.name === selectedAgent)
    const nextIndex = (currentIndex + 1) % primaryAgents.length
    handleAgentChange(primaryAgents[nextIndex].name)
  }, [agents, selectedAgent, handleAgentChange])

  // ============================================
  // Model Restoration Effect
  // --
  // 只在 session 切换（routeSessionId 变化）或 revert/undo 恢复时执行一次。
  // 流式输出期间 messages 变化不会触发，避免覆盖用户的模型选择。
  // ============================================
  const inputRestoreContent = revertedContent ?? restoredContent

  // revert/undo 恢复：inputRestoreContent 变化时立即恢复
  useEffect(() => {
    if (!inputRestoreContent?.model) return
    const modelSelection = restoreModelSelection(
      inputRestoreContent.model,
      inputRestoreContent.variant ?? null,
      visibleModels,
    )
    if (modelSelection) {
      restoreFromMessage(inputRestoreContent.model, inputRestoreContent.variant)
    }
  }, [inputRestoreContent, visibleModels, restoreFromMessage])

  // session 切换：只在 routeSessionId 变化时，从消息里恢复模型
  //
  // ⚠️ v2 的 user 消息**没有 model 字段**（实测只有 time/text），
  // 模型记在 assistant 消息的 `model: { id, providerID, variant }` 上。
  // 原实现只找 user 消息的 model，必然拿到 undefined，于是「新开无痕页面/
  // 换一台设备打开同一会话」时显示的是全局默认（models[0]），
  // 看起来就是「会话没有绑定模型」。
  //
  // 现在优先取最近一条**带 model 的 assistant 消息**；user 消息仍作兜底
  // （v1 形状或未来版本可能回填）。
  const restoredSessionRef = useRef<string | null>(null)
  useEffect(() => {
    // 没有 session、或者这个 session 已经恢复过了 → 跳过
    if (!routeSessionId || restoredSessionRef.current === routeSessionId) return
    // messages 还没加载完 → 等下次
    if (messages.length === 0) return

    restoredSessionRef.current = routeSessionId

    type ModelCarrier = { model?: { providerID: string; modelID: string; variant?: string }; variant?: string }

    // 1) 最近的 assistant 消息（v2 唯一可靠的模型来源）
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.info.role !== 'assistant') continue
      const info = message.info as ModelCarrier & { modelID?: string; providerID?: string }
      // v2 适配层把 model 摊平到 modelID/providerID；也兼容仍有 model 对象的形状
      const model = info.model ?? (info.modelID && info.providerID
        ? { providerID: info.providerID, modelID: info.modelID }
        : undefined)
      if (model?.providerID && model?.modelID) {
        restoreFromMessage(model, info.variant ?? model.variant ?? null)
        return
      }
    }

    // 2) 兜底：user 消息（v1 形状 / 未来版本可能回填）
    const lastUserMsg = [...messages].reverse().find(m => m.info.role === 'user')
    if (lastUserMsg && 'model' in lastUserMsg.info) {
      const userInfo = lastUserMsg.info as ModelCarrier
      if (userInfo.model?.providerID && userInfo.model?.modelID) {
        restoreFromMessage(userInfo.model, userInfo.variant ?? userInfo.model.variant)
      }
    }
    // 依赖 routeSessionId 和 messages.length（等加载完），不依赖 messages 引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSessionId, messages.length, visibleModels, restoreFromMessage])

  // ============================================
  // Agent Restoration Effect
  // ============================================
  useEffect(() => {
    if (inputRestoreContent?.agent) {
      restoreAgentFromMessage(inputRestoreContent.agent)
    }
  }, [inputRestoreContent, restoreAgentFromMessage])

  const restoredAgentSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!routeSessionId || restoredAgentSessionRef.current === routeSessionId) return
    if (messages.length === 0) return

    restoredAgentSessionRef.current = routeSessionId
    const lastUserMsg = [...messages].reverse().find(m => m.info.role === 'user')
    if (lastUserMsg && 'agent' in lastUserMsg.info) {
      restoreAgentFromMessage((lastUserMsg.info as { agent?: string }).agent)
    }
    // Streaming only changes message content; agent restoration follows session/load boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSessionId, messages.length, restoreAgentFromMessage])

  // ============================================
  // Focus handling
  // ============================================
  const handlePaneFocus = useCallback(() => {
    paneLayoutStore.focusPane(paneId)
  }, [paneId])

  // ============================================
  // Drag & Drop — receive a session dragged from the sidebar list
  // Center drop → replace current session; edge drops → split in that direction
  //
  // IMPORTANT: zone state lives in PaneDropOverlay (imperative handle). We do
  // NOT put it in ChatPane state — dragover fires every mouse move, and
  // re-rendering ChatPane on each move is very expensive once several panes
  // exist (ChatArea / messages / hooks). rAF also throttles DOM writes to one
  // per frame for smoothness.
  //
  // Zone resolution has two refs on purpose:
  //   - pendingZoneRef: written synchronously by every dragover (most recent)
  //   - currentZoneRef: what the overlay is actually showing (written by rAF)
  // drop() prefers the pending value so it never loses a last-frame move.
  // ============================================
  const overlayRef = useRef<PaneDropOverlayHandle>(null)
  const paneRootRef = useRef<HTMLDivElement>(null)
  // 桌面端：文件夹拖到信息流 → 添加项目（输入框区域让给附件逻辑）
  const isFolderDropActive = useFolderProjectDrop(paneRootRef, addDirectory)
  const currentZoneRef = useRef<DropZone | null>(null)
  const pendingZoneRef = useRef<DropZone | null>(null)
  const dropRafRef = useRef<number | null>(null)

  const writeZone = useCallback((zone: DropZone | null) => {
    if (currentZoneRef.current === zone) return
    currentZoneRef.current = zone
    overlayRef.current?.setZone(zone)
  }, [])

  const cancelPendingZone = useCallback(() => {
    if (dropRafRef.current !== null) {
      cancelAnimationFrame(dropRafRef.current)
      dropRafRef.current = null
    }
    pendingZoneRef.current = null
  }, [])

  const resetDropState = useCallback(() => {
    cancelPendingZone()
    writeZone(null)
  }, [cancelPendingZone, writeZone])

  useEffect(() => {
    return () => {
      if (dropRafRef.current !== null) cancelAnimationFrame(dropRafRef.current)
    }
  }, [])

  const updateSessionDropZoneAt = useCallback(
    (clientX: number, clientY: number) => {
      if (!splitPaneEnabled) return null
      const element = paneRootRef.current
      if (!element) return null
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null

      const xRel = (clientX - rect.left) / rect.width
      const yRel = (clientY - rect.top) / rect.height
      const zone = resolveDropZone({ xRel, yRel })
      pendingZoneRef.current = zone

      if (dropRafRef.current === null) {
        dropRafRef.current = requestAnimationFrame(() => {
          dropRafRef.current = null
          writeZone(pendingZoneRef.current)
        })
      }

      return zone
    },
    [splitPaneEnabled, writeZone],
  )

  const clearSessionDropZoneAt = useCallback(
    (clientX: number, clientY: number) => {
      const element = paneRootRef.current
      if (!element) return resetDropState()
      const rect = element.getBoundingClientRect()
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        resetDropState()
      }
    },
    [resetDropState],
  )

  const handleSessionDrop = useCallback(
    (payload: { sessionId: string; serverId?: string; directory?: string }, zone: DropZone) => {
      resetDropState()
      cancelPendingSplitSessionNavigation()

      // 拖拽 payload 带源服务器：用它合成复合 key（否则会用目标 pane 的服务器，拖错服务器）
      const sessionKey = payload.serverId
        ? makeSessionKey(payload.serverId, payload.sessionId)
        : normalizeSessionKey(payload.sessionId)
      if (sessionKey === routeSessionId && zone === 'center') return

      if (zone === 'center') {
        navigatePaneToSession(paneId, sessionKey, payload.directory)
        return
      }

      const previousFocusedPaneId = paneLayoutStore.getFocusedPaneId()
      const newPaneId = paneLayoutStore.splitPaneToSide(paneId, zone, null)
      if (newPaneId) {
        if (previousFocusedPaneId && paneLayoutStore.findLeaf(previousFocusedPaneId)) {
          paneLayoutStore.focusPane(previousFocusedPaneId)
        }

        scheduleSplitSessionNavigation(() => {
          if (!paneLayoutStore.findLeaf(newPaneId)) return
          navigatePaneToSession(newPaneId, sessionKey, payload.directory)
        })
      }
    },
    [paneId, routeSessionId, navigatePaneToSession, resetDropState, normalizeSessionKey],
  )

  useEffect(() => {
    return subscribeInternalDrag(() => {
      const active = getInternalDragSnapshot().active
      if (!active || active.payload.kind !== 'session') {
        resetDropState()
        return
      }

      const zone = updateSessionDropZoneAt(active.current.x, active.current.y)
      if (!zone) clearSessionDropZoneAt(active.current.x, active.current.y)
    })
  }, [clearSessionDropZoneAt, resetDropState, updateSessionDropZoneAt])

  useEffect(() => {
    return subscribeInternalDrop(event => {
      if (event.payload.kind !== 'session') return
      const zone = updateSessionDropZoneAt(event.point.x, event.point.y)
      if (!zone) {
        resetDropState()
        return
      }

      handleSessionDrop(
        {
          sessionId: event.payload.sessionId,
          serverId: event.payload.serverId,
          directory: event.payload.directory,
        },
        zone,
      )
    })
  }, [handleSessionDrop, resetDropState, updateSessionDropZoneAt])

  const handleToggleFullAuto = useCallback(() => {
    autoApproveStore.cyclePaneFullAutoMode(paneId)
  }, [paneId])

  const openModelSelector = useCallback(() => {
    modelSelectorRef.current?.openMenu()
  }, [])

  const contextLimit = currentModel?.contextLimit

  const controllerActionsRef = useRef({
    newSession: handleNewSession,
    archiveSession: handleArchiveSession,
    previousSession: handlePreviousSession,
    nextSession: handleNextSession,
    toggleAgent: handleToggleAgentWithSync,
    copyLastResponse: handleCopyLastResponse,
    cancelMessage: handleCancelMessage,
    openModelSelector,
    toggleFullAuto: handleToggleFullAuto,
  })

  useEffect(() => {
    controllerActionsRef.current = {
      newSession: handleNewSession,
      archiveSession: handleArchiveSession,
      previousSession: handlePreviousSession,
      nextSession: handleNextSession,
      toggleAgent: handleToggleAgentWithSync,
      copyLastResponse: handleCopyLastResponse,
      cancelMessage: handleCancelMessage,
      openModelSelector,
      toggleFullAuto: handleToggleFullAuto,
    }
  }, [
    handleNewSession,
    handleArchiveSession,
    handlePreviousSession,
    handleNextSession,
    handleToggleAgentWithSync,
    handleCopyLastResponse,
    handleCancelMessage,
    openModelSelector,
    handleToggleFullAuto,
  ])

  const stableControllerActions = useMemo(
    () => ({
      newSession: () => controllerActionsRef.current.newSession(),
      archiveSession: () => controllerActionsRef.current.archiveSession(),
      previousSession: () => controllerActionsRef.current.previousSession(),
      nextSession: () => controllerActionsRef.current.nextSession(),
      toggleAgent: () => controllerActionsRef.current.toggleAgent(),
      copyLastResponse: () => controllerActionsRef.current.copyLastResponse(),
      cancelMessage: () => controllerActionsRef.current.cancelMessage(),
      openModelSelector: () => controllerActionsRef.current.openModelSelector(),
      toggleFullAuto: () => controllerActionsRef.current.toggleFullAuto(),
    }),
    [],
  )

  useEffect(() => {
    return () => {
      paneControllerStore.removeController(paneId)
    }
  }, [paneId])

  useEffect(() => {
    paneControllerStore.setController(paneId, {
      paneId,
      sessionId: routeSessionId,
      effectiveDirectory: effectiveDirectory || '',
      contextLimit,
      newSession: stableControllerActions.newSession,
      archiveSession: stableControllerActions.archiveSession,
      previousSession: stableControllerActions.previousSession,
      nextSession: stableControllerActions.nextSession,
      toggleAgent: stableControllerActions.toggleAgent,
      copyLastResponse: stableControllerActions.copyLastResponse,
      cancelMessage: stableControllerActions.cancelMessage,
      openModelSelector: stableControllerActions.openModelSelector,
      toggleFullAuto: stableControllerActions.toggleFullAuto,
      isStreaming,
    })
  }, [paneId, routeSessionId, effectiveDirectory, contextLimit, stableControllerActions, isStreaming])

  // ============================================
  // Dialog Collapsed State
  // ============================================
  const [permissionCollapsed, setPermissionCollapsed] = useState(false)
  const [questionCollapsed, setQuestionCollapsed] = useState(false)

  const permissionRequestId = pendingPermissionRequests[0]?.id
  const questionRequestId = pendingQuestionRequests[0]?.id
  useEffect(() => {
    if (permissionRequestId) setPermissionCollapsed(false)
  }, [permissionRequestId])
  useEffect(() => {
    if (questionRequestId) setQuestionCollapsed(false)
  }, [questionRequestId])

  const { inlineToolRequests, outlineCurrentHighlight } = useTheme()

  // 工作状态面板：用户开关 + 视口宽度共同决定是否占位。
  // 分屏 pane 不显示（宽度不够，且信息会和主视图重复）。
  const workStatus = useWorkStatus()
  const { rowRef: workStatusRowRef, visible: workStatusVisible } = useWorkStatusVisibility({
    disabled: showCompactShell,
    enabled: workStatus.enabled,
  })

  // 把面板占位状态广播给顶栏：顶栏的上下文圆环在面板可见时隐藏，避免重复。
  // 分屏 pane 的 PaneHeader 不渲染圆环，这里只在单视图 pane 发布。
  const workStatusPanelVisible = workStatusVisible && !showCompactShell
  useEffect(() => {
    setWorkStatusPanelVisible(paneId, workStatusPanelVisible)
    return () => clearWorkStatusPanelVisible(paneId)
  }, [paneId, workStatusPanelVisible])

  const inlineToolRequestCtx = useMemo<InlineToolRequestContextValue>(
    () => ({
      pendingPermissions: pendingPermissionRequests,
      pendingQuestions: pendingQuestionRequests,
      onPermissionReply: (requestId, reply) => {
        const request = pendingPermissionRequests.find(r => r.id === requestId)
        return handlePermissionReply(requestId, reply, effectiveDirectory, request?.sessionID)
      },
      onQuestionReply: (requestId, answers) => handleQuestionReply(requestId, answers, effectiveDirectory),
      onQuestionReject: requestId => handleQuestionReject(requestId, effectiveDirectory),
      isReplying,
    }),
    [
      pendingPermissionRequests,
      pendingQuestionRequests,
      handlePermissionReply,
      handleQuestionReply,
      handleQuestionReject,
      isReplying,
      effectiveDirectory,
    ],
  )

  // 内嵌模式下，如果请求没能匹配到任何已渲染的工具部件（子 session 关系还没注册、
  // 工具部件不在当前会话、v2 表单没有工具关联等），内嵌卡片不会出现。这里挑出这些
  // 「落空」的请求，直接渲染在消息流末尾（ChatArea 内），而不是浮层弹窗。
  const unmatchedPendingQuestions = useMemo(
    () => (inlineToolRequests ? findUnmatchedQuestions(pendingQuestionRequests, renderedMessages) : []),
    [inlineToolRequests, renderedMessages, pendingQuestionRequests],
  )
  const inlineQuestionEntries = useMemo(
    () =>
      unmatchedPendingQuestions.map(request => ({
        request,
        onReply: (answers: QuestionAnswer[]) => handleQuestionReply(request.id, answers, effectiveDirectory),
        onReject: () => handleQuestionReject(request.id, effectiveDirectory),
        isReplying,
      })),
    [unmatchedPendingQuestions, handleQuestionReply, handleQuestionReject, effectiveDirectory, isReplying],
  )

  const revertedMessage = inputRestoreContent
    ? {
        text: inputRestoreContent.text,
        attachments: inputRestoreContent.attachments as Attachment[],
      }
    : undefined
  const fileCapabilities = useMemo(
    () =>
      currentModel
        ? {
            image: currentModel.supportsImages,
            pdf: currentModel.supportsPdf,
            audio: currentModel.supportsAudio,
            video: currentModel.supportsVideo,
          }
        : undefined,
    [currentModel],
  )
  const handleScrollToBottom = useCallback(() => {
    chatAreaRef.current?.scrollToBottom()
  }, [])

  // ============================================
  // Render
  // ============================================
  // 顶栏横跨整个 pane 宽度（含工作状态卡片上方），与参考布局一致：
  // 卡片在顶栏下方，而不是和顶栏并排。
  // 桌面端（Windows/macOS）single 模式：Header 已并入窗口标题栏，这里只留锚点占位，
  // 供斜杠/提及菜单按 pane root 查找 data-chat-header-shadow 计算上边界。
  const desktopMergedTitlebar = displayMode === 'single' && usesCustomDesktopTitlebar()
  const header =
    displayMode === 'single' &&
    (desktopMergedTitlebar ? (
      <div className="absolute top-0 left-0 right-0 z-20 pointer-events-none">
        <div data-chat-header-shadow className="absolute top-0 left-0 right-0 h-8" />
      </div>
    ) : (
      <div className="absolute top-0 left-0 right-0 z-20 pointer-events-none">
        <div className="pointer-events-auto">
          <Header
            onOpenSidebar={onOpenSidebar}
            onToggleRightPanel={onToggleRightPanel}
            onSplitPane={onSplitPane}
            isPaneFullscreen={isPaneFullscreen}
            onTogglePaneFullscreen={onTogglePaneFullscreen}
          />
        </div>
      </div>
    ))

  // ============================================
  // 欢迎层（home 空态）
  // 只在「无 session 且没有消息且未流式」时展示。发送第一条消息后 routeSessionId
  // 立即从 null 变为有值，welcome 自然退场——不需要自己维护 docked 状态。
  // ============================================
  const showWelcome = !routeSessionId && renderedMessages.length === 0 && !isStreaming && chatAreaMountKey !== null
  const handleWelcomeSelectProject = useCallback(
    (path: string) => {
      setCurrentDirectory(path)
      addDirectory(path)
    },
    [addDirectory, setCurrentDirectory],
  )
  const handleWelcomeClearProject = useCallback(() => {
    setCurrentDirectory(undefined)
  }, [setCurrentDirectory])
  const handleWelcomeAddProject = useCallback(() => {
    onOpenProject?.()
  }, [onOpenProject])

  /**
   * 移动端从后台返回时补拉 + 反馈。
   *
   * 墓碑机制下切后台会冻结 JS：期间服务端继续产出消息，但 SSE 事件没人消费；
   * 而连接靠心跳仍显示存活、不触发 onReconnected。于是界面停在离开那一刻，
   * 用户要等很久才「一股脑刷新」。这里在回前台时主动补一次，并给出反馈。
   */
  const resume = useResumeRefresh({
    onResume: refreshOnResume,
    enabled: !!routeSessionId,
  })

  const chatContent = (
    <div ref={setChatContentRef} className="flex-1 relative overflow-hidden flex flex-col min-h-0">
      {/* 回前台补拉的反馈：正在更新 / 已更新。放在消息区顶部浮层，不挤占布局 */}
      {(resume.refreshing || resume.updated) && (
        <div
          className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center"
          role="status"
          aria-live="polite"
        >
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border-200/60 bg-bg-100/95 px-3 py-1 text-[length:var(--fs-xxs)] text-text-300 shadow-sm backdrop-blur">
            {resume.refreshing ? (
              <>
                <Spinner size="xs" tone="current" variant="ring" />
                <span>{t('chat:resumeRefreshing')}</span>
              </>
            ) : (
              <>
                <CheckIcon size={11} className="text-success-100" />
                <span>{t('chat:resumeUpdated')}</span>
              </>
            )}
          </div>
        </div>
      )}
      <div key={activeServerId} className={`absolute inset-0 ${hostSlide}`}>
        <InlineToolRequestContext.Provider value={inlineToolRequestCtx}>
          <ErrorBoundary onOpenSettings={onOpenSettings}>
            {chatAreaMountKey == null ? (
              <div className="h-full flex items-center justify-center">
                <div className="session-loading-indicator">
                  <LoadingState />
                </div>
              </div>
            ) : (
              <ChatArea
                key={chatAreaMountKey}
                ref={chatAreaRef}
                messages={renderedMessages}
                visibleMessageEntries={chatPageViewModel.visibleMessageEntries}
                visibleMessages={chatPageViewModel.visibleMessages}
                forkTargetIdMap={chatPageViewModel.forkTargetIdMap}
                turnDurationMap={chatPageViewModel.turnDurationMap}
                turnLatestAssistantIds={chatPageViewModel.turnLatestAssistantIds}
                sessionId={routeSessionId}
                isStreaming={isStreaming}
                allowStreamingLayoutAnimation={false}
                loadState={renderedLoadState}
                loadError={loadError}
                connectionError={connectionError}
                onOpenSettings={onOpenSettings}
                onReloadSession={reloadSession}
                hasMoreHistory={hasMoreHistory}
                hasTrimmedHistory={hasTrimmedHistory}
                compactedAt={compactedAt}
                onLoadMore={loadMoreHistory}
                onHydrateTurn={hydrateTurn}
                onUndo={handleUndoWithAnimation}
                onFork={handleForkMessage}
                canUndo={canUndo}
                registerMessage={registerMessage}
                retryStatus={retryStatus}
                bottomPadding={inputBoxHeight}
                onVisibleMessageIdsChange={handleVisibleIdsChange}
                onAtBottomChange={setIsAtBottom}
                inlineQuestions={inlineToolRequests ? inlineQuestionEntries : []}
              />
            )}
          </ErrorBoundary>
        </InlineToolRequestContext.Provider>
      </div>

      <OutlineIndex
        sourceEntries={outlineSourceEntries}
        ownerByMessageId={chatPageViewModel.outlineOwnerByMessageId}
        visibleMessageIds={visibleMessageIds}
        currentHighlightEnabled={outlineCurrentHighlight}
        onScrollToMessageId={handleOutlineScrollToMessage}
      />

      <PaneInputDock
        inputBoxWrapperRef={inputBoxWrapperRef}
        hostSlideSwitching={hostSlideState.switching}
        showCompactShell={showCompactShell}
        showWelcome={showWelcome}
        chatContentHeight={chatContentHeight}
        inputBoxHeight={inputBoxHeight}
        showCancelHint={showCancelHint}
        fullAutoHint={fullAutoHint}
        isSubtaskPane={isSubtaskPane}
        welcomeDirectory={effectiveDirectory || ''}
        onWelcomeSelectProject={handleWelcomeSelectProject}
        onWelcomeClearProject={handleWelcomeClearProject}
        onWelcomeAddProject={handleWelcomeAddProject}
        inputBoxProps={{
          paneId,
          onSend: handleSend,
          onAbort: handleAbort,
          onCommand: handleCommand,
          disabled: inputDisabled,
          isStreaming,
          agents,
          selectedAgent,
          onAgentChange: handleAgentChange,
          variants: currentModel?.variants ?? [],
          selectedVariant,
          onVariantChange: handleVariantChange,
          fileCapabilities,
          models: visibleModels,
          selectedModelKey,
          onModelChange: handleModelChange,
          modelsLoading,
          modelSelectorRef,
          rootPath: effectiveDirectory,
          sessionId: routeSessionId,
          revertedText: revertedMessage?.text,
          revertedAttachments: revertedMessage?.attachments,
          canRedo,
          revertSteps: redoSteps,
          onRedo: handleRedoWithAnimation,
          onRedoAll: handleRedoAll,
          onClearRevert: clearRevert,
          registerInputBox,
          isAtBottom,
          onScrollToBottom: handleScrollToBottom,
          collapsedPermission:
            !inlineToolRequests && pendingPermissionRequests.length > 0 && permissionCollapsed
              ? {
                  label: t('chat:permissionDialog.permission', {
                    permission: pendingPermissionRequests[0].permission,
                  }),
                  queueLength: pendingPermissionRequests.length,
                  onExpand: () => setPermissionCollapsed(false),
                }
              : undefined,
          collapsedQuestion:
            !inlineToolRequests &&
            pendingPermissionRequests.length === 0 &&
            pendingQuestionRequests.length > 0 &&
            questionCollapsed
              ? {
                  label: t('chat:questionDialog.title'),
                  queueLength: pendingQuestionRequests.length,
                  onExpand: () => setQuestionCollapsed(false),
                }
              : undefined,
          heavyContent: heavyWarning,
        }}
      />

      {/* 内容列宽拖拽手柄：只在非紧凑视图启用，两条手柄对称加宽 */}
      <ChatWidthControls container={chatContentEl} enabled={!showCompactShell} />

      {!inlineToolRequests && pendingPermissionRequests.length > 0 && (
        <PermissionDialog
          request={pendingPermissionRequests[0]}
          onReply={reply =>
            handlePermissionReply(
              pendingPermissionRequests[0].id,
              reply,
              effectiveDirectory,
              pendingPermissionRequests[0].sessionID,
            )
          }
          queueLength={pendingPermissionRequests.length}
          isReplying={isReplying}
          currentSessionId={routeSessionId}
          collapsed={permissionCollapsed}
          onCollapsedChange={setPermissionCollapsed}
        />
      )}

      {!inlineToolRequests &&
        pendingPermissionRequests.length === 0 &&
        pendingQuestionRequests.length > 0 && (
          <QuestionDialog
            request={pendingQuestionRequests[0]}
            onReply={answers => handleQuestionReply(pendingQuestionRequests[0].id, answers, effectiveDirectory)}
            onReject={() => handleQuestionReject(pendingQuestionRequests[0].id, effectiveDirectory)}
            queueLength={pendingQuestionRequests.length}
            isReplying={isReplying}
            collapsed={questionCollapsed}
            onCollapsedChange={setQuestionCollapsed}
          />
        )}
    </div>
  )

  const content = (
    <SessionNavigationContext.Provider value={navigationCtx}>
      <div
        ref={paneRootRef}
        data-chat-pane-root="true"
        className={
          showCompactShell
            ? `relative h-full flex flex-col overflow-hidden transition-colors duration-200 ${
                isFocused ? 'bg-bg-000' : 'bg-bg-000'
              }`
            : 'relative h-full flex flex-col overflow-hidden bg-bg-000'
        }
        onClick={handlePaneFocus}
        // 分屏 pane 的 PaneHeader 是常规流内元素，已经占据真实行高。
        // --chat-header-height 是给「绝对覆盖式 Header」预留空间用的（消息区
        // paddingTop、工作状态卡片上边距、右面板下移都读它）。分屏下若不置零，
        // 这些消费方会再让出一份顶栏高度，顶栏被顶出可视区、消息区顶部出现重叠。
        // 在这里局部覆盖，只影响本 pane 子树，不影响主视图与其它 pane。
        style={showCompactShell ? ({ '--chat-header-height': '0px' } as React.CSSProperties) : undefined}
      >
        {showCompactShell && (
          <PaneHeader
            paneId={paneId}
            sessionId={routeSessionId}
            isFocused={isFocused}
            paneCount={paneCount}
            showSidebarButton={showSidebarButton}
            onOpenSidebar={onOpenSidebar}
            onToggleRightPanel={onToggleRightPanel}
            canSplitPane={splitPaneEnabled}
            isPaneFullscreen={isPaneFullscreen}
            onTogglePaneFullscreen={onTogglePaneFullscreen}
            alignHeaderWithSidebar={alignHeaderWithSidebar}
            onFocus={handlePaneFocus}
          />
        )}
        {/* 顶栏横跨整个 pane 宽度（含工作状态卡片上方），卡片因此落在顶栏下方，
            而不是与顶栏并排。Header 自身是 absolute 覆盖式布局，所以这里只作占位锚点。 */}
        {header}
        {/* 工作状态卡片是对话列的兄弟节点，不是浮层：它占自己的宽度把对话挤窄。
            data-chat-area 标记的这一层宽度不受卡片显隐影响，供可见性测量使用。
            右侧浮层工具面板滑入时（--right-drawer-width），整行让出面板宽度：
            对话与工作状态卡片都随之左移，既不盖住卡片，顶栏（absolute 覆盖式）
            也保持全宽不动。 */}
        <div
          ref={workStatusRowRef}
          data-chat-area="true"
          className="flex flex-1 min-h-0 min-w-0 overflow-hidden transition-[padding] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)]"
          style={{ paddingRight: 'var(--right-drawer-width, 0px)' }}
        >
          {chatContent}
          {!showCompactShell && (
            <WorkStatusPanel
              sessionId={routeSessionId}
              directory={effectiveDirectory}
              serverId={paneServerId}
              contextLimit={contextLimit ?? 0}
              visible={workStatusVisible}
              onScrollToMessage={handleOutlineScrollToMessage}
            />
          )}
        </div>
        <PaneDropOverlay ref={overlayRef} />
        <FolderProjectDropOverlay active={isFolderDropActive} />
      </div>
    </SessionNavigationContext.Provider>
  )

  // Always wrap with ChatViewportProvider to keep the React tree structure stable
  // across fullscreen toggles. Only the value changes — compact pane vs full viewport.
  // Split shell keeps compact presentation, but must inherit the input-dock setting
  // from the outer viewport (previously hardcoded false, so PC split never collapsed).
  const viewportValue = useMemo((): ChatViewportValue => {
    if (!showCompactShell) return outerViewport ?? PANE_VIEWPORT
    const enableCollapsedInputDock = outerViewport?.interaction.enableCollapsedInputDock ?? false
    if (enableCollapsedInputDock === PANE_VIEWPORT.interaction.enableCollapsedInputDock) {
      return PANE_VIEWPORT
    }
    return {
      ...PANE_VIEWPORT,
      interaction: {
        ...PANE_VIEWPORT.interaction,
        enableCollapsedInputDock,
      },
    }
  }, [showCompactShell, outerViewport])

  return <ChatViewportProvider value={viewportValue}>{content}</ChatViewportProvider>
})
