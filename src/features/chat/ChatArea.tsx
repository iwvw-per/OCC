/**
 * ChatArea — 基于 @tanstack/react-virtual 的消息流虚拟化
 *
 * 对齐 oc message-timeline 的关键点：
 * 1. parent 在 messages ready 后 key={sessionId} remount
 * 2. mount 时读 sessionCache → initialMeasurementsCache
 * 3. 冷启动 initialOffset 估在底部 + scrollToFn 预写 total height
 * 4. anchorTo/followOnAppend + 贴底时 size change 直接 scrollToEnd
 * 5. unmount takeSnapshot 写回 cache
 * 6. directDomUpdates 滚动写 transform，不触发 React 重渲染
 */
import {
  useRef,
  useImperativeHandle,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  useVirtualizer,
  elementScroll,
  defaultRangeExtractor,
  type VirtualItem,
  type Virtualizer,
} from '@tanstack/react-virtual'
import { useTranslation } from 'react-i18next'
import { MessageRenderer, ProcessCollapseBlock, messageHasFinalContent, messageHasProcessContent } from '../message'
import { MessageErrorView } from '../message/parts'
import type { ChangedFile } from '../message/parts/changedFiles'
import type { Message, MessageError } from '../../types/message'
import { RetryStatusInline, type RetryStatusInlineData } from './RetryStatusInline'
import {
  buildVisibleMessageEntries,
  getVisibleMessageForkTargetId,
  type VisibleMessageEntry,
} from './chatAreaVisibility'
import { AT_BOTTOM_THRESHOLD_PX } from '../../constants'
import { useChatViewport } from './chatViewport'
import {
  buildProcessTimeline,
  buildTurnDurationMap,
  buildTurnLatestAssistantIdSet,
  collectTurnChangedFiles,
  reuseProcessTimelineItems,
  type ProcessTimelineItem,
} from './chatPageModel'
import { useTheme } from '../../hooks/useTheme'
import { LoadingState } from '../../components/ui/LoadingState'
import { getStreamingHotIndexes, getTimelineRowYClass, mergeVirtualRangeIndexes } from './chatAreaUtils'
import { chatContentMaxWidthStyle, getContentPaddingClass } from './contentWidth'
import { getChatWidthDragging, subscribeChatWidthDrag } from './chatWidthDrag'
import { getChatMorphing, subscribeChatMorphing } from './chatMorph'
import { useAutoScroll } from './virtual/useAutoScroll'
import { useEmptyWorkingShellGate } from './virtual/useEmptyWorkingShellGate'

const NOOP = () => {}
const ROW_ESTIMATE = 60
/** 过程壳 header 行高（Working / Worked 一行） */
const PROCESS_SHELL_HEADER = 36
/** 用户入场生长结束后，空 Working 壳再等多久（有 assistant 则立刻挂，不等） */
const EMPTY_WORKING_SHELL_EXTRA_DELAY_MS = 500
const DEFAULT_BOTTOM_SPACER = 256
const SESSION_CACHE_LIMIT = 16
/** 距顶部多少 px 内视为「已到顶」，触发加载更早一段历史 */
const LOAD_MORE_TOP_THRESHOLD = 200

const bottomSpacerHeight = (bottomPadding: number) => (bottomPadding > 0 ? bottomPadding + 48 : DEFAULT_BOTTOM_SPACER)

/** 无改动时的稳定空数组（避免每次渲染新建引用） */
const EMPTY_FILES: ChangedFile[] = []

/** 过程壳 header 统计：工具调用数 / 思考段数（折叠时展示，避免展开才知道规模） */
type ProcessShellChild = { message: Message; processContentScope: 'process' | 'inline' }

function processStepCount(children: ProcessShellChild[]): number {
  let count = 0
  for (const child of children) {
    // 压缩态 reasoning/工具输出已清空，用压缩前记录的统计补齐
    if (child.message.isCompressed && child.message.compressedStats) {
      count += child.message.compressedStats.stepCount
      continue
    }
    for (const part of child.message.content) {
      if (part.type === 'tool') count++
    }
  }
  return count
}

function processReasoningCount(children: ProcessShellChild[]): number {
  let count = 0
  for (const child of children) {
    if (child.message.isCompressed && child.message.compressedStats) {
      count += child.message.compressedStats.reasoningCount
      continue
    }
    for (const part of child.message.content) {
      if (part.type === 'reasoning' && part.text?.trim()) count++
    }
  }
  return count
}

function estimateTimelineItemSize(item: ProcessTimelineItem | undefined): number {
  if (!item) return ROW_ESTIMATE
  if (item.kind === 'message') return ROW_ESTIMATE
  // 进行中默认展开：header + 壳内消息（空回合至少占 header）
  if (item.isActive) {
    const body = Math.max(item.children.length, 1) * ROW_ESTIMATE
    return PROCESS_SHELL_HEADER + body
  }
  // 结束后默认折叠：只估 header + 壳外 final，避免刷新时 120→36 的假高度再回弹
  return PROCESS_SHELL_HEADER + (item.finalMessage ? ROW_ESTIMATE : 0)
}

function sessionCacheKey(sessionId: string, processCollapseEnabled: boolean): string {
  return `${sessionId}:${processCollapseEnabled ? 'process' : 'flat'}`
}

// ─── 接口定义（保持不变） ───────────────────────────────────────

interface ChatAreaProps {
  messages: Message[]
  visibleMessageEntries?: VisibleMessageEntry[]
  visibleMessages?: Message[]
  forkTargetIdMap?: Map<string, string | undefined>
  turnDurationMap?: Map<string, number>
  turnLatestAssistantIds?: Set<string>
  sessionId?: string | null
  isStreaming?: boolean
  allowStreamingLayoutAnimation?: boolean
  loadState?: 'idle' | 'loading' | 'loaded' | 'error'
  loadError?: MessageError
  connectionError?: MessageError
  onOpenSettings?: () => void
  /** 会话加载失败时的“重新加载”回调（移动端无侧栏，必须有此入口） */
  onReloadSession?: () => void
  hasMoreHistory?: boolean
  /**
   * 是否存在因内存上限被裁掉、尚未补回的历史。
   *
   * 与 hasMoreHistory 分开：hasMoreHistory 表示服务端还有更早的消息，本字段
   * 表示本地有缺口。两者任一为真都值得尝试加载，但只有 hasMoreHistory 为真
   * 才说明「上滑能拿到新内容」——否则会陷入空拉循环。
   */
  hasTrimmedHistory?: boolean
  onLoadMore?: () => void | Promise<void>
  /** 展开被压缩的历史轮次时，按需回拉该轮完整过程内容 */
  onHydrateTurn?: (turnUserMessageId: string) => void | Promise<void>
  onUndo?: (userMessageId: string) => void
  onFork?: (message: Message, forkMessageId?: string) => void | Promise<void>
  canUndo?: boolean
  registerMessage?: (id: string, element: HTMLElement | null) => void
  retryStatus?: RetryStatusInlineData | null
  bottomPadding?: number
  onVisibleMessageIdsChange?: (ids: string[]) => void
  onAtBottomChange?: (atBottom: boolean) => void
}

export type ChatAreaHandle = {
  scrollToBottom: (instant?: boolean) => void
  scrollToBottomIfAtBottom: () => void
  scrollToLastMessage: () => void
  scrollToMessageIndex: (index: number) => void
  scrollToMessageId: (messageId: string) => void
}

// ─── 虚拟行 ──────────────────────────────────────────────────

interface MessageBodyProps {
  message: Message
  registerMessage?: (id: string, element: HTMLElement | null) => void
  onUndo?: (userMessageId: string) => void
  onFork?: (message: Message, forkMessageId?: string) => void | Promise<void>
  canUndo?: boolean
  forkMessageId?: string
  turnDuration?: number
  isTurnLatestAssistant?: boolean
  allowStreamingLayoutAnimation: boolean
  processContentScope?: 'all' | 'process' | 'final' | 'inline'
  onEntryGrowComplete?: (messageId: string) => void
  sessionId?: string | null
  /** 本回合聚合的改动文件，仅在最终回复（final）消息上渲染 */
  turnFiles?: ChangedFile[]
}

const MessageBody = memo(function MessageBody({
  message,
  registerMessage,
  onUndo,
  onFork,
  canUndo,
  forkMessageId,
  turnDuration,
  isTurnLatestAssistant,
  allowStreamingLayoutAnimation,
  processContentScope = 'all',
  onEntryGrowComplete,
  sessionId,
  turnFiles,
}: MessageBodyProps) {
  const messageId = message.info.id
  const isUser = message.info.role === 'user'
  return (
    <div
      ref={node => registerMessage?.(messageId, node as HTMLDivElement | null)}
      data-message-id={messageId}
      data-anchor-source-id={forkMessageId ?? messageId}
    >
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
        <div className={`message-renderer-shell min-w-0 group ${!isUser ? 'w-full' : ''}`}>
          <MessageRenderer
            message={message}
            allowStreamingLayoutAnimation={message.isStreaming ? allowStreamingLayoutAnimation : false}
            turnDuration={turnDuration}
            isTurnLatestAssistant={isTurnLatestAssistant}
            processContentScope={processContentScope}
            onUndo={isUser ? onUndo : undefined}
            onFork={onFork}
            forkMessageId={forkMessageId}
            canUndo={isUser ? canUndo : undefined}
            onEnsureParts={NOOP}
            onEntryGrowComplete={isUser ? onEntryGrowComplete : undefined}
            sessionId={sessionId}
            turnFiles={turnFiles}
          />
        </div>
      </div>
    </div>
  )
})

interface RowProps {
  virtualItem: VirtualItem
  item: ProcessTimelineItem
  paddingClass: string
  rowYClass: string
  registerMessage?: (id: string, element: HTMLElement | null) => void
  onUndo?: (userMessageId: string) => void
  onFork?: (message: Message, forkMessageId?: string) => void | Promise<void>
  canUndo?: boolean
  forkMap: Map<string, string | undefined>
  turnDurationMap: Map<string, number>
  turnLatestAssistantIds: Set<string>
  allowStreamingLayoutAnimation: boolean
  measureElement: (el: HTMLElement | null) => void
  onEntryGrowComplete?: (messageId: string) => void
  sessionId?: string | null
  onHydrateTurn?: (turnUserMessageId: string) => void | Promise<void>
}

const VirtualRow = memo(
  function VirtualRow({
    virtualItem,
    item,
    paddingClass,
    rowYClass,
    registerMessage,
    onUndo,
    onFork,
    canUndo,
    forkMap,
    turnDurationMap,
    turnLatestAssistantIds,
    allowStreamingLayoutAnimation,
    measureElement,
    onEntryGrowComplete,
    sessionId,
    onHydrateTurn,
  }: RowProps) {
    const rowRef = useRef<HTMLDivElement | null>(null)

    const setRef = useCallback(
      (el: HTMLDivElement | null) => {
        rowRef.current = el
        measureElement(el)
      },
      [measureElement],
    )

    useLayoutEffect(() => {
      if (rowRef.current) measureElement(rowRef.current)
    }, [measureElement, virtualItem.index, item, rowYClass])

    // 过程壳回合：聚合整轮改动文件，下发给壳外最终回复（final）消息渲染
    const turnFiles = useMemo(() => {
      if (item.kind === 'message') return EMPTY_FILES
      if (item.isActive) return EMPTY_FILES
      const messages: Message[] = []
      for (const child of item.children) messages.push(child.message)
      if (item.finalMessage) messages.push(item.finalMessage)
      return collectTurnChangedFiles(messages)
    }, [item])

    return (
      <div
        ref={setRef}
        data-timeline-key={item.key}
        data-index={virtualItem.index}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%' }}
      >
        <div
          className={`w-full mx-auto ${paddingClass} ${rowYClass} chat-content-width-transition`}
          style={chatContentMaxWidthStyle}
        >
          {item.kind === 'message' ? (
            <MessageBody
              message={item.message}
              registerMessage={registerMessage}
              onUndo={onUndo}
              onFork={onFork}
              canUndo={canUndo}
              forkMessageId={forkMap.get(item.message.info.id)}
              turnDuration={turnDurationMap.get(item.message.info.id)}
              isTurnLatestAssistant={
                item.message.info.role === 'assistant' ? turnLatestAssistantIds.has(item.message.info.id) : undefined
              }
              allowStreamingLayoutAnimation={allowStreamingLayoutAnimation}
              processContentScope={item.processContentScope ?? 'all'}
              onEntryGrowComplete={onEntryGrowComplete}
              sessionId={sessionId}
            />
          ) : (
            <div className="flex justify-start">
              <div className="message-renderer-shell min-w-0 group w-full flex flex-col gap-2">
                <ProcessCollapseBlock
                  stateKey={`turn-process:${item.userMessageId ?? item.key}`}
                  startedAt={item.startedAt}
                  durationMs={item.durationMs}
                  isActive={item.isActive}
                  stepCount={processStepCount(item.children)}
                  reasoningCount={processReasoningCount(item.children)}
                  onExpand={
                    item.userMessageId && onHydrateTurn
                      ? () => {
                          void onHydrateTurn(item.userMessageId!)
                        }
                      : undefined
                  }
                >
                  {item.children.map(child => (
                    <MessageBody
                      key={`${child.message.info.id}:${child.processContentScope}`}
                      message={child.message}
                      registerMessage={registerMessage}
                      onUndo={onUndo}
                      onFork={onFork}
                      canUndo={canUndo}
                      forkMessageId={forkMap.get(child.message.info.id)}
                      turnDuration={turnDurationMap.get(child.message.info.id)}
                      isTurnLatestAssistant={turnLatestAssistantIds.has(child.message.info.id)}
                      allowStreamingLayoutAnimation={allowStreamingLayoutAnimation}
                      processContentScope={child.processContentScope}
                      sessionId={sessionId}
                    />
                  ))}
                </ProcessCollapseBlock>
                {/* shell 的 gap-2 只服务 process 壳 ↔ final 文本，子消息间距由 processBody 管 */}
                {item.finalMessage && (
                  <MessageBody
                    message={item.finalMessage}
                    registerMessage={registerMessage}
                    onUndo={onUndo}
                    onFork={onFork}
                    canUndo={canUndo}
                    forkMessageId={forkMap.get(item.finalMessage.info.id)}
                    turnDuration={turnDurationMap.get(item.finalMessage.info.id)}
                    isTurnLatestAssistant
                    allowStreamingLayoutAnimation={allowStreamingLayoutAnimation}
                    processContentScope="final"
                    sessionId={sessionId}
                    turnFiles={turnFiles}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  },
  (prev, next) =>
    prev.virtualItem.index === next.virtualItem.index &&
    prev.virtualItem.start === next.virtualItem.start &&
    prev.virtualItem.size === next.virtualItem.size &&
    prev.item === next.item &&
    prev.paddingClass === next.paddingClass &&
    prev.rowYClass === next.rowYClass &&
    prev.registerMessage === next.registerMessage &&
    prev.onUndo === next.onUndo &&
    prev.onFork === next.onFork &&
    prev.canUndo === next.canUndo &&
    prev.forkMap === next.forkMap &&
    prev.turnDurationMap === next.turnDurationMap &&
    prev.turnLatestAssistantIds === next.turnLatestAssistantIds &&
    prev.allowStreamingLayoutAnimation === next.allowStreamingLayoutAnimation &&
    prev.measureElement === next.measureElement &&
    prev.onEntryGrowComplete === next.onEntryGrowComplete &&
    prev.sessionId === next.sessionId &&
    prev.onHydrateTurn === next.onHydrateTurn,
)

// ─── 会话缓存（LRU 16） ───────────────────────────────────────

const sessionCache = new Map<string, { measurements: VirtualItem[] }>()

// ─── ChatArea ────────────────────────────────────────────────

export const ChatArea = memo(
  forwardRef<ChatAreaHandle, ChatAreaProps>(
    (
      {
        messages,
        visibleMessages: visibleMessagesProp,
        visibleMessageEntries: visibleMessageEntriesProp,
        forkTargetIdMap: forkTargetIdMapProp,
        turnDurationMap: turnDurationMapProp,
        turnLatestAssistantIds: turnLatestAssistantIdsProp,
        sessionId,
        isStreaming = false,
        allowStreamingLayoutAnimation = false,
        loadState = 'idle',
        loadError,
        connectionError,
        onOpenSettings,
        onReloadSession,
        hasMoreHistory = false,
        hasTrimmedHistory = false,
        onLoadMore,
        onHydrateTurn,
        onUndo,
        onFork,
        canUndo,
        registerMessage,
        retryStatus = null,
        bottomPadding = 0,
        onVisibleMessageIdsChange,
        onAtBottomChange,
      },
      ref,
    ) => {
      const { t } = useTranslation('chat')
      const { processCollapseEnabled } = useTheme()
      const { presentation } = useChatViewport()
      const atBottomThreshold = presentation.isCompact ? 150 : AT_BOTTOM_THRESHOLD_PX
      const paddingClass = getContentPaddingClass(presentation.isCompact)

      // ── 派生数据 ──
      const entries = useMemo(
        () => visibleMessageEntriesProp ?? buildVisibleMessageEntries(messages),
        [messages, visibleMessageEntriesProp],
      )
      const visibleMessages = useMemo(
        () => visibleMessagesProp ?? entries.map(e => e.message),
        [entries, visibleMessagesProp],
      )
      const forkMap = useMemo(
        () => forkTargetIdMapProp ?? new Map(entries.map(e => [e.message.info.id, getVisibleMessageForkTargetId(e)])),
        [forkTargetIdMapProp, entries],
      )
      const turnDurationMap = useMemo(
        () => turnDurationMapProp ?? buildTurnDurationMap(messages, visibleMessages),
        [messages, turnDurationMapProp, visibleMessages],
      )
      const turnLatestAssistantIds = useMemo(
        () => turnLatestAssistantIdsProp ?? buildTurnLatestAssistantIdSet(visibleMessages),
        [turnLatestAssistantIdsProp, visibleMessages],
      )

      // 空 Working 壳闸门：入场完成 + 额外停顿；idle 清空；有 assistant 立刻挂
      const emptyShellGate = useEmptyWorkingShellGate(isStreaming, EMPTY_WORKING_SHELL_EXTRA_DELAY_MS)

      // 过程折叠：按 user 回合建时间线；关闭时退回「一行一条消息」
      // previous 用于 item 级 structural sharing：流式只脏热行，VirtualRow memo 才能命中
      // 折叠开关切换时不跨模式复用（flat 与 process-shell 的 key 语义不同）
      const previousTimelineRef = useRef<{
        processCollapseEnabled: boolean
        items?: ProcessTimelineItem[]
      }>({ processCollapseEnabled })
      const timeline = useMemo<ProcessTimelineItem[]>(() => {
        const next = !processCollapseEnabled
          ? visibleMessages.map(message => ({
              kind: 'message' as const,
              key: message.info.id,
              message,
            }))
          : buildProcessTimeline(visibleMessages, {
              turnDurationMap,
              sessionIsStreaming: isStreaming,
              messageHasProcess: messageHasProcessContent,
              messageHasFinal: messageHasFinalContent,
              isUserEntryReady: emptyShellGate.isReady,
            })
        const previous =
          previousTimelineRef.current.processCollapseEnabled === processCollapseEnabled
            ? previousTimelineRef.current.items
            : undefined
        const reused = reuseProcessTimelineItems(previous, next)
        previousTimelineRef.current = { processCollapseEnabled, items: reused }
        return reused
        // emptyShellGate.version：额外延迟到期后强制重算，挂上 Working 壳
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [
        processCollapseEnabled,
        visibleMessages,
        turnDurationMap,
        isStreaming,
        emptyShellGate.version,
        emptyShellGate.isReady,
      ])

      const messageIdToTimelineIndex = useMemo(() => {
        const map = new Map<string, number>()
        timeline.forEach((item, index) => {
          if (item.kind === 'message') {
            map.set(item.message.info.id, index)
            return
          }
          if (item.userMessageId) map.set(item.userMessageId, index)
          for (const child of item.children) map.set(child.message.info.id, index)
          if (item.finalMessage) map.set(item.finalMessage.info.id, index)
        })
        return map
      }, [timeline])

      // ── Refs（避免闭包过期） ──
      const scrollRef = useRef<HTMLDivElement | null>(null)
      const contentRef = useRef<HTMLDivElement | null>(null)
      const sessionIdRef = useRef(sessionId)
      sessionIdRef.current = sessionId
      const onLoadMoreRef = useRef(onLoadMore)
      onLoadMoreRef.current = onLoadMore
      const onVisibleIdsRef = useRef(onVisibleMessageIdsChange)
      onVisibleIdsRef.current = onVisibleMessageIdsChange
      const onAtBottomRef = useRef(onAtBottomChange)
      onAtBottomRef.current = onAtBottomChange
      // 「上滑还能拿到东西」= 服务端还有更早 或 本地有被裁缺口。
      // 注意：查询已被裁剪的缺口属于恢复性加载，不产出新内容，因此不能用来
      // 驱动「自动补齐视口」(fill) 之外的循环触发 —— 见 fill 中的二次判定。
      const canLoadMoreHistory = hasMoreHistory || hasTrimmedHistory
      const canLoadMoreRef = useRef(canLoadMoreHistory)
      canLoadMoreRef.current = canLoadMoreHistory
      const loadStateRef = useRef(loadState)
      loadStateRef.current = loadState
      const thresholdRef = useRef(atBottomThreshold)
      thresholdRef.current = atBottomThreshold

      const [isLoadingMore, setIsLoadingMore] = useState(false)
      const loadingMoreRef = useRef(false)

      // ── 自动滚动 ──
      // userScrolled 判定用小阈值（10px），和 UI 回底按钮的 60/150 阈值分开。
      // 否则上滚一点点仍在“底部区”里，userScrolled 会被立刻清掉，
      // 再碰上最后一条 HTML 时钟每秒重测 → scrollToEnd，怎么滚都拉回底。
      const auto = useAutoScroll(10)
      const autoSetScrollRef = auto.setScrollRef
      const autoSetContentRef = auto.setContentRef
      const autoHandleScroll = auto.handleScroll
      const autoHandleWheel = auto.handleWheel
      const autoHandleInteraction = auto.handleInteraction
      const autoForceScroll = auto.forceScrollToBottom
      const autoScrollBottom = auto.scrollToBottom
      const autoPause = auto.pause
      const autoMarkAuto = auto.markAuto
      const userScrolledRef = auto.userScrolledRef
      const spacerHeight = bottomSpacerHeight(bottomPadding)
      // 贴底判断必须读 ref：wheel→stop 后 state 还没 re-render，
      // 若仍用 state，同一帧的 ResizeObserver 会误判仍可贴底。
      //
      // 用 useCallback 固定引用（依赖 userScrolledRef，后者来自 useAutoScroll 且稳定）：
      // 它被多个 useLayoutEffect 读取，若每次 render 都是新函数，把这些 effect 的
      // 依赖补全后会导致它们每帧都重跑，反而破坏贴底/重试条的既有行为。
      const shouldAnchorBottom = useCallback(() => !userScrolledRef.current, [userScrolledRef])

      // ── 滚动状态（同步计算，不使用 rAF） ──
      // prevState.bottom 仍是几何贴底，给 scrollToBottomIfAtBottom 用。
      // onAtBottomChange 给输入区 dock / 回底按钮：只反映 !userScrolled（用户意图），
      // 不跟 dist——流式长高那一帧 dist 会越过阈值，会把 isCollapsed 抖翻。
      const prevState = useRef({ overflow: false, bottom: true, jump: false })
      const computeScrollState = useCallback(() => {
        const el = scrollRef.current
        if (!el) return
        const max = el.scrollHeight - el.clientHeight
        const dist = max - el.scrollTop
        const overflow = max > 1
        const bottom = !overflow || dist <= thresholdRef.current
        const jump = overflow && dist > Math.max(400, el.clientHeight)
        const p = prevState.current
        if (p.overflow !== overflow || p.bottom !== bottom || p.jump !== jump) {
          prevState.current = { overflow, bottom, jump }
        }
      }, [])

      // 输入区折叠 / 回底按钮：只跟用户是否主动离底
      useEffect(() => {
        onAtBottomRef.current?.(!auto.userScrolled)
      }, [auto.userScrolled])

      // ── Virtualizer ──
      // parent key={sessionId} remount 后，这里只在 mount 时读一次 cache
      // cache key 必须带过程折叠模式：flat 与 process 的 item key/高度完全不同
      const cacheKey = sessionId ? sessionCacheKey(sessionId, processCollapseEnabled) : null
      const initialCacheRef = useRef(cacheKey ? sessionCache.get(cacheKey)?.measurements : undefined)
      const coldBottomMount = !initialCacheRef.current?.length
      const [renderOverscan, setRenderOverscan] = useState(initialCacheRef.current?.length || coldBottomMount ? 6 : 15)
      // 内容列宽拖拽中：宽度逐帧变化会让每个已渲染行重排、测量、重渲染。
      // 期间把 overscan 降到 0，只保留视口内的行参与重排，显著减少每帧工作量。
      const isWidthDragging = useSyncExternalStore(subscribeChatWidthDrag, getChatWidthDragging, getChatWidthDragging)
      // 输入框收起/展开变形中：几何逐帧变化，同样把 overscan 降到 0，
      // 只保留视口内的行参与重排，给动画腾出主线程（与宽度拖拽同源）。
      const isInputMorphing = useSyncExternalStore(subscribeChatMorphing, getChatMorphing, getChatMorphing)
      const effectiveOverscan = isWidthDragging || isInputMorphing ? 0 : renderOverscan
      const resizePinnedRef = useRef<number[]>([])
      const resizePinFrame = useRef<number | undefined>(undefined)
      const resizeAnchorScheduled = useRef(false)
      /** 流式热行 pin：ref 更新，不碰贴底/SSE 路径 */
      const hotPinnedRef = useRef<number[]>([])
      hotPinnedRef.current = getStreamingHotIndexes(timeline.length, isStreaming)

      // 冷启动估在底部：有 cache 用 cache 总高，否则 estimate*count + paddingEnd。
      // 不用 MAX_SAFE_INTEGER（单列 range 不会向前扩，只会渲染最后一项）。
      const estimatedBottomOffset = useMemo(() => {
        const cached = initialCacheRef.current
        if (cached?.length) {
          const last = cached[cached.length - 1]
          return Math.max(0, (last?.end ?? 0) + spacerHeight - 600)
        }
        const estimatedTotal = timeline.reduce((sum, item) => sum + estimateTimelineItemSize(item), 0)
        return Math.max(0, estimatedTotal + spacerHeight - 600)
        // 只在 mount 用初始 count 估一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: timeline.length,
        getScrollElement: () => scrollRef.current,
        initialOffset: estimatedBottomOffset,
        initialMeasurementsCache: initialCacheRef.current,
        estimateSize: index => estimateTimelineItemSize(timeline[index]),
        getItemKey: i => timeline[i]?.key ?? `removed:${i}`,
        // 输入框占位放在消息区外（retry/error 之后），避免重试提示被压到输入框下面
        paddingEnd: 0,
        scrollEndThreshold: 80,
        // 预写 total height，避免浏览器把新 offset clamp 到旧高度（oc 同款）
        scrollToFn: (offset, options, instance) => {
          if (contentRef.current) contentRef.current.style.height = `${instance.getTotalSize()}px`
          autoMarkAuto(scrollRef.current)
          elementScroll(offset, options, instance)
        },
        anchorTo: 'end',
        followOnAppend: false,
        // 实际生效的是下方 rangeExtractor 里的 renderOverscan（6→15）；
        // 这里与之一致，避免出现「配置写着 50、实际按 15 渲染」的误导。
        overscan: 15,
        directDomUpdates: true,
        directDomUpdatesMode: 'transform',
        rangeExtractor: range => {
          const indexes = defaultRangeExtractor({ ...range, overscan: effectiveOverscan })
          return mergeVirtualRangeIndexes(indexes, resizePinnedRef.current, hotPinnedRef.current)
        },
      })

      // 一次性 overrides（resizeItem + shouldAdjust）——对齐 oc
      const overridesApplied = useRef(false)
      if (!overridesApplied.current) {
        const origResize = virtualizer.resizeItem
        virtualizer.resizeItem = (index: number, size: number) => {
          const item = virtualizer.measurementsCache[index]
          const prev = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
          const root = scrollRef.current
          if (root && prev !== undefined && Math.abs(size - prev) > root.clientHeight) {
            const view = root.getBoundingClientRect()
            resizePinnedRef.current = [...root.querySelectorAll<HTMLElement>('[data-index]')]
              .filter(el => {
                const r = el.getBoundingClientRect()
                return r.bottom > view.top && r.top < view.bottom
              })
              .map(el => Number(el.dataset.index))
            if (resizePinFrame.current !== undefined) cancelAnimationFrame(resizePinFrame.current)
            resizePinFrame.current = requestAnimationFrame(() => {
              resizePinFrame.current = requestAnimationFrame(() => {
                resizePinFrame.current = undefined
                resizePinnedRef.current = []
              })
            })
          }
          // 核心修复：用户已上滚（userScrolledRef）时，临时关掉 anchorTo:'end'，
          // 阻止 virtual-core resizeItem 内部的 wasAtEnd 路径（applyScrollAdjustment 拉回）。
          // wasAtEnd 用 getVirtualDistanceFromEnd()（基于内部 scrollOffset），
          // 但 React commit 阶段 ref 回调触发 measureElement 时 scroll 事件还没 fire，
          // scrollOffset 是陈旧的（仍指向底部），wasAtEnd 误判为 true → 拉回。
          // userScrolledRef 由 handleWheel 上滚设 true，只由 handleWheel 下滚回底设 false，
          // handleScroll 不清它（避免流式增长推回时误清）。
          if (userScrolledRef.current) {
            const opts = virtualizer.options
            const origAnchor = opts.anchorTo
            opts.anchorTo = 'start'
            origResize(index, size)
            opts.anchorTo = origAnchor
          } else {
            origResize(index, size)
          }
          if (root && shouldAnchorBottom() && !resizeAnchorScheduled.current && virtualizer.isAtEnd?.(80)) {
            resizeAnchorScheduled.current = true
            queueMicrotask(() => {
              resizeAnchorScheduled.current = false
              if (!shouldAnchorBottom()) return
              if (!virtualizer.isAtEnd?.(80)) return
              const el = scrollRef.current
              if (!el) return
              autoMarkAuto(el)
              const max = Math.max(0, el.scrollHeight - el.clientHeight)
              if (max - el.scrollTop >= 2) el.scrollTop = max
            })
          }
        }
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
          item: VirtualItem,
          _delta: number,
          instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
        ) => {
          if (shouldAnchorBottom()) return false
          // scrollAdjustments 与 getScrollOffset 是 virtual-core 的 private 成员，
          // 但对齐 oc 的行为依赖它们。private 成员无法用交叉类型扩展（会被收窄为
          // never），因此经 unknown 断言为描述所依赖形态的局部类型，而非 any。
          const internals = instance as unknown as {
            scrollAdjustments?: number
            getScrollOffset?: () => number
          }
          return item.end <= (internals.getScrollOffset?.() ?? 0) + (internals.scrollAdjustments ?? 0)
        }
        overridesApplied.current = true
      }

      // ── 历史加载（prepend 锚点） ──
      const prependAnchor = useRef<{ key: string; offset: number } | undefined>(undefined)
      const prependFrame = useRef<number | undefined>(undefined)
      // 异步加载在途。期间不允许新的加载，且不接受用户手势取消
      // （否则锚点会在内容到达前被丢掉，视口跳一下）。
      const prependFetching = useRef(false)
      // 锚点恢复（pin）过程中。恢复要跑若干帧 rAF 去追虚拟行的测量结果，
      // 这段时间视口被钉住，用户上滚会被抵消。所以用户手势要能立刻解除它，
      // 否则表现为「加载完一段后上滚没反应，得先下滚再上滚」。
      const prependPinning = useRef(false)
      // 恢复稳定后回调：用于重新判断是否已到顶、需要继续加载
      const prependSettled = useRef<(() => void) | undefined>(undefined)
      // 是否处于「历史加载流程」中（取景 / 在途 / 恢复）。
      // onScroll 靠它避免在恢复期间重复触发加载。
      const prependLoading = useRef(false)

      const stopPinFrame = useCallback(() => {
        prependPinning.current = false
        if (prependFrame.current !== undefined) {
          cancelAnimationFrame(prependFrame.current)
          prependFrame.current = undefined
        }
      }, [])

      const clearPrepend = useCallback(() => {
        prependLoading.current = false
        prependFetching.current = false
        prependAnchor.current = undefined
        prependSettled.current = undefined
        stopPinFrame()
      }, [stopPinFrame])

      const updatePrependAnchor = useCallback(() => {
        const root = scrollRef.current
        if (!root) return
        const view = root.getBoundingClientRect()
        const anchor = [...root.querySelectorAll<HTMLElement>('[data-timeline-key]')]
          .map(el => ({ el, rect: el.getBoundingClientRect() }))
          .filter(x => x.rect.bottom > view.top && x.rect.top < view.bottom)
          .sort((a, b) => a.rect.top - b.rect.top)[0]
        if (anchor?.el.dataset.timelineKey) {
          prependAnchor.current = { key: anchor.el.dataset.timelineKey, offset: anchor.rect.top - view.top }
        }
      }, [])

      // 用户手势：结束 pin，把控制权交回用户。
      // 在途请求期间不能直接丢弃锚点（内容到达后就没有参照、视口会跳），
      // 改为按用户当前视口重新取锚点，之后仍做一次恢复。
      const releasePrependPin = useCallback(() => {
        if (!prependLoading.current) return
        if (prependFetching.current) {
          updatePrependAnchor()
          return
        }
        clearPrepend()
      }, [clearPrepend, updatePrependAnchor])

      const applyPrependAnchor = useCallback(() => {
        const root = scrollRef.current
        const finish = () => {
          prependPinning.current = false
          prependLoading.current = false
          prependAnchor.current = undefined
          prependSettled.current?.()
        }
        if (!root || !prependAnchor.current) {
          finish()
          return
        }
        if (prependFrame.current !== undefined) cancelAnimationFrame(prependFrame.current)
        prependPinning.current = true
        let frames = 0,
          stable = 0
        const apply = () => {
          prependFrame.current = undefined
          const a = prependAnchor.current
          if (!a) {
            finish()
            return
          }
          const el = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(a.key)}"]`)
          const delta = el ? el.getBoundingClientRect().top - root.getBoundingClientRect().top - a.offset : undefined
          if (delta !== undefined && Math.abs(delta) > 0.5) {
            root.scrollTop += delta
            stable = 0
          } else stable++
          // stable 阈值保持小：虚拟行测量在 prepend 后一两帧内就稳定了，
          // 原先 30 帧（约 0.5s）会把视口多钉半秒，上滚被抵消。
          if (++frames >= 180 || stable >= 3) {
            finish()
            return
          }
          prependFrame.current = requestAnimationFrame(apply)
        }
        prependFrame.current = requestAnimationFrame(apply)
      }, [])

      const capturePrepend = useCallback(() => {
        prependLoading.current = true
        prependFetching.current = true
        updatePrependAnchor()
      }, [updatePrependAnchor])

      const loadMore = useCallback(() => {
        capturePrepend()
        setIsLoadingMore(true)
        loadingMoreRef.current = true
        Promise.resolve(onLoadMoreRef.current?.())
          .catch(() => {})
          .finally(() => {
            setIsLoadingMore(false)
            loadingMoreRef.current = false
            prependFetching.current = false
            applyPrependAnchor()
          })
      }, [capturePrepend, applyPrependAnchor])

      // 锚点恢复稳定后：若用户仍在顶部、还有历史，继续加载下一段。
      // 这样连续上滚可以「一段接一段」，不必先下滚再上滚。
      useEffect(() => {
        prependSettled.current = () => {
          if (loadingMoreRef.current || !canLoadMoreRef.current) return
          const el = scrollRef.current
          if (!el) return
          if (el.scrollTop > LOAD_MORE_TOP_THRESHOLD) return
          loadMore()
        }
        return () => {
          prependSettled.current = undefined
        }
      }, [loadMore])

      // fill: 内容不足以填满视口时自动加载
      const fillFrame = useRef<number | undefined>(undefined)
      const fill = useCallback(() => {
        if (fillFrame.current !== undefined) return
        fillFrame.current = requestAnimationFrame(() => {
          fillFrame.current = undefined
          if (!sessionIdRef.current || loadStateRef.current !== 'loaded') return
          if (userScrolledRef.current || loadingMoreRef.current) return
          const el = scrollRef.current
          if (el && el.scrollHeight > el.clientHeight + 1) return
          if (!canLoadMoreRef.current) return
          void loadMore()
        })
      }, [loadMore, userScrolledRef])

      // ── Ref 回调 ──
      const setScrollRoot = useCallback(
        (el: HTMLDivElement | null) => {
          scrollRef.current = el
          autoSetScrollRef(el)
          if (el) {
            computeScrollState()
            fill()
          }
        },
        [autoSetScrollRef, computeScrollState, fill],
      )

      const setVirtualContent = useCallback(
        (el: HTMLDivElement | null) => {
          contentRef.current = el
          autoSetContentRef(el)
          virtualizer.containerRef(el)
          if (el && scrollRef.current) computeScrollState()
        },
        [autoSetContentRef, virtualizer, computeScrollState],
      )

      const pinToBottom = useCallback(() => {
        // 必须滚到整页底（含 retry/error + 输入框 spacer），不能只 scrollToEnd 虚拟消息区
        const el = scrollRef.current
        if (!el) return
        autoMarkAuto(el)
        const max = Math.max(0, el.scrollHeight - el.clientHeight)
        if (max - el.scrollTop >= 2) el.scrollTop = max
      }, [autoMarkAuto])

      // ── 事件处理 ──
      const onScroll = useCallback(() => {
        computeScrollState()
        if (
          userScrolledRef.current &&
          !prependLoading.current &&
          (scrollRef.current?.scrollTop ?? 0) < LOAD_MORE_TOP_THRESHOLD &&
          !loadingMoreRef.current &&
          canLoadMoreRef.current
        ) {
          void loadMore()
        }
        // 始终走 handleScroll：滚动条/键盘也能离底；程序贴底靠 markAuto 过滤
        autoHandleScroll()
      }, [computeScrollState, autoHandleScroll, loadMore, userScrolledRef])

      const onWheel = useCallback(
        (e: React.WheelEvent<HTMLDivElement>) => {
          // 用户手势优先：立刻结束锚点恢复，把视口交还用户。
          // 在途请求不受影响（进行中的请求仍会按新锚点做一次恢复）。
          releasePrependPin()
          autoHandleWheel(e.nativeEvent)

          // 兜底：已在顶部时继续上滚不会产生 scroll 事件（scrollTop 已是 0），
          // 只靠 onScroll 就会漏掉这次意图。这里直接按手势补触发一次加载。
          const el = scrollRef.current
          if (
            e.deltaY < 0 &&
            userScrolledRef.current &&
            !prependLoading.current &&
            !loadingMoreRef.current &&
            canLoadMoreRef.current &&
            el &&
            el.scrollTop <= LOAD_MORE_TOP_THRESHOLD
          ) {
            void loadMore()
          }
        },
        [autoHandleWheel, releasePrependPin, loadMore, userScrolledRef, canLoadMoreRef, prependLoading],
      )

      const onTouchStart = useCallback(() => {
        releasePrependPin()
      }, [releasePrependPin])

      // ── Effects（parent key remount 后，这里只处理本实例生命周期） ──

      // 冷启动 / 回流：双 rAF 贴底 + 抬 overscan（对齐 oc onMount）
      useEffect(() => {
        let cancelled = false
        let outer = 0
        let inner = 0
        outer = requestAnimationFrame(() => {
          if (cancelled) return
          if (shouldAnchorBottom()) pinToBottom()
          inner = requestAnimationFrame(() => {
            if (cancelled) return
            if (renderOverscan < 15) setRenderOverscan(15)
            if (shouldAnchorBottom()) pinToBottom()
          })
        })
        return () => {
          cancelled = true
          cancelAnimationFrame(outer)
          cancelAnimationFrame(inner)
        }
        // mount-only
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // rows 变化且应贴底时再确认一次（append / 首批消息）
      // prepend 由 anchorTo + prepend 锚点处理，这里在用户已离底时不跟
      useLayoutEffect(() => {
        if (timeline.length === 0) return
        if (!shouldAnchorBottom() || prependLoading.current) return
        pinToBottom()
      }, [timeline.length, pinToBottom, shouldAnchorBottom])

      // retry/error 出现消失、输入框高度变 → 底部 footer 高度变，贴底时要跟着滚
      // 否则重试条进出后 scrollTop 停在旧位置，看起来没贴底
      const footerPinKey = `${retryStatus ? 'r' : ''}|${loadError || connectionError ? 'e' : ''}|${spacerHeight}`
      useLayoutEffect(() => {
        if (!shouldAnchorBottom() || prependLoading.current) return
        pinToBottom()
        // 展开重试详情等会在下一帧才量完高度
        const frame = requestAnimationFrame(() => {
          if (shouldAnchorBottom()) pinToBottom()
        })
        return () => cancelAnimationFrame(frame)
      }, [footerPinKey, pinToBottom, shouldAnchorBottom])

      // 用户返回底部时重新贴底
      const userScrolledInit = useRef(false)
      useEffect(() => {
        if (!userScrolledInit.current) {
          userScrolledInit.current = true
          return
        }
        if (auto.userScrolled) return
        const frame = requestAnimationFrame(() => {
          autoScrollBottom()
          pinToBottom()
        })
        return () => cancelAnimationFrame(frame)
      }, [auto.userScrolled, autoScrollBottom, pinToBottom])

      // fill effect
      useEffect(() => {
        if (!sessionId || loadState !== 'loaded' || isLoadingMore || auto.userScrolled || !canLoadMoreHistory) return
        fill()
      }, [sessionId, loadState, isLoadingMore, auto.userScrolled, canLoadMoreHistory, fill])

      // unmount：snapshot 写回 cache（对齐 oc onCleanup）
      useLayoutEffect(() => {
        const key = cacheKey
        return () => {
          if (fillFrame.current !== undefined) cancelAnimationFrame(fillFrame.current)
          if (resizePinFrame.current !== undefined) cancelAnimationFrame(resizePinFrame.current)
          clearPrepend()
          if (!key) return
          sessionCache.delete(key)
          sessionCache.set(key, { measurements: virtualizer.takeSnapshot() })
          while (sessionCache.size > SESSION_CACHE_LIMIT) {
            sessionCache.delete(sessionCache.keys().next().value!)
          }
        }
      }, [cacheKey, virtualizer, clearPrepend])

      // ── 渲染数据 ──
      const items = virtualizer.getVirtualItems()
      const mountedMessageIdsKey = useMemo(
        () =>
          items
            .map(item => timeline[item.index]?.key)
            .filter(Boolean)
            .join(','),
        [items, timeline],
      )

      // Outline 可见消息：跟随虚拟行挂载变化
      useEffect(() => {
        const root = scrollRef.current
        if (!root) return
        const visible = new Set<string>()
        const observer = new IntersectionObserver(
          entries => {
            let changed = false
            for (const entry of entries) {
              const id = entry.target.getAttribute('data-message-id')
              if (!id) continue
              if (entry.isIntersecting) {
                if (!visible.has(id)) {
                  visible.add(id)
                  changed = true
                }
              } else if (visible.has(id)) {
                visible.delete(id)
                changed = true
              }
            }
            if (changed) onVisibleIdsRef.current?.(Array.from(visible))
          },
          { root, rootMargin: '100% 0px' },
        )
        root.querySelectorAll<HTMLElement>('[data-message-id]').forEach(el => observer.observe(el))
        return () => observer.disconnect()
      }, [mountedMessageIdsKey])

      // ── 命令式接口 ──
      useImperativeHandle(
        ref,
        () => ({
          scrollToBottom: () => {
            autoForceScroll()
            pinToBottom()
          },
          scrollToBottomIfAtBottom: () => {
            // userScrolled 守卫：用户上滚后 userScrolled=true，此函数由 onScrollRequest
            //（每个 SSE chunk）调用。autoForceScroll() 的 force=true 会清掉 userScrolled，
            // 导致 resizeItem 的 anchorTo toggle 失效 → wasAtEnd 恢复拉回。
            // 不在此处清 userScrolled——用户主动下滚回底时 handleWheel 会清。
            // 正常贴底跟随（userScrolled=false 时）不受影响。
            if (userScrolledRef.current) return
            if (!prevState.current.bottom) return
            autoForceScroll()
            pinToBottom()
          },
          scrollToLastMessage: () => {
            if (timeline.length === 0) return
            autoMarkAuto(scrollRef.current)
            virtualizer.scrollToIndex(timeline.length - 1, { align: 'end' })
          },
          scrollToMessageIndex: (index: number) => {
            // index 仍按 visibleMessages 语义；过程折叠时映射到 timeline 行
            if (index < 0 || index >= visibleMessages.length) return
            const messageId = visibleMessages[index]?.info.id
            const timelineIndex = messageId != null ? (messageIdToTimelineIndex.get(messageId) ?? index) : index
            if (timelineIndex < 0 || timelineIndex >= timeline.length) return
            autoPause()
            virtualizer.scrollToIndex(timelineIndex, { align: 'center' })
          },
          scrollToMessageId: (messageId: string) => {
            const timelineIndex = messageIdToTimelineIndex.get(messageId)
            if (timelineIndex == null) return
            autoPause()
            virtualizer.scrollToIndex(timelineIndex, { align: 'center' })
          },
        }),
        [
          autoForceScroll,
          autoPause,
          autoMarkAuto,
          pinToBottom,
          virtualizer,
          timeline,
          visibleMessages,
          messageIdToTimelineIndex,
          // refs 恒定，入依赖只是满足 lint 且语义不变
          userScrolledRef,
          prevState,
        ],
      )

      return (
        <div className="h-full overflow-hidden contain-strict relative">
          {loadState === 'loading' && visibleMessages.length === 0 && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <div className="session-loading-indicator">
                <LoadingState label={t('chatArea.loadingSession')} />
              </div>
            </div>
          )}

          <div
            ref={setScrollRoot}
            data-chat-scroll-root="true"
            className="h-full overflow-y-auto overflow-x-hidden custom-scrollbar contain-content"
            style={{
              overflowAnchor: 'none',
              // 顶栏高度 + 呼吸空间：与 Header 共用 --chat-header-height，
              // 改顶栏高度时消息首行不会被压住
              paddingTop: 'calc(var(--chat-header-height, 2.75rem) + 1.5rem + var(--app-safe-top, 0px))',
            }}
            onWheel={onWheel}
            onTouchStart={onTouchStart}
            onScroll={onScroll}
            onClick={autoHandleInteraction}
          >
            {visibleMessages.length > 0 && isLoadingMore && (
              <div className="flex justify-center py-3" aria-live="polite">
                <LoadingState label={t('chatArea.loadingHistory')} size="sm" layout="row" showElapsed={false} />
              </div>
            )}

            <div ref={setVirtualContent} style={{ position: 'relative', width: '100%' }}>
              {items.map(item => {
                const timelineItem = timeline[item.index]
                if (!timelineItem) return null
                return (
                  <VirtualRow
                    key={item.key}
                    virtualItem={item}
                    item={timelineItem}
                    paddingClass={paddingClass}
                    rowYClass={getTimelineRowYClass(timelineItem, timeline[item.index - 1], timeline[item.index + 1])}
                    registerMessage={registerMessage}
                    onUndo={onUndo}
                    onFork={onFork}
                    canUndo={canUndo}
                    forkMap={forkMap}
                    turnDurationMap={turnDurationMap}
                    turnLatestAssistantIds={turnLatestAssistantIds}
                    allowStreamingLayoutAnimation={allowStreamingLayoutAnimation}
                    measureElement={virtualizer.measureElement as (el: HTMLElement | null) => void}
                    onEntryGrowComplete={emptyShellGate.onEntryGrowComplete}
                    sessionId={sessionId}
                    onHydrateTurn={onHydrateTurn}
                  />
                )
              })}
            </div>

            {/* 顺序必须是：消息 → 重试/错误提示 → 输入框占位。
                旧 Virtuoso Footer 就是这样；换 virtualizer 后 paddingEnd 在前、提示在后，会叠到输入框下。 */}
            {retryStatus && (
              <div className={`w-full mx-auto ${paddingClass}`} style={chatContentMaxWidthStyle}>
                <div className="flex justify-start">
                  <div className="w-full min-w-0">
                    <RetryStatusInline status={retryStatus} />
                  </div>
                </div>
              </div>
            )}

            {visibleMessages.length === 0 && (loadError || connectionError) && (
              <div className={`w-full mx-auto ${paddingClass}`} style={chatContentMaxWidthStyle}>
                <div className="flex justify-start">
                  <div className="w-full min-w-0 space-y-2">
                    <MessageErrorView error={loadError ?? connectionError!} />
                    <div className="flex flex-wrap items-center gap-2">
                      {onReloadSession && (loadError || connectionError) && (
                        <button
                          type="button"
                          onClick={onReloadSession}
                          className="rounded-md border border-border-200 bg-bg-100 px-3 py-1.5 text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200"
                        >
                          {t('errors.reloadConversation')}
                        </button>
                      )}
                      {connectionError && onOpenSettings && (
                        <button
                          type="button"
                          onClick={onOpenSettings}
                          className="rounded-md border border-border-200 bg-bg-100 px-3 py-1.5 text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200"
                        >
                          {t('connectionError.openServerSettings')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div style={{ height: spacerHeight }} aria-hidden="true" />
          </div>
        </div>
      )
    },
  ),
)
