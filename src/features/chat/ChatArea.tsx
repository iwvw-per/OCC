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
import { MessageRenderer, ProcessCollapseBlock, TodoList, messageHasFinalContent, messageHasProcessContent } from '../message'
import { MessageErrorView } from '../message/parts'
import type { ChangedFile } from '../message/parts/changedFiles'
import type { Message, MessageError } from '../../types/message'
import { normalizeTodos } from '../../utils/todoSource'
import { RetryStatusInline, type RetryStatusInlineData } from './RetryStatusInline'
import { InlineQuestion } from './InlineQuestion'
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
  shouldShowCompactionDivider,
  type ProcessTimelineItem,
} from './chatPageModel'
import { useTheme } from '../../hooks/useTheme'
import { LoadingState } from '../../components/ui/LoadingState'
import { getStreamingHotIndexes, getTimelineRowYClass, mergeVirtualRangeIndexes } from './chatAreaUtils'
import { computePrependRestoreScrollTop } from './chatPageModel'
import { estimateTimelineItemSize, processActiveLabel, processReasoningCount, processStepCount, sessionCacheKey } from './chatAreaTimeline'
import { chatContentMaxWidthStyle, getContentPaddingClass } from './contentWidth'
import { getChatWidthDragging, subscribeChatWidthDrag } from './chatWidthDrag'
import { getChatMorphing, subscribeChatMorphing } from './chatMorph'
import { useAutoScroll } from './virtual/useAutoScroll'
import { useEmptyWorkingShellGate } from './virtual/useEmptyWorkingShellGate'

const NOOP = () => {}
/** 过程壳 header 行高（Working / Worked 一行） */
/** 用户入场生长结束后，空 Working 壳再等多久（有 assistant 则立刻挂，不等） */
const EMPTY_WORKING_SHELL_EXTRA_DELAY_MS = 500
const DEFAULT_BOTTOM_SPACER = 256
const SESSION_CACHE_LIMIT = 16
/** 距顶部多少 px 内视为「已到顶」，触发加载更早一段历史 */
const LOAD_MORE_TOP_THRESHOLD = 200

const bottomSpacerHeight = (bottomPadding: number) => (bottomPadding > 0 ? bottomPadding + 48 : DEFAULT_BOTTOM_SPACER)

/** 无改动时的稳定空数组（避免每次渲染新建引用） */
const EMPTY_FILES: ChangedFile[] = []

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
  /** 最近一次已完成压缩的时间戳；有值时在消息流末尾显示「历史已压缩」分隔条 */
  compactedAt?: number
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
  /** 内嵌模式（inlineToolRequests）下未匹配到工具的待处理提问，渲染在消息流末尾 */
  inlineQuestions?: Array<{
    request: import('../../api').ApiQuestionRequest
    onReply: (answers: import('../../api').QuestionAnswer[]) => void
    onReject: () => void
    isReplying?: boolean
  }>
}

export type ChatAreaHandle = {
  scrollToBottom: (instant?: boolean) => void
  scrollToBottomIfAtBottom: () => void
  scrollToLastMessage: () => void
  scrollToMessageIndex: (index: number) => void
  scrollToMessageId: (messageId: string) => void
}

// ─── 虚拟行 ──────────────────────────────────────────────────

/**
 * 本轮待办卡片（常显在过程折叠块外面）。
 *
 * todowrite 是 agent 用来同步进度的信号，不是需要折叠的执行细节。此前它作为
 * 普通 tool part 被收进「Worked for 22s」折叠块（默认收起），用户看不到待办，
 * 会以为「刷新后丢了」——其实数据一直在，只是藏进了折叠块。
 *
 * 本轮可能有多次 todowrite（每次都是全量快照），只渲染最后一次：
 * 那才代表这一轮结束时的进度，全渲染会重复刷屏。
 */
const TurnTodoCards = memo(function TurnTodoCards({ messages }: { messages: Message[] }) {
  const latest = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i].content
      for (let j = content.length - 1; j >= 0; j--) {
        const part = content[j]
        if (part.type !== 'tool') continue
        const name = part.tool?.toLowerCase() ?? ''
        if (name !== 'todowrite' && name !== 'todo_write') continue
        const state = part.state
        // input 是模型写下的快照；服务端有时只在 metadata 回填，二者都认。
        const raw =
          state?.input?.todos ??
          ('metadata' in (state ?? {}) ? (state as { metadata?: Record<string, unknown> }).metadata?.todos : undefined)
        const todos = normalizeTodos(raw)
        if (todos.length > 0) return { partId: part.id, todos }
      }
    }
    return null
  }, [messages])

  if (!latest) return null

  return (
    <div className="flex flex-col gap-2" data-turn-todos>
      <TodoList todos={latest.todos} stateKey={`turn-todo:${latest.partId}`} />
    </div>
  )
})

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

      // 轮次骨架路径：工具 part 已被剥离，改动文件由主机 Agent 单独回填。
      //
      // ⚠️ 骨架只有「路径 + 增删行数」，没有 diff 正文（hunks 为空）：chip 上的
      // 数字能正常显示，但预览面板拿不到内容。这是刻意的取舍 —— diff 全文单轮
      // 可达数百 KB，正是要剥掉的东西。需要看 diff 时展开「已处理」块会回拉完整
      // tool part，届时 chip 由 collectTurnChangedFiles 重建，预览自然可用。
      const fromSkeleton: ChangedFile[] = []
      const seenPaths = new Set<string>()
      for (const message of messages) {
        for (const file of message.skeletonChangedFiles ?? []) {
          if (seenPaths.has(file.path)) continue
          seenPaths.add(file.path)
          fromSkeleton.push({
            path: file.path,
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
            hunks: [],
            editCount: 1,
          })
        }
      }
      if (fromSkeleton.length > 0) return fromSkeleton

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
            <div className="flex flex-col gap-2">
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
              {/* 不套折叠壳的轮次同样要把待办露出来：MessageRenderer 的 'all'
                  分支已剔除 todowrite，不在这里补渲染就会彻底看不到。 */}
              <TurnTodoCards messages={[item.message]} />
            </div>
          ) : (
            <div className="flex justify-start">
              <div className="message-renderer-shell min-w-0 group w-full flex flex-col gap-2">
                <ProcessCollapseBlock
                  stateKey={`turn-process:${item.userMessageId ?? item.key}`}
                  startedAt={item.startedAt}
                  durationMs={item.durationMs}
                  isActive={item.isActive}
                  forceExpanded={item.children.some(child => child.processContentScope === 'all')}
                  stepCount={processStepCount(item.children)}
                  reasoningCount={processReasoningCount(item.children)}
                  activeLabel={item.isActive ? processActiveLabel(item.children) : undefined}
                  onExpand={
                    item.userMessageId && onHydrateTurn
                      ? () => onHydrateTurn(item.userMessageId!)
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
                {/*
                  * 待办卡片常显：渲染在过程折叠块**外面**。
                  *
                  * todowrite 是 agent 同步进度的信号，不是需要折叠的执行细节。
                  * 之前它作为普通 tool part 被收进「Worked for 22s」折叠块（默认收起），
                  * 用户看不到待办，会以为「刷新后丢了」。
                  * 只取这一轮里最后一次 todowrite，避免同一轮多次调用时重复刷屏。
                  */}
                <TurnTodoCards messages={item.children.map(child => child.message)} />
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
    /**
     * ⚠️ 刻意**不比较** `virtualItem.start` / `size`。
     *
     * 行位置由 `transform: translateY(start)` 直接写在 DOM 上（directDomUpdates），
     * 与 React 渲染无关。而 `start` 在滚动/上方插入/行高重测时**每一行都会变**——
     * 把它放进 memo 比较，等于让「滚动一帧 = 所有已挂载行全部重渲染」，长会话里
     * 就是主对话卡顿的直接原因（一屏十几行 × 每行整棵 Markdown 子树）。
     *
     * 行内内容的正确性由 `item` 引用兜住：store 只在真正变化时换新对象。
     */
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
        compactedAt,
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
        inlineQuestions = [],
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

      /**
       * messageId → timeline 行号。
       *
       * 流式时 timeline 每帧都会换新数组（最后一行内容变了），但**行结构基本不变**。
       * 直接全量重建在长会话里是 O(全部消息) 的每帧成本（实测 7000 条消息 →
       * 每帧遍历 7000 次并写 7000 个 Map 条目）。
       *
       * 这里按「行 key 序列」做签名：序列不变就复用上一份映射（行号只由位置决定，
       * 位置没变时映射必然相同）。
       */
      const timelineIndexMapRef = useRef<{ signature: string; map: Map<string, number> } | undefined>(undefined)
      const messageIdToTimelineIndex = useMemo(() => {
        const signature = timeline.map(item => item.key).join('\u0000')
        const cached = timelineIndexMapRef.current
        if (cached && cached.signature === signature) return cached.map
        const map = new Map<string, number>()
        for (let index = 0; index < timeline.length; index++) {
          const item = timeline[index]
          if (item.kind === 'message') {
            map.set(item.message.info.id, index)
            continue
          }
          if (item.userMessageId) map.set(item.userMessageId, index)
          for (const child of item.children) map.set(child.message.info.id, index)
          if (item.finalMessage) map.set(item.finalMessage.info.id, index)
        }
        timelineIndexMapRef.current = { signature, map }
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
      /**
       * 历史加载期间的锚点行 pin。
       *
       * 向上加载时，如果 scrollTop 在 prepend 的过渡态里被钳到 0，虚拟列表的
       * 渲染窗口会跑到最顶部，**用户原来正在看的那一行立刻被卸载** ——
       * 之后按 key 再也查不到它，行内锚点补偿就永久失效（实测 el 恒为 false）。
       *
       * 把它钉在渲染范围里，那一行就始终存在于 DOM，可以持续按
       * 「行顶 - 视口顶」精确对齐，不依赖任何高度推算。
       */
      const prependPinnedRef = useRef<number[]>([])
      const prependPinnedKeyRef = useRef<string | undefined>(undefined)
      // pin 的 key 是 ref，设置它不会触发重渲染；而 rangeExtractor 只在渲染时
      // 被调用。没有这个 tick，pin 就只是写了个变量、实际不会生效
      // （这正是之前 anchor 行一直 `el === false` 的原因）。
      const [, bumpPrependPin] = useState(0)
      if (prependPinnedKeyRef.current) {
        const pinnedIndex = timeline.findIndex(item => item.key === prependPinnedKeyRef.current)
        prependPinnedRef.current = pinnedIndex >= 0 ? [pinnedIndex] : []
      } else {
        prependPinnedRef.current = []
      }

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
          return mergeVirtualRangeIndexes(
            indexes,
            resizePinnedRef.current,
            hotPinnedRef.current,
            prependPinnedRef.current,
          )
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
      //
      // 目标：向上加载更早的历史时，**用户正在看的内容必须留在原位**，
      // 新加载的内容出现在它上方（视口外），而不是把视口顶到最上面。
      //
      // 这里同时记录两个参照，缺一不可：
      //
      //   1. `key/offset`：可见行的 key 与它距视口顶部的偏移。精确，
      //      但**依赖那一行仍被渲染**。
      //   2. `distanceFromBottom`：`scrollHeight - scrollTop`。不依赖任何 DOM 行。
      //
      // 为什么必须有第 2 个：虚拟列表只渲染视口附近的行。prepend 之后如果
      // scrollTop 被设成 0，渲染窗口就跑到最顶部，原来那一行立刻被卸载 ——
      // `querySelector` 再也找不到它，锚点永久失效，于是视口就停在最上面
      // （实测：scrollTop 从 444 直接掉到 0，scrollHeight 从 7961 涨到 24210）。
      //
      // 而「距底部距离」在顶部前插时是**严格守恒**的：
      //   prepend 高度 ΔH → H' = H + ΔH，S' = S + ΔH
      //   → D' = H' - S' = H - S = D
      // 所以只要把它恢复回去，视口就精确回到原来的内容上。它只需要
      // scrollHeight/scrollTop 两个数字，与虚拟列表渲染了哪些行无关。
      const prependAnchor = useRef<
        { key: string; offset: number; distanceFromBottom: number } | undefined
      >(undefined)
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
      /**
       * 一轮「向上浏览」的事务基线。
       *
       * 一次快速上滑常常触发**多批**加载（先到阈值批一次，用户继续滑再批一次）。
       * 若每批各自以当前 scrollTop 为基线补偿，误差会逐批累积，最终把视口
       * 推到很远的地方（实测一次上滑里 sh 涨了 6557，而 st 只补了 2363）。
       *
       * 因此把基线固定在「这一轮第一次触发加载时」的位置，后续批次沿用，
       * 直到用户明确向下滚动（离开顶部区域）才重置。
       */
      const scrollSessionBaseline = useRef<number | null>(null)
      /** 同一轮向上浏览的「起始内容高度」，用于跨批累计新增高度 */
      const scrollSessionHeight = useRef<number | null>(null)

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

      /**
       * 重新取锚点。
       *
       * @param keepDistance 保留已记录的「距底部距离」。
       *
       * 加载在途时**不能**重新取距离：内容到达的那一刻 scrollTop 会被清零
       * （实测 444 → 0），此时算出来的距离是错的（`scrollHeight - 0`），
       * 用它恢复就会把视口停在半空中而不是原位。
       *
       * 所以「在途期间因用户滚动而重取锚点」只刷新行定位（key/offset，
       * 用于精确对齐），距离仍用加载开始那一刻的值。
       */
      const updatePrependAnchor = useCallback((keepDistance = false) => {
        const root = scrollRef.current
        if (!root) return
        const preservedDistance = keepDistance ? prependAnchor.current?.distanceFromBottom : undefined
        // 距底部距离：prepend 时严格守恒（见上方说明），是不依赖渲染的兜底参照
        const distanceFromBottom = preservedDistance ?? root.scrollHeight - root.scrollTop
        const view = root.getBoundingClientRect()
        const anchor = [...root.querySelectorAll<HTMLElement>('[data-timeline-key]')]
          .map(el => ({ el, rect: el.getBoundingClientRect() }))
          .filter(x => x.rect.bottom > view.top && x.rect.top < view.bottom)
          .sort((a, b) => a.rect.top - b.rect.top)[0]
        if (anchor?.el.dataset.timelineKey) {
          prependAnchor.current = {
            key: anchor.el.dataset.timelineKey,
            offset: anchor.rect.top - view.top,
            distanceFromBottom,
          }
        } else {
          // 没有可见行（极端情况：整屏都是 spacer）：只保留距离参照
          prependAnchor.current = { key: '', offset: 0, distanceFromBottom }
        }
      }, [])

      // 用户手势：结束 pin，把控制权交回用户。
      // 在途请求期间不能直接丢弃锚点（内容到达后就没有参照、视口会跳），
      // 改为按用户当前视口重新取锚点，之后仍做一次恢复。
      const releasePrependPin = useCallback(() => {
        if (!prependLoading.current) return
        if (prependFetching.current) {
          // 在途期间重取：保留加载开始时的距离（见 updatePrependAnchor 说明）
          updatePrependAnchor(true)
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
          prependPinnedKeyRef.current = undefined
          prependSettled.current?.()
        }

        /**
         * 收尾看门狗。
         *
         * rAF 循环判定稳定后仍可能有迟到的内容（图片解码完成、字体替换、
         * 补齐页晚到）把高度再撑高一段。那部分增量如果不补，视口就会相对
         * 内容上移 —— 用户看到的就是「刚加载的内容顶到上面去了」。
         *
         * 这里在收尾后的两个时间点再核对一次「目标位置 = 基线 + 新增高度」，
         * 需要就补上。只补不下移，且不改变任何状态标记。
         */
        const watchdog = (delayMs: number) => {
          setTimeout(() => {
            if (prependLoading.current) return
            const root2 = scrollRef.current
            if (!root2) return
            // 迟到的内容会把高度再撑高一段：按「基线 + 总新增高度」重新对齐。
            const target = computePrependRestoreScrollTop(baselineScrollTop, startHeight, root2.scrollHeight)
            if (target <= baselineScrollTop) return
            // 只在明显偏上时补，避免把用户主动滚动拉回去
            if (target - root2.scrollTop > 4) root2.scrollTop = target
          }, delayMs)
        }
        if (!root || !prependAnchor.current) {
          finish()
          return
        }
        if (prependFrame.current !== undefined) cancelAnimationFrame(prependFrame.current)
        prependPinning.current = true
        // 基准值：必须在 null 检查之后取，且要早于 watchdog 的闭包引用
        const startHeight = root.scrollHeight
        const baselineScrollTop = scrollSessionBaseline.current ?? root.scrollTop
        let frames = 0,
          stable = 0
        let lastHeight = root.scrollHeight
        let lastHeightFrame = 0
        /**
         * 目标：加载完成后，**之前贴在视口顶部的那些内容仍然贴在顶部**，
         * 新加载的更早内容出现在它们上方（视口之外）。
         *
         * 实现要点（踩过的坑都写在这里）：
         *
         * 1. prepend 的过渡态会让容器高度**先塌缩再回升**（实测 13181 → 5483
         *    → 13904），塌缩期间算出来的目标位置全是错的。所以用「相对上一帧
         *    的高度增量」做累计补偿，天然跳过塌缩阶段。
         *
         * 2. 触发加载的位置不是 0（阈值 200px，实测常见 100~260），必须用
         *    触发时的真实 scrollTop 作基线，否则会整体上移一截。
         *
         * 3. 补偿要停在「新内容的底部」：若只按高度增量下移，滚动后视口顶部
         *    正好是新插入内容的第一行 —— 用户看到的就是「跳到刚加载的内容」。
         *    正确目标是 `基线 + 新增高度`，此时原顶部内容仍在原处。
         */

        /**
         * 补偿策略（最终版，前面几种都试错并被实测否定）：
         *
         * 1. ❌「距底部距离」—— prepend 过渡态容器高度会先塌缩再回升
         *    （实测 13181 → 5483 → 13904），过渡期该值完全失真。
         * 2. ❌「按元素 getBoundingClientRect 对齐」—— 虚拟列表用 transform
         *    定位，锚点行一旦被移出渲染范围就取不到（实测 el 恒为 false）。
         * 3. ✅「scrollHeight 的**单调增量**」—— 只累计高度相对上一帧的
         *    **正向**增量，塌缩阶段自然被忽略；内容分几批到位就补几批。
         *
         * 关键细节：目标是「原滚动位置 + 累计新增高度」。
         * 只补增量（`scrollTop += grown`）是不够的 —— 过渡态已经把 scrollTop
         * 压到 0，那样补完会停在「新内容的顶部」，用户看到的正是「跳到刚加载
         * 的内容」。而「基线 + 总增量」让视口停在新增内容**之后**，原内容仍在
         * 视口原位。
         */
        /**
         * 跨批累计：以「这一轮向上浏览的起始高度」为基准，
         * 而不是每批重置，否则多批加载的增量会丢失（实测 sh 涨 6225 而 st 只补 1992）。
         */
        const sessionStartHeight = scrollSessionHeight.current ?? startHeight

        const apply = () => {
          prependFrame.current = undefined
          const a = prependAnchor.current
          if (!a) {
            finish()
            return
          }
          const heightNow = root.scrollHeight
          const target = computePrependRestoreScrollTop(baselineScrollTop, sessionStartHeight, heightNow)
          const delta = target - root.scrollTop

          if (Math.abs(delta) > 0.5) {
            root.scrollTop = target
            stable = 0
          } else stable++

          if (heightNow !== lastHeight) {
            lastHeight = heightNow
            lastHeightFrame = frames
          }
          // 高度需连续 10 帧（约 160ms）不再变化才算稳定：内容常分批到位
          //（图片解码、补齐页、压缩后重算高度），窗口太短会在中途收尾。
          const heightStable = frames - lastHeightFrame >= 10
          if (++frames >= 180 || (stable >= 3 && heightStable)) {
            watchdog(260)
            watchdog(900)
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
        if (scrollSessionBaseline.current === null) {
          scrollSessionBaseline.current = scrollRef.current?.scrollTop ?? 0
          scrollSessionHeight.current = scrollRef.current?.scrollHeight ?? 0
        }
        updatePrependAnchor()
        // 钉住锚点行，防止它在 prepend 过渡态里被虚拟列表卸载（见 prependPinnedRef）
        prependPinnedKeyRef.current = prependAnchor.current?.key || undefined
        // 关键：必须触发一次重渲染，rangeExtractor 才会把这一行并入渲染范围
        if (prependPinnedKeyRef.current) bumpPrependPin(n => n + 1)
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
      //
      // ⚠️ 必须等本轮恢复**彻底结束**再发起下一轮：
      // `finish()` 是在 apply 的帧回调里执行的，若在同一个回调里同步调 loadMore，
      // 新的一轮会立刻覆盖 prependAnchor，而上一轮的 rAF 循环此时还没退出 ——
      // 两个循环争抢同一个锚点，视口就会在恢复过程中被拽到别处
      // （实测连续上滑 4 轮里有 1 轮跳走）。放到下一个宏任务里启动就没这个问题。
      useEffect(() => {
        prependSettled.current = () => {
          /**
           * 不再自动级联加载。
           *
           * 旧行为：一次上滑加载完，只要还在顶部就立刻再加载一批，如此往复。
           * 结果是用户滚到顶后被**连续拽好几次**，而且每次补偿的误差会累积，
           * 越拽越偏 —— 用户感受到的就是「自动跳转到刚加载的内容」。
           *
           * 现在：一次上滑只补一批，把控制权交回用户。要更早的内容就再滚一次。
           * 这既消除了累积漂移，也让「加载多少」由用户决定。
           */
          return
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
        // 离开顶部区域即视为「这一轮上滑浏览结束」，重置事务基线
        if (!prependLoading.current && (scrollRef.current?.scrollTop ?? 0) > LOAD_MORE_TOP_THRESHOLD) {
          scrollSessionBaseline.current = null
          scrollSessionHeight.current = null
        }
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
      /**
       * 跳到某个虚拟行，并按**真实 DOM** 校正落点。
       *
       * `virtualizer.scrollToIndex` 只按「估算 + 已测量」的高度算 offset。长会话里
       * 目标之前的行绝大多数从未渲染过（只有 60px 估算值），误差会累积到成百上
       * 千像素 —— 这就是「侧边轴点用户消息，总是定位不准」的根因。
       *
       * 校正方式：滚过去 → 等目标行真的挂载 → 用它的实际 offsetTop 减去理想
       * 位置（居中 / 顶部）再补一次 scrollTop。只补一次，避免和用户滚动抢。
       */
      const scrollToTimelineIndex = useCallback(
        (index: number, align: 'center' | 'start' = 'center') => {
          if (index < 0 || index >= timeline.length) return
          const rowKey = timeline[index]?.key
          autoPause()
          virtualizer.scrollToIndex(index, { align })
          if (!rowKey) return

          let frames = 0
          let settled = 0
          const step = () => {
            const root = scrollRef.current
            if (!root) return
            const el = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(rowKey)}"]`)
            if (el) {
              const rootRect = root.getBoundingClientRect()
              const rowRect = el.getBoundingClientRect()
              const paddingTop = parseFloat(getComputedStyle(root).paddingTop) || 0
              const desiredTop =
                align === 'center'
                  ? rootRect.top + paddingTop + (root.clientHeight - paddingTop - rowRect.height) / 2
                  : rootRect.top + paddingTop
              const delta = rowRect.top - desiredTop
              // 阈值 2px：小于一像素的抖动不值得再改 scrollTop（会打断平滑滚动）
              if (Math.abs(delta) > 2) {
                root.scrollTop += delta
                settled = 0
              } else if (++settled >= 2) {
                return
              }
            }
            // 最多追 30 帧（约 0.5s）：目标行被撑高/图片解码都会改变落点
            if (++frames < 30) requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        },
        [autoPause, timeline, virtualizer],
      )

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
            scrollToTimelineIndex(timelineIndex)
          },
          scrollToMessageId: (messageId: string) => {
            const timelineIndex = messageIdToTimelineIndex.get(messageId)
            if (timelineIndex == null) return
            /**
             * 用户消息锚点用 `start`（对齐到视口顶部）。
             *
             * 侧边轴点的就是「这一轮从这里开始」，居中会让用户消息上方那一轮的
             * 尾部内容占掉半个屏幕，看起来像「点到了上一轮」。
             */
            scrollToTimelineIndex(timelineIndex, 'start')
          },
        }),
        [
          autoForceScroll,
          autoMarkAuto,
          pinToBottom,
          virtualizer,
          timeline,
          visibleMessages,
          messageIdToTimelineIndex,
          scrollToTimelineIndex,
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

            {/* 压缩分隔条：仅在「最后一次压缩晚于当前最后一条消息」时显示在消息流末尾。
                一旦用户又发了新消息，说明压缩点已经不在末尾，分隔条自然消失，
                避免它一直悬在最新对话下方造成误解。 */}
            {shouldShowCompactionDivider(visibleMessages, compactedAt) && (
              <div className={`w-full mx-auto ${paddingClass}`} style={chatContentMaxWidthStyle}>
                <div className="flex items-center gap-3 py-2 text-[length:var(--fs-xs)] text-text-400" data-compaction-divider>
                  <span className="flex-1 h-px bg-border-200/70" />
                  <span className="shrink-0 leading-none">{t('message:system.contextCompacted')}</span>
                  <span className="flex-1 h-px bg-border-200/70" />
                </div>
              </div>
            )}

            {/* 顺序必须是：消息 → 内嵌提问 → 重试/错误提示 → 输入框占位。
                旧 Virtuoso Footer 就是这样；换 virtualizer 后 paddingEnd 在前、提示在后，会叠到输入框下。 */}
            {inlineQuestions.length > 0 && (
              <div className={`w-full mx-auto ${paddingClass}`} style={chatContentMaxWidthStyle}>
                <div className="space-y-2">
                  {inlineQuestions.map(entry => (
                    <InlineQuestion
                      key={entry.request.id}
                      request={entry.request}
                      onReply={(_requestId, answers) => entry.onReply(answers)}
                      onReject={entry.onReject}
                      isReplying={entry.isReplying ?? false}
                    />
                  ))}
                </div>
              </div>
            )}

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
