import { memo, useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { animate } from 'motion/mini'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ImageIcon,
  LayersIcon,
  LightbulbIcon,
  PinIcon,
  SplitIcon,
  SpinnerIcon,
  UndoIcon,
} from '../../components/Icons'
import { Spinner } from '../../components/ui/Spinner'
import { CopyButton, SmoothHeight } from '../../components/ui'
import { DisclosureRow } from '../../components/ui/DisclosureRow'
import { MarkdownRenderer } from '../../components/MarkdownRenderer'
import { pinnedMessagesStore, buildPinnedMessageExcerpt, usePinnedMessage } from '../../store/pinnedMessagesStore'
import { getMessageText } from '../../types/message'
import { useCompositorExpand, useDisclosureScrollLock } from '../../hooks'
import { useInputCapabilities } from '../../hooks/useInputCapabilities'
import { useNow } from '../../hooks/useNow'
import { useTheme } from '../../hooks/useTheme'
import { exportNodeAsImage } from '../../utils/imageExport'
import { notificationStore } from '../../store/notificationStore'
import { messageCompletedAt } from '../../store/messagePartMerge'
import { uiErrorHandler } from '../../utils/errorHandling'
import {
  useInlineToolRequests,
  findPermissionRequestForTool,
  findQuestionRequestForTool,
} from '../chat/InlineToolRequestContext'
import {
  TextPartView,
  ReasoningPartView,
  ToolPartView,
  SyntheticTextPartView,
  MessageErrorView,
} from './parts'
import { ToolIconStrip } from './parts/ToolIconStrip'
import { isSubagentToolName, getSubagentSessionId } from './subagentUtils'
import { DiffChips } from './parts/DiffChips'
import { collectChangedFiles, sumChangedFiles } from './parts/changedFiles'
import type { ChangedFile } from './parts/changedFiles'
import { MSG_SPACING } from './messageSpacing'
import { MessageExpandPanel } from './messageExpand'
import { useMessageExpandRender } from './messageExpandShared'
import {
  groupContentsForRender,
  messageStillStreamingProcess,
  splitProcessRenderItems,
  type ProcessContentScope,
  type RenderItem,
} from './messageRenderLogic'
import type {
  Message,
  TextPart,
  ToolPart,
  TextContent,
  AssistantMessageInfo,
} from '../../types/message'
import {
  ENTRY_GROW_DURATION_MS,
  isEntryGrowComplete,
  markEntryGrowComplete,
  shouldPlayEntryGrow,
} from '../../utils/entryGrow'
import {
  formatDuration,
  formatProcessDuration,
  formatCompletedAt,
  formatDetailedDateTime,
} from '../../utils/formatUtils'
import { lockScrollAroundAnchor } from '../../utils/scrollUtils'
import { useUiDisclosureState } from '../../utils/uiDisclosureState'
import { touchTarget } from '../../utils/interaction'

/**
 * 过程折叠 header：进行中自己走表，只有这一行因计时更新；children 不跟时钟走。
 */
const ProcessCollapseHeader = memo(function ProcessCollapseHeader({
  isActive,
  startedAt,
  durationMs,
  expanded,
  onToggle,
  headerRef,
  stepCount = 0,
  reasoningCount = 0,
  activeLabel,
}: {
  isActive: boolean
  startedAt?: number
  durationMs?: number
  expanded: boolean
  onToggle: () => void
  headerRef: React.RefObject<HTMLButtonElement | null>
  stepCount?: number
  reasoningCount?: number
  /**
   * 运行中时「此刻在做什么」的一句话（如「shell · npx vitest run」）。
   *
   * 为什么需要：长任务实测跑过 17 分钟 / 165 步，而这期间整个界面只有一行
   * 「Working for 17m」在跳秒 —— 用户看不到任何进展，判定为「卡住了」，
   * 于是反复打断（实测连续 4 轮都被用户手动中断，长命令永远跑不完）。
   * 把当前步骤显示出来，至少能回答「它还在动吗、在动什么」。
   */
  activeLabel?: string
}) {
  const { t } = useTranslation('message')
  const now = useNow(1000, isActive && startedAt != null)
  const liveMs = isActive && startedAt != null ? Math.max(0, now - startedAt) : null
  const lastLiveMsRef = useRef(0)
  // 渲染期写 ref 是有意为之：这是「记住最后一次有效时长」的粘滞值。
  // liveMs 结束时（isActive 变 false）会立刻变 null，若改用 useEffect 记录，
  // 中间会有一帧 displayMs 回落到 durationMs/0，计时标签出现闪跳。
  // 该 ref 不参与并发渲染的结果差异（只做单调记录），故此处显式豁免规则。
  // eslint-disable-next-line react-hooks/refs
  if (liveMs != null) lastLiveMsRef.current = liveMs
  const displayMs =
    liveMs != null
      ? liveMs
      : durationMs != null && durationMs > 0
        ? durationMs
        : // 同上：读取粘滞值，见上方豁免说明
          // eslint-disable-next-line react-hooks/refs
          lastLiveMsRef.current
  // Working/Worked：整秒无小数；超过 1 分钟带 m（如 3m 12s）
  const durationLabel = formatProcessDuration(displayMs)
  const label = isActive
    ? t('processingWithDuration', { duration: durationLabel })
    : t('processedFor', { duration: durationLabel })
  // 折叠时才显示规模统计（展开后内容本身就是答案）；
  // 但**运行中**例外：即使展开也要显示「此刻在做什么」，
  // 否则长任务展开后同样看不出进展。
  const hasBreakdown = (!expanded && (stepCount > 0 || reasoningCount > 0)) || (isActive && !!activeLabel)

  return (
    <DisclosureRow
      ref={headerRef}
      expanded={expanded}
      onClick={onToggle}
      size="sm"
      labelTone={isActive ? 'accent' : 'idle'}
      label={label}
      growLabel={false}
      showChevron={false}
      reserveChevronSpace
      icon={isActive ? <Spinner size="sm" tone="accent" variant="pixel" /> : <LayersIcon size={13} className="text-text-500" />}
      meta={
        hasBreakdown ? (
          <span className="flex min-w-0 items-center gap-2 overflow-hidden text-[length:var(--fs-xxs)] tabular-nums text-text-500">
            {/* 运行中优先显示「此刻在做什么」：长任务里它比步数更能说明「还在动」。
                宽度跟容器走（min-w-0 + truncate），不写死 max-w —— 写死 22rem 在
                窄屏上会比可用宽度还大，命令文本会顶出屏幕右边缘。 */}
            {isActive && activeLabel ? (
              <span className="min-w-0 max-w-full truncate font-mono">{activeLabel}</span>
            ) : null}
            {reasoningCount > 0 && (
              <span className="flex shrink-0 items-center gap-1">
                <LightbulbIcon size={10} />
                {reasoningCount}
              </span>
            )}
            {stepCount > 0 && <span className="shrink-0">{t('thinkingStepCount', { count: stepCount })}</span>}
          </span>
        ) : undefined
      }
    />
  )
})

/** 过程折叠块：动画与 tool steps 一致（grid-rows + delayed body） */
export function ProcessCollapseBlock({
  children,
  durationMs,
  startedAt,
  isActive,
  forceExpanded = false,
  stateKey,
  stepCount = 0,
  reasoningCount = 0,
  activeLabel,
  onExpand,
}: {
  children: ReactNode
  durationMs?: number
  startedAt?: number
  isActive: boolean
  /**
   * 强制展开（默认展开、且不参与「结束后自动收起」）。
   *
   * 最后一轮用它：内容是服务端此刻正在写的东西，用户要看的就是它原样输出，
   * 折起来只剩一行「已处理」就本末倒置了。
   */
  forceExpanded?: boolean
  stateKey: string
  /** 折叠时在 header 右侧显示的统计（工具调用数 / 思考段数） */
  stepCount?: number
  reasoningCount?: number
  /** 运行中时「此刻在做什么」，见 ProcessCollapseHeader 的说明 */
  activeLabel?: string
  /**
   * 用户手动展开时触发；用于按需回拉被压缩轮次的完整过程内容。
   *
   * 返回 Promise 时会显示加载占位（骨架屏），直到内容到达 —— 否则展开后是
   * 一片空白，用户以为没反应。实测经隧道回拉一轮约 1.5s，必须给反馈。
   */
  onExpand?: () => void | Promise<void>
}) {
  const [expanded, setExpanded] = useUiDisclosureState(stateKey, isActive)
  /** 回拉进行中：展开后先显示占位，避免空白 */
  const [hydrating, setHydrating] = useState(false)
  // Android expand: 展开时用 max-height 假高度，避免 WebView 在 grid-rows 动画中
  // 把过程壳内容画成空白（滚动中展开/收起时表现为闪一下）。与 ContentBlock、
  // 工具步骤壳同款处理；桌面仍是原 grid-rows 动画。
  const {
    contentRef: processExpandContentRef,
    layoutOpen: processLayoutOpen,
    keepMounted: processKeepMounted,
    panelClassName: processPanelClassName,
  } = useCompositorExpand(expanded)
  const shouldRenderBody = useMessageExpandRender(processKeepMounted)
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLButtonElement>(null)
  const unlockScrollRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // forceExpanded：内容原样输出，跟随「是否进行中」强制展开，不受用户折叠记忆影响
    setExpanded(isActive || forceExpanded, { touched: false, respectUser: !forceExpanded })
  }, [isActive, forceExpanded, setExpanded])

  useEffect(() => {
    return () => {
      unlockScrollRef.current?.()
      unlockScrollRef.current = null
    }
  }, [])

  const toggleExpanded = useCallback(() => {
    unlockScrollRef.current?.()
    unlockScrollRef.current = lockScrollAroundAnchor(headerRef.current, {
      observe: rootRef.current,
    })
    // 仅展开时回拉；折叠无需数据。
    // 回拉是异步的（经隧道约 1.5s），期间显示占位，避免展开后一片空白。
    if (!expanded && onExpand) {
      const pending = onExpand()
      if (pending && typeof (pending as Promise<void>).then === 'function') {
        setHydrating(true)
        void (pending as Promise<void>)
          .catch(() => {})
          .finally(() => setHydrating(false))
      }
    }
    setExpanded(!expanded)
  }, [expanded, setExpanded, onExpand])

  // 进行中默认展开：不要跑 grid 展开动画（否则每条新消息都带动画高度重排）
  // 用户手动折叠/展开、或结束后自动收起时再开动画
  // 挂载本身不另做入场生长——像普通消息一样直接出现
  const expandedState = isActive || forceExpanded
  const animateGrid = !expandedState || expanded !== expandedState

  return (
    <div ref={rootRef} className="flex flex-col">
      <ProcessCollapseHeader
        isActive={isActive}
        startedAt={startedAt}
        durationMs={durationMs}
        expanded={expanded}
        onToggle={toggleExpanded}
        headerRef={headerRef}
        stepCount={stepCount}
        reasoningCount={reasoningCount}
        activeLabel={activeLabel}
      />
      <MessageExpandPanel
        open={processLayoutOpen}
        animate={animateGrid}
        panelClassName={processPanelClassName}
        contentRef={processExpandContentRef}
        clip
        innerClassName="min-h-0 min-w-0 overflow-hidden -mx-1.5 px-1.5"
      >
        {shouldRenderBody && (
          <div className={MSG_SPACING.processBody}>
            {hydrating ? <ProcessHydratePlaceholder /> : children}
          </div>
        )}
      </MessageExpandPanel>
    </div>
  )
}

/**
 * 回拉完整过程时的占位。
 *
 * 展开「已处理」块后，内容需要从主机回拉（实测经隧道约 1.5s）。期间若什么都不画，
 * 用户看到的是「点了没反应」；这里给几条骨架行，明确表示正在加载。
 */
const ProcessHydratePlaceholder = memo(function ProcessHydratePlaceholder() {
  const { t } = useTranslation('message')
  return (
    <div
      className="flex flex-col gap-2 py-1"
      role="status"
      aria-live="polite"
      aria-label={t('loadingProcess')}
    >
      {[0, 1, 2].map(index => (
        <div
          key={index}
          className="flex items-center gap-2 animate-pulse"
          style={{ opacity: 1 - index * 0.25 }}
        >
          <span className="h-3 w-3 shrink-0 rounded-full bg-bg-300" />
          <span className="h-2.5 rounded-full bg-bg-300" style={{ width: `${72 - index * 16}%` }} />
        </div>
      ))}
      <span className="sr-only">{t('loadingProcess')}</span>
    </div>
  )
})

// 渲染范围与拆分逻辑已移至 messageRenderLogic.ts
interface MessageRendererProps {
  message: Message
  allowStreamingLayoutAnimation?: boolean
  /** 回合总时长（毫秒），仅在回合最后一条 assistant 消息上有值 */
  turnDuration?: number
  /**
   * 是否为该用户回合的最后一条可见 assistant。
   * latestOnly 开启时，中间 assistant 不显示 step 完成信息。
   * 未传入时按 true 处理（单条消息场景）。
   */
  isTurnLatestAssistant?: boolean
  /** 过程折叠时的内容范围 */
  processContentScope?: ProcessContentScope
  onUndo?: (userMessageId: string) => void
  onFork?: (message: Message, forkMessageId?: string) => Promise<void> | void
  forkMessageId?: string
  canUndo?: boolean
  onEnsureParts?: (messageId: string) => void
  /** 用户消息入场生长完成（供过程壳等待挂载） */
  onEntryGrowComplete?: (messageId: string) => void
  /** 所属会话（复合 key）。固定消息需要它来确定归属。 */
  sessionId?: string | null
  /** 本回合聚合的改动文件，仅在最终回复（final）消息上渲染 */
  turnFiles?: ChangedFile[]
}

export const MessageRenderer = memo(function MessageRenderer({
  message,
  allowStreamingLayoutAnimation = false,
  turnDuration,
  isTurnLatestAssistant = true,
  processContentScope = 'all',
  onUndo,
  onFork,
  forkMessageId,
  canUndo,
  onEnsureParts,
  onEntryGrowComplete,
  sessionId,
  turnFiles,
}: MessageRendererProps) {
  const { info } = message
  const isUser = info.role === 'user'

  if (isUser) {
    return (
      <UserMessageView
        message={message}
        onUndo={onUndo}
        onFork={onFork}
        forkMessageId={forkMessageId}
        canUndo={canUndo}
        onEntryGrowComplete={onEntryGrowComplete}
        sessionId={sessionId}
      />
    )
  }

  return (
    <AssistantMessageView
      message={message}
      allowStreamingLayoutAnimation={allowStreamingLayoutAnimation}
      turnDuration={turnDuration}
      isTurnLatestAssistant={isTurnLatestAssistant}
      processContentScope={processContentScope}
      onFork={onFork}
      forkMessageId={forkMessageId}
      onEnsureParts={onEnsureParts}
      sessionId={sessionId}
      turnFiles={turnFiles}
    />
  )
})

// ============================================
// 入场生长动画 hook — 新消息作为对话流的延续，从 height 0 平滑展开
// 完成后 markEntryGrowComplete，供过程壳「等用户登场完再挂」使用
// ============================================

function useEntryGrowAnimation(
  created: number,
  enabled = true,
  completeId?: string,
  onComplete?: (id: string) => void,
) {
  const ref = useRef<HTMLDivElement>(null)
  // latest-callback ref：让 effect 读到最新的 onComplete 而不必把它列入依赖
  // （列入会导致每次父组件重渲染都重跑入场动画的完成判定）。
  // 该写法在全项目通用（ChatArea 的 onLoadMoreRef 等同款），故豁免规则。
  const onCompleteRef = useRef(onComplete)
  // eslint-disable-next-line react-hooks/refs
  onCompleteRef.current = onComplete

  useLayoutEffect(() => {
    const el = ref.current
    const finish = () => {
      if (!completeId) return
      if (!isEntryGrowComplete(completeId)) markEntryGrowComplete(completeId)
      onCompleteRef.current?.(completeId)
    }

    // 过程壳内消息禁止入场生长：会连着虚拟行反复 measure，造成整列高度抽搐
    if (!enabled || !el) {
      finish()
      return
    }
    /**
     * ⚠️ 顺序很重要：**先判是否要播，再去读 scrollHeight**。
     *
     * `el.scrollHeight` 是强制同步布局（forced reflow）。历史消息本来就不播入场
     * 动画（超过 ENTRY_GROW_MAX_AGE_MS），但只要把读取放在判断之前，每一条挂载
     * 的消息都会付一次 reflow —— 长会话滚动时一屏十几行、每行都在测量，主线程
     * 直接被这个读打满，表现就是「主对话特别长时卡顿」。
     */
    // 已完成过（虚拟行复用 remount）或消息太旧：不播，直接放行
    if ((completeId && isEntryGrowComplete(completeId)) || !shouldPlayEntryGrow(created)) {
      finish()
      return
    }

    // 始终把 DOM 还原干净：StrictMode 开发期会双调用 effect（mount→cleanup→mount），
    // 第一次的 WAAPI 动画若不被真正 cancel，会在后台跑完并把固定 height 写回 DOM，
    // 而 cancel 时 finished promise 会 reject，所以无论正常结束还是被取消都要清空。
    const clear = () => {
      el.style.height = ''
      el.style.clipPath = ''
    }

    const targetHeight = el.scrollHeight
    el.style.height = '0px'
    el.style.clipPath = 'inset(0 -100% 0 -100%)'
    const controls = animate(
      el,
      { height: `${targetHeight}px` },
      { duration: ENTRY_GROW_DURATION_MS / 1000, ease: 'easeOut' },
    )
    controls.then(clear)

    return () => {
      // 真停掉动画，避免后台残留写入；再兜底清一次 DOM
      controls.stop()
      clear()
      finish()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return ref
}

// ============================================
// Collapsible User Text
// ============================================

/** 默认预览 8 行 */
const COLLAPSE_PREVIEW_LINES = 8
const LEADING_RELAXED = 1.625
const USER_HTML_ARTIFACT_PATTERN =
  /(?:```(?:html|htm)\b|<!doctype\s+html\b|<html\b|<style\b|<script\b|<canvas\b|\son[a-z]+\s*=)/i

// 折叠状态缓存：消息是否溢出。
// key 含 messageId，随浏览过的消息单调增长，必须设上限，否则是只增不减的泄漏。
const overflowStateCache = new Map<string, boolean>()
const MAX_OVERFLOW_CACHE = 2000

function setOverflowState(key: string, value: boolean) {
  overflowStateCache.delete(key)
  overflowStateCache.set(key, value)
  while (overflowStateCache.size > MAX_OVERFLOW_CACHE) {
    const oldest = overflowStateCache.keys().next().value
    if (oldest === undefined) break
    overflowStateCache.delete(oldest)
  }
}

const CollapsibleUserText = memo(function CollapsibleUserText({
  text,
  collapseEnabled,
  renderMarkdown,
  messageId,
}: {
  text: string
  collapseEnabled: boolean
  renderMarkdown: boolean
  messageId: string
}) {
  const { t } = useTranslation('message')
  const contentRef = useRef<HTMLDivElement>(null)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const overflowCacheKey = `${messageId}:${renderMarkdown ? 'markdown' : 'plain'}`
  const [expanded, setExpanded] = useUiDisclosureState(`message:${messageId}:user-text`, false)
  const [isOverflow, setIsOverflow] = useState(() => overflowStateCache.get(overflowCacheKey) ?? false)

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return

    let disposed = false
    const measure = () => {
      if (disposed) return
      const fsBase = Number.parseFloat(window.getComputedStyle(el).getPropertyValue('--fs-base'))
      if (!Number.isFinite(fsBase) || fsBase <= 0) return
      const collapsedHeight = fsBase * LEADING_RELAXED * COLLAPSE_PREVIEW_LINES
      const next = el.scrollHeight > collapsedHeight + 1
      setOverflowState(overflowCacheKey, next)
      setIsOverflow(prev => (prev === next ? prev : next))
    }

    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(el)
    document.fonts?.ready?.then(measure)

    return () => {
      disposed = true
      resizeObserver.disconnect()
    }
  }, [text, overflowCacheKey])

  const hasHtmlArtifact = renderMarkdown && USER_HTML_ARTIFACT_PATTERN.test(text)
  const showCollapse = collapseEnabled && !hasHtmlArtifact && isOverflow
  const isCollapsed = collapseEnabled && !hasHtmlArtifact && !expanded

  return (
    <div
      ref={rootRef}
      className={`px-4 py-2.5 bg-bg-300 rounded-2xl max-w-full ${hasHtmlArtifact ? 'w-full max-w-2xl' : ''}`}
    >
      <div className="relative">
        <div
          ref={node => {
            contentRef.current = node
            headerRef(node)
          }}
          className={`m-0 break-words text-[length:var(--fs-base)] text-text-100 leading-relaxed${
            renderMarkdown ? '' : ' whitespace-pre-wrap'
          }${isCollapsed ? ' overflow-hidden' : ''}`}
          style={
            isCollapsed
              ? {
                  maxHeight: `calc(var(--fs-base) * ${LEADING_RELAXED} * ${COLLAPSE_PREVIEW_LINES})`,
                  contain: 'layout paint',
                }
              : undefined
          }
        >
          {renderMarkdown ? <MarkdownRenderer content={text} /> : text}
        </div>
        {/* 底部渐变遮罩 */}
        {showCollapse && isCollapsed && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-bg-300 to-transparent pointer-events-none" />
        )}
      </div>
      {showCollapse && (
        <button
          type="button"
          onClick={() => withScrollLock(() => setExpanded(prev => !prev))}
          className="mt-1 text-[length:var(--fs-sm)] text-text-400 hover:bg-bg-200 hover:border-border-200 border border-transparent rounded px-1 transition-colors"
          aria-expanded={expanded}
        >
          {expanded ? t('showLess') : t('showMore')}
        </button>
      )}
    </div>
  )
})

interface ForkActionButtonProps {
  message: Message
  onFork?: (message: Message, forkMessageId?: string) => Promise<void> | void
  forkMessageId?: string
}

const ForkActionButton = memo(function ForkActionButton({ message, onFork, forkMessageId }: ForkActionButtonProps) {
  const { t } = useTranslation('message')
  const [isForking, setIsForking] = useState(false)

  const handleFork = useCallback(async () => {
    if (!onFork || isForking) return

    setIsForking(true)

    try {
      await onFork(message, forkMessageId)
    } catch {
      // 业务错误由上层统一处理
    } finally {
      setIsForking(false)
    }
  }, [forkMessageId, isForking, message, onFork])

  if (!onFork) return null

  return (
    <button
      onClick={() => void handleFork()}
      disabled={isForking}
      className={`p-1.5 rounded-md transition-colors duration-150 text-text-400 hover:text-text-200 disabled:cursor-default disabled:text-text-500 ${touchTarget.iconButton}`}
      title={isForking ? t('forkingFromHere') : t('forkFromHere')}
      aria-label={isForking ? t('forkingFromHere') : t('forkFromHere')}
    >
      {isForking ? <SpinnerIcon className="animate-spin" /> : <SplitIcon />}
    </button>
  )
})

// ============================================
// Pin Action — 固定消息到工作状态面板
// ============================================

interface PinActionButtonProps {
  message: Message
  sessionId?: string | null
}

/**
 * 固定的是消息本身，面板里点击可跳回。
 * 无 sessionId 时不渲染：固定项要挂在具体会话下才有意义。
 */
const PinActionButton = memo(function PinActionButton({ message, sessionId }: PinActionButtonProps) {
  const { t } = useTranslation('message')
  const pinned = usePinnedMessage(sessionId, message.info.id)

  const handleToggle = useCallback(() => {
    if (!sessionId) return
    pinnedMessagesStore.toggle({
      sessionId,
      messageId: message.info.id,
      role: message.info.role === 'user' ? 'user' : 'assistant',
      excerpt: buildPinnedMessageExcerpt(getMessageText(message)),
      createdAt: message.info.time?.created ?? 0,
    })
  }, [message, sessionId])

  if (!sessionId) return null

  return (
    <button
      onClick={handleToggle}
      className={`p-1.5 rounded-md transition-colors duration-150 ${
        pinned ? 'text-accent-main-100' : 'text-text-400 hover:text-text-200'
      } ${touchTarget.iconButton}`}
      title={pinned ? t('workStatus.pinned.unpin') : t('workStatus.pinned.pin')}
      aria-label={pinned ? t('workStatus.pinned.unpin') : t('workStatus.pinned.pin')}
      aria-pressed={pinned}
    >
      <PinIcon />
    </button>
  )
})

// ============================================
// Export Image Action — 把消息导出为 PNG
// ============================================

interface ExportImageActionButtonProps {
  fileName: string
  sessionId?: string | null
}

const ExportImageActionButton = memo(function ExportImageActionButton({
  fileName,
  sessionId,
}: ExportImageActionButtonProps) {
  const { t } = useTranslation('message')
  const [isExporting, setIsExporting] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleExport = useCallback(async () => {
    if (isExporting) return
    const root = buttonRef.current?.closest('[data-message-root]')
    if (!(root instanceof HTMLElement)) return
    setIsExporting(true)
    try {
      await exportNodeAsImage(root, { fileName })
    } catch (e) {
      uiErrorHandler('export message image', e)
      notificationStore.push('error', t('exportImageFailed'), '', sessionId ?? '')
    } finally {
      setIsExporting(false)
    }
  }, [fileName, isExporting, sessionId, t])

  return (
    <button
      ref={buttonRef}
      onClick={() => void handleExport()}
      disabled={isExporting}
      className={`p-1.5 rounded-md transition-colors duration-150 text-text-400 hover:text-text-200 disabled:cursor-default disabled:text-text-500 ${touchTarget.iconButton}`}
      title={isExporting ? t('exportingImage') : t('exportImage')}
      aria-label={isExporting ? t('exportingImage') : t('exportImage')}
    >
      {isExporting ? <SpinnerIcon className="animate-spin" /> : <ImageIcon />}
    </button>
  )
})

// ============================================
// User Message View
// ============================================
interface UserMessageViewProps {
  message: Message
  onUndo?: (userMessageId: string) => void
  onFork?: (message: Message, forkMessageId?: string) => Promise<void> | void
  forkMessageId?: string
  canUndo?: boolean
  onEntryGrowComplete?: (messageId: string) => void
  sessionId?: string | null
}

/** PC 精细指针：默认隐藏，悬浮消息/聚焦时显示；触控优先设备始终显示 */
function useMessageActionBarClass() {
  const { preferTouchUi } = useInputCapabilities()
  return preferTouchUi
    ? // 触控：始终可见，并略微拉开间距（按钮放大后热区变宽，贴太近会互相误触）
      `flex items-center ${touchTarget.actionRowGap} transition-opacity`
    : 'flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto focus-within:pointer-events-auto transition-opacity'
}

const UserMessageView = memo(function UserMessageView({
  message,
  onUndo,
  onFork,
  forkMessageId,
  canUndo,
  onEntryGrowComplete,
  sessionId,
}: UserMessageViewProps) {
  const { t } = useTranslation('message')
  // content[] 里只有 text（含 synthetic）；用户附件挂在 info.attachments
  const { content, info } = message
  const [showSystemContext, setShowSystemContext] = useUiDisclosureState(
    `message:${info.id}:user-system-context`,
    false,
  )
  const shouldRenderSystemContext = useMessageExpandRender(showSystemContext)
  const {
    rootRef: systemContextRootRef,
    headerRef: systemContextHeaderRef,
    withScrollLock: withSystemContextScrollLock,
  } = useDisclosureScrollLock()
  const { collapseUserMessages, renderUserMarkdown } = useTheme()
  const actionBarClass = useMessageActionBarClass()

  // 缺 time（v2 轻量投影）时用 0：shouldPlayEntryGrow(0) 恒为 false，等价于
  // 「不播入场动画」—— 比崩溃好，也不会让时间未知的旧消息闪一下。
  const wrapperRef = useEntryGrowAnimation(info.time?.created ?? 0, true, info.id, onEntryGrowComplete)

  const textParts = content.filter((c): c is TextContent => c.type === 'text' && !c.synthetic)
  const syntheticParts = content.filter((c): c is TextContent => c.type === 'text' && !!c.synthetic)
  const attachments = info.role === 'user' ? (info as import('../../types/message').UserMessageInfo).attachments ?? [] : []

  const hasSystemContext = syntheticParts.length > 0
  const messageText = textParts.map(p => p.text).join('')
  const hasUserHtmlArtifact = renderUserMarkdown && USER_HTML_ARTIFACT_PATTERN.test(messageText)

  return (
    <div
      ref={wrapperRef}
      data-message-root
      data-user-html-artifact={hasUserHtmlArtifact ? '' : undefined}
      className={`flex flex-col items-end group ${hasUserHtmlArtifact ? 'w-full' : ''}`}
    >
      <div className="flex flex-col gap-1 items-end w-full">
        {/* 消息文本 */}
        {messageText && (
          <CollapsibleUserText
            text={messageText}
            collapseEnabled={collapseUserMessages}
            renderMarkdown={renderUserMarkdown}
            messageId={info.id}
          />
        )}

        {/* 用户附件 */}
        {attachments.length > 0 && (
          <div className="mt-1 flex max-w-full min-w-0 flex-wrap gap-2 justify-end">
            {attachments.map(attachment => (
              <UserAttachmentChip key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}

        {/* 系统上下文 */}
        {hasSystemContext && (
          <div ref={systemContextRootRef} className="flex flex-col items-end mt-1 w-full">
            <button
              type="button"
              ref={systemContextHeaderRef}
              onClick={() => withSystemContextScrollLock(() => setShowSystemContext(!showSystemContext))}
              className="flex items-center gap-1 text-[length:var(--fs-sm)] text-text-400 transition-colors py-1 px-2 rounded hover:bg-bg-200 hover:border-border-200 border border-transparent"
            >
              <span>
                {showSystemContext ? t('hideSystemContext') : t('showSystemContext', { count: syntheticParts.length })}
              </span>
              <span className={`transition-transform duration-300 ${showSystemContext ? '' : '-rotate-90'}`}>
                <ChevronDownIcon size={10} />
              </span>
            </button>

            <MessageExpandPanel
              open={showSystemContext}
              variant="fade"
              className="w-full"
              innerClassName="overflow-hidden"
            >
              {shouldRenderSystemContext && (
                <div className="pt-2 flex max-w-full min-w-0 flex-wrap gap-2 justify-end">
                  {syntheticParts.map(part => (
                    <SyntheticTextPartView key={part.id} part={part} />
                  ))}
                </div>
              )}
            </MessageExpandPanel>
          </div>
        )}

        {/* Action buttons — PC 悬浮消息显示；触控设备始终显示 */}
        <div className={actionBarClass} data-message-actions>
          {/* Undo button */}
          {canUndo && onUndo && (
            <button
              onClick={() => onUndo(info.id)}
              className="p-1.5 rounded-md transition-colors duration-150 text-text-400 hover:text-text-200"
              title={t('undoFromHere')}
            >
              <UndoIcon />
            </button>
          )}
          <ForkActionButton message={message} onFork={onFork} forkMessageId={forkMessageId} />
          <PinActionButton message={message} sessionId={sessionId} />
          {/* Copy button */}
          {messageText && <CopyButton text={messageText} position="static" />}
          <ExportImageActionButton fileName={`message-${info.id}`} sessionId={sessionId} />
        </div>
      </div>
    </div>
  )
})

// ============================================
// User Attachment Chip (read-only)
// ============================================
/**
 * 已发送消息里的附件。
 *
 * 图片必须显示缩略图，不能只显示文件名：纯图片消息没有正文，若只渲染一个
 * 文件 chip，整条消息看起来几乎是空的，用户会以为图片没发出去。
 * 缩略图同时充当「这张图确实带上了」的确认。
 */
const UserAttachmentChip = memo(function UserAttachmentChip({
  attachment,
}: {
  attachment: import('../../features/attachment/types').Attachment
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const isImage = attachment.mime?.startsWith('image/') === true && !!attachment.url && !imageFailed

  if (isImage) {
    return (
      <a
        data-user-attachment
        href={attachment.url}
        target="_blank"
        rel="noreferrer"
        title={attachment.displayName}
        className="block max-w-[240px] overflow-hidden rounded-lg border border-border-200 bg-bg-100"
      >
        <img
          src={attachment.url}
          alt={attachment.displayName}
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="max-h-48 w-full object-contain"
        />
      </a>
    )
  }

  return (
    <span
      data-user-attachment
      title={attachment.displayName}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-200 bg-bg-100 px-2.5 py-1 text-[length:var(--fs-xs)] text-text-300"
    >
      <span className="shrink-0 text-text-400">{attachment.type === 'agent' ? 'agent' : 'file'}</span>
      <span className="truncate">{attachment.displayName}</span>
    </span>
  )
})

// ============================================
// Assistant Message View
// ============================================

const AssistantMessageView = memo(function AssistantMessageView({
  message,
  allowStreamingLayoutAnimation = false,
  turnDuration,
  isTurnLatestAssistant = true,
  processContentScope = 'all',
  onFork,
  forkMessageId,
  onEnsureParts,
  sessionId,
  turnFiles,
}: {
  message: Message
  allowStreamingLayoutAnimation?: boolean
  turnDuration?: number
  isTurnLatestAssistant?: boolean
  processContentScope?: ProcessContentScope
  onFork?: (message: Message, forkMessageId?: string) => void | Promise<void>
  forkMessageId?: string
  onEnsureParts?: (messageId: string) => void
  sessionId?: string | null
  turnFiles?: ChangedFile[]
}) {
  const { t } = useTranslation('message')
  const { content, isStreaming, info } = message
  const { stepFinishDisplay, completedAtFormat, actionsOnLatestAssistantOnly } = useTheme()
  // 整轮最新 assistant 才允许显示 step 完成信息（latestOnly 时中间 assistant 全隐藏）
  const allowStepFinishOnMessage = !stepFinishDisplay.latestOnly || isTurnLatestAssistant
  // 分叉/复制：默认只在回合末尾助手消息显示，避免连续多条打断阅读
  // final 位始终显示操作；process/inline 不显示（避免壳内外重复）
  const showMessageActions =
    processContentScope !== 'process' &&
    processContentScope !== 'inline' &&
    (!actionsOnLatestAssistantOnly || isTurnLatestAssistant || processContentScope === 'final')
  const actionBarClass = useMessageActionBarClass()

  // 壳内（process/inline）和壳外 final 都别做 height 0→N：final 也是拆分后新挂载，动画会顶布局
  const allowEntryGrow = processContentScope === 'all'
  const wrapperRef = useEntryGrowAnimation(info.time?.created ?? 0, allowEntryGrow)

  useEffect(() => {
    if (content.length === 0 && onEnsureParts) {
      onEnsureParts(message.info.id)
    }
  }, [content.length, onEnsureParts, message.info.id])

  // 收集连续的 tool content 合并渲染；过程折叠时按 scope 拆分
  const renderItems = useMemo(() => {
    const items = groupContentsForRender(content)
    if (processContentScope === 'all' || processContentScope === 'inline') return items
    // 流式未完成：整袋当 process，不拆 final
    if (messageStillStreamingProcess(message)) {
      return processContentScope === 'process' ? items : []
    }
    const split = splitProcessRenderItems(items)
    if (processContentScope === 'process') return split.processItems
    if (processContentScope === 'final') return split.finalItems
    return items
  }, [content, processContentScope, message])

  // 判断哪些 reasoning content 已经结束（后面出现了任何非空 content）
  // 直接检查源 content 数组，而非 renderItems，因为 renderItems 会过滤掉空 text，
  // 但空 text content 的存在本身就说明模型已经进入了下一输出阶段
  const endedReasoningIds = useMemo(() => {
    const ended = new Set<string>()
    for (let i = 0; i < content.length; i++) {
      if (content[i].type !== 'reasoning') continue
      for (let j = i + 1; j < content.length; j++) {
        // 任何其他 content 类型（包括空 text、tool 等）都说明思考已结束
        ended.add(content[i].id)
        break
      }
    }
    return ended
  }, [content])

  // 计算完整文本用于复制（缓存：content 引用未变时复用，避免流式每帧重算字符串拼接）
  const fullText = useMemo(
    () =>
      content
        .filter((p): p is TextPart => p.type === 'text' && !p.synthetic)
        .map(p => p.text)
        .join(''),
    [content],
  )
  const hasCopyableText = fullText.trim().length > 0

  // 检查消息级别错误
  const messageError = (info as AssistantMessageInfo).error

  // 消息总耗时（v2 轻量消息可能没有 time，统一走安全读取）
  const completed = messageCompletedAt(message)

  const showTurnDurationFooter =
    allowStepFinishOnMessage &&
    !isStreaming &&
    stepFinishDisplay.turnDuration &&
    turnDuration != null &&
    turnDuration > 0
  const showCompletedAtFooter =
    allowStepFinishOnMessage && !isStreaming && stepFinishDisplay.completedAt && completed != null

  if (!isStreaming && content.length === 0) {
    // process/final 空内容时不占位
    if (processContentScope === 'process' || processContentScope === 'final') return null
    // 有错误时直接显示错误信息
    if (messageError) {
      return (
        <div className={`flex flex-col ${MSG_SPACING.stack} w-full`}>
          <MessageErrorView error={messageError} stateKey={`message:${message.info.id}:error`} />
        </div>
      )
    }
    // content 尚未 hydrate — 保留最小占位减少 CLS，不显示骨架/loading 文字
    // onEnsureParts 已在上方 useEffect 中触发 hydrate，content 到位后自动 re-render
    return <div className="w-full min-h-[40px]" />
  }

  // process/final 拆完后可能为空
  if (renderItems.length === 0 && processContentScope !== 'all' && processContentScope !== 'inline') {
    return null
  }

  return (
    <div ref={wrapperRef} data-message-root className={`flex flex-col ${MSG_SPACING.stack} w-full group`}>
      {/* 流式增高走自然撑开 + 贴底 scroll，默认不做 height 补间，避免每帧 layout/remeasure */}
      <SmoothHeight isActive={!!isStreaming && allowStreamingLayoutAnimation && processContentScope === 'all'}>
        <div className={`flex flex-col ${MSG_SPACING.stack}`}>
          {renderItems.map((item: RenderItem) => {
            if (item.type === 'tool-group') {
              return (
                <ToolGroup
                  key={item.contents[0].id}
                  parts={item.contents}
                  isStreaming={isStreaming}
                />
              )
            }

            const part = item.content
            switch (part.type) {
              case 'text':
                return <TextPartView key={part.id} part={part} isStreaming={isStreaming} />
              case 'reasoning': {
                const reasoningDone = endedReasoningIds.has(part.id)
                return <ReasoningPartView key={part.id} part={part} isStreaming={isStreaming && !reasoningDone} />
              }
              default:
                return null
            }
          })}
        </div>
      </SmoothHeight>

      {/* Message-level error：过程壳内不重复挂错误 */}
      {messageError && processContentScope !== 'process' && processContentScope !== 'inline' && (
        <MessageErrorView error={messageError} stateKey={`message:${info.id}:error`} />
      )}

      {/* 回合改动文件汇总：最终回复里也展示（工具步骤区已有各自概览） */}
      {turnFiles && turnFiles.length > 0 && (
        <div className={MSG_SPACING.finish}>
          <span className="mb-1.5 block text-[length:var(--fs-xxs)] font-medium uppercase tracking-wider text-text-500">
            {t('system.filesChanged', { count: turnFiles.length })}
          </span>
          <DiffChips files={turnFiles} />
        </div>
      )}

      {processContentScope !== 'process' &&
        processContentScope !== 'inline' &&
        (showTurnDurationFooter || showCompletedAtFooter) && (
          <div className="flex items-center gap-3 py-0.5 text-[length:var(--fs-xxs)] text-text-500">
            {showTurnDurationFooter && (
              <span>{t('stepFinish.totalDuration', { duration: formatDuration(turnDuration!) })}</span>
            )}
            {showCompletedAtFooter && (
              <span title={formatDetailedDateTime(completed!)}>{formatCompletedAt(completed!, completedAtFormat)}</span>
            )}
          </div>
        )}

      {showMessageActions && hasCopyableText && (
        <div className={actionBarClass} data-message-actions>
          <ForkActionButton message={message} onFork={onFork} forkMessageId={forkMessageId} />
          <PinActionButton message={message} sessionId={sessionId} />
          <CopyButton text={fullText} position="static" />
          <ExportImageActionButton fileName={`message-${info.id}`} sessionId={sessionId} />
        </div>
      )}
    </div>
  )
})

// ============================================
// Tool Group (连续的 tool parts)
// ============================================

interface ToolGroupProps {
  parts: ToolPart[]
  isStreaming?: boolean
}

/** 用户需要阅读/交互的工具：沉浸模式下这些工具完成后保持展开 */
const READABLE_TOOL_PATTERNS = /bash|\bsh\b|cmd|terminal|shell|write|save|edit|replace|patch|todo|question|ask/i

function isReadableTool(toolName: string): boolean {
  return READABLE_TOOL_PATTERNS.test(toolName.toLowerCase())
}

const ToolGroup = memo(function ToolGroup({
  parts,
  isStreaming,
}: ToolGroupProps) {
  const { t } = useTranslation('message')
  const { descriptiveToolSteps, inlineToolRequests, immersiveMode, processCollapseEnabled } = useTheme()
  const { pendingPermissions, pendingQuestions } = useInlineToolRequests()
  const hasPendingInteraction =
    inlineToolRequests &&
    parts.some(part => {
      const childSessionId = getTaskChildSessionId(part)
      return (
        findPermissionRequestForTool(pendingPermissions, part.callID, childSessionId) ||
        findQuestionRequestForTool(pendingQuestions, part.callID, childSessionId)
      )
    })

  const doneCount = parts.filter(p => p.state.status === 'completed').length
  const totalCount = parts.length
  const isAllDone = doneCount === totalCount
  const hasActiveTools = parts.some(isToolPartActive)
  const stepsSummary = descriptiveToolSteps ? buildDescriptiveToolStepsSummary(parts, t) : undefined

  // 汇总所有成功完成的工具的 diff stats（失败的不算）
  const changedFiles = useMemo(() => collectChangedFiles(parts), [parts])
  const totalDiffStats = useMemo(
    () => (descriptiveToolSteps ? sumChangedFiles(changedFiles) : undefined),
    [descriptiveToolSteps, changedFiles],
  )

  // 沉浸模式下：判断工具组是否包含需要用户阅读的工具
  const hasReadableTools = immersiveMode && parts.some(p => isReadableTool(p.tool))
  // 过程折叠：steps 默认收起，只有权限/提问才自动展开
  // 其它模式：活跃/流式/可读工具时展开
  const shouldStartExpanded = processCollapseEnabled
    ? !!hasPendingInteraction
    : !descriptiveToolSteps ||
      hasActiveTools ||
      hasPendingInteraction ||
      (immersiveMode && !!isStreaming && hasReadableTools)

  const groupStateKey = `message:${parts[0]?.messageID || 'unknown'}:tool-group:${parts[0]?.id || 'empty'}`
  const [expanded, setExpanded] = useUiDisclosureState(groupStateKey, shouldStartExpanded)
  const hasAutoExpandedReadableRef = useRef(
    !processCollapseEnabled && shouldStartExpanded && immersiveMode && hasReadableTools,
  )
  const {
    rootRef: stepsRootRef,
    headerRef: stepsHeaderRef,
    withScrollLock: withStepsScrollLock,
  } = useDisclosureScrollLock()

  useEffect(() => {
    if (!descriptiveToolSteps) return

    // 权限/提问：必须展开让用户操作
    if (hasPendingInteraction) {
      setExpanded(true, { touched: false, respectUser: true })
      return
    }

    // 过程折叠：不因 active/streaming 自动展开 steps
    if (processCollapseEnabled) return

    // 沉浸模式下没有可读工具：始终收起
    if (immersiveMode && !hasReadableTools) {
      setExpanded(false, { touched: false, respectUser: true })
      return
    }
    if (hasActiveTools) {
      if (immersiveMode && hasReadableTools) {
        hasAutoExpandedReadableRef.current = true
      }
      setExpanded(true, { touched: false, respectUser: true })
      return
    }
    // 某些可读工具（如 todo）可能首帧已完成，错过 running 态；流仍在继续时也自动展开一次
    if (immersiveMode && isStreaming && hasReadableTools && !hasAutoExpandedReadableRef.current) {
      hasAutoExpandedReadableRef.current = true
      setExpanded(true, { touched: false, respectUser: true })
    }
  }, [
    descriptiveToolSteps,
    processCollapseEnabled,
    hasActiveTools,
    hasPendingInteraction,
    immersiveMode,
    hasReadableTools,
    isStreaming,
    setExpanded,
  ])

  const effectiveExpanded = expanded || hasPendingInteraction
  // Android expand: instant layout + max-height fake; collapse: original grid-rows.
  // Only animate at the steps shell level so nested ToolPartView does not double-animate.
  const {
    contentRef: stepsExpandContentRef,
    layoutOpen: stepsLayoutOpen,
    keepMounted: stepsKeepMounted,
    panelClassName: stepsPanelClassName,
  } = useCompositorExpand(effectiveExpanded)
  // 展开即挂工具行：默认展开时 header 与 body 同帧
  const shouldRenderBody = useMessageExpandRender(stepsKeepMounted)

  // compact: 单工具时用紧凑布局（图标内联，无 timeline 连接线）
  // 不区分 streaming 状态 — 单工具始终 compact，第二个工具到来时再自然过渡到 timeline
  const isSingleCompact = totalCount === 1 && !descriptiveToolSteps
  // steps header: 多工具始终显示；描述型 steps 模式下，单工具也显示
  const showStepsHeader = totalCount > 1 || descriptiveToolSteps

  // 只 map 一次：有 header 时受 expand mount 控制，无 header 时始终挂载
  const toolParts =
    !showStepsHeader || shouldRenderBody
      ? parts.map((part, idx) => (
          <ToolPartView
            key={part.id}
            part={part}
            isFirst={idx === 0}
            isLast={idx === parts.length - 1}
            compact={isSingleCompact}
            descriptive={descriptiveToolSteps}
            isStreaming={isStreaming}
          />
        ))
      : null

  // 统一容器结构 — ToolPartView 始终在同一 React 树位置，
  // streaming→idle / 1→N 工具切换时不 remount，expanded 状态不丢失
  return (
    <div ref={stepsRootRef} className="flex flex-col">
      {showStepsHeader &&
        (descriptiveToolSteps ? (
          <DisclosureRow
            ref={stepsHeaderRef}
            expanded={effectiveExpanded}
            onClick={() => withStepsScrollLock(() => setExpanded(!expanded))}
            size="sm"
            className="items-center"
            truncateLabel={false}
            labelTone="idle"
            growLabel={false}
            label={
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="text-[length:var(--fs-sm)] leading-5">
                  {stepsSummary?.map((seg, i) => (
                    <span
                      key={i}
                      className={
                        seg.type === 'error'
                          ? 'text-danger-100'
                          : seg.type === 'active'
                            ? 'reasoning-shimmer-text'
                            : 'text-text-300'
                      }
                    >
                      {seg.text}
                    </span>
                  ))}
                </span>
                {!effectiveExpanded && <ToolIconStrip parts={parts} className="shrink-0" />}
                {totalDiffStats && !hasActiveTools && (
                  <span className="inline-flex items-center gap-1 text-[length:var(--fs-xxs)] font-medium tabular-nums">
                    {totalDiffStats.additions > 0 && (
                      <span className="text-success-100">+{totalDiffStats.additions}</span>
                    )}
                    {totalDiffStats.deletions > 0 && (
                      <span className="text-danger-100">-{totalDiffStats.deletions}</span>
                    )}
                  </span>
                )}
              </span>
            }
          />
        ) : (
          <DisclosureRow
            ref={stepsHeaderRef}
            expanded={effectiveExpanded}
            onClick={() => withStepsScrollLock(() => setExpanded(!expanded))}
            size="sm"
            labelTone="idle"
            growLabel={false}
            icon={effectiveExpanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
            showChevron={false}
            label={
              <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
                <span className="text-[length:var(--fs-md)] font-medium leading-tight">
                  {isAllDone
                    ? t('stepsCount', { done: totalCount, total: totalCount })
                    : t('stepsCount', { done: doneCount, total: totalCount })}
                </span>
              </span>
            }
            meta={!effectiveExpanded ? <ToolIconStrip parts={parts} /> : undefined}
          />
        ))}

      {showStepsHeader ? (
        <MessageExpandPanel
          open={stepsLayoutOpen}
          panelClassName={stepsPanelClassName}
          contentRef={stepsExpandContentRef}
          clip
          innerClassName="flex flex-col min-h-0 min-w-0 overflow-hidden -mx-1.5 px-1.5"
        >
          {toolParts}
        </MessageExpandPanel>
      ) : (
        <div className="flex flex-col">{toolParts}</div>
      )}

      {/* 改动文件概览 */}
      {changedFiles.length > 0 && (
        <div className={MSG_SPACING.finish}>
          <DiffChips files={changedFiles} />
        </div>
      )}
    </div>
  )
})

// ============================================
// Helpers
// ============================================

type ToolSummaryCategory =
  | 'execute'
  | 'write'
  | 'edit'
  | 'read'
  | 'search'
  | 'list'
  | 'network'
  | 'task'
  | 'todo'
  | 'question'
  | 'skill'
  | 'think'
  | 'other'

type ToolSummaryPhase = 'done' | 'active' | 'failed'

interface SummarySegment {
  text: string
  type: 'normal' | 'error' | 'active'
}

function buildDescriptiveToolStepsSummary(
  parts: ToolPart[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): SummarySegment[] {
  const sep = t('toolSteps.separator')
  const segments: SummarySegment[] = []
  const MAX_CATEGORIES = 3

  // ── 按类别汇总 done / failed / active ──
  const categoryOrder: ToolSummaryCategory[] = []
  const doneMap = new Map<ToolSummaryCategory, number>()
  const failedMap = new Map<ToolSummaryCategory, number>()
  const activeMap = new Map<ToolSummaryCategory, number>()

  for (const part of parts) {
    const cat = getToolSummaryCategory(part.tool)
    if (!doneMap.has(cat)) {
      categoryOrder.push(cat)
      doneMap.set(cat, 0)
      failedMap.set(cat, 0)
      activeMap.set(cat, 0)
    }
    if (part.state.status === 'completed') doneMap.set(cat, (doneMap.get(cat) || 0) + 1)
    else if (part.state.status === 'error') failedMap.set(cat, (failedMap.get(cat) || 0) + 1)
    // 中断态（后端未回传完成、由前端对账落定）也算已结束，避免从摘要里凭空消失
    else if (part.state.status === 'interrupted') doneMap.set(cat, (doneMap.get(cat) || 0) + 1)
    else if (isToolPartActive(part)) activeMap.set(cat, (activeMap.get(cat) || 0) + 1)
  }

  // ── 已完成 + 失败（合并同类别）──
  // 先收集所有完成态类别（含纯失败的类别）
  const finishedCategories = categoryOrder.filter(cat => (doneMap.get(cat) || 0) > 0 || (failedMap.get(cat) || 0) > 0)

  const pushFinishedSegments = (cats: ToolSummaryCategory[]) => {
    for (const cat of cats) {
      const done = doneMap.get(cat) || 0
      const failed = failedMap.get(cat) || 0
      if (segments.length > 0) segments.push({ text: sep, type: 'normal' })

      if (done > 0 && failed > 0) {
        // 同类别既有成功又有失败：合并成一句
        const total = done + failed
        segments.push({ text: formatToolSummarySegment(cat, total, 'done', t), type: 'normal' })
        segments.push({ text: t('toolSteps.failedSuffix', { count: failed }), type: 'error' })
      } else if (done > 0) {
        segments.push({ text: formatToolSummarySegment(cat, done, 'done', t), type: 'normal' })
      } else {
        // 纯失败
        if (failed === 1) {
          segments.push({ text: formatToolSummarySegment(cat, failed, 'failed', t), type: 'error' })
        } else {
          segments.push({ text: formatToolSummarySegment(cat, failed, 'done', t), type: 'error' })
          segments.push({ text: t('toolSteps.failedAllSuffix'), type: 'error' })
        }
      }
    }
  }

  if (finishedCategories.length <= MAX_CATEGORIES) {
    pushFinishedSegments(finishedCategories)
  } else {
    pushFinishedSegments(finishedCategories.slice(0, MAX_CATEGORIES))
    const restCount = finishedCategories
      .slice(MAX_CATEGORIES)
      .reduce((sum, cat) => sum + (doneMap.get(cat) || 0) + (failedMap.get(cat) || 0), 0)
    segments.push({ text: sep, type: 'normal' })
    segments.push({ text: t('toolSteps.moreActions', { count: restCount }), type: 'normal' })
  }

  // ── 运行中 ──
  const activeCategories = categoryOrder.filter(cat => (activeMap.get(cat) || 0) > 0)
  for (const cat of activeCategories) {
    if (segments.length > 0) segments.push({ text: sep, type: 'normal' })
    segments.push({ text: formatToolSummarySegment(cat, activeMap.get(cat) || 0, 'active', t), type: 'active' })
  }

  if (segments.length === 0) {
    return [{ text: t('stepsCount', { done: 0, total: parts.length }), type: 'normal' }]
  }

  let isFirstContent = true
  for (const seg of segments) {
    if (seg.text === sep) continue
    if (isFirstContent) {
      isFirstContent = false
      continue
    }
    seg.text = seg.text.charAt(0).toLowerCase() + seg.text.slice(1)
  }

  return segments
}

function formatToolSummarySegment(
  category: ToolSummaryCategory,
  count: number,
  phase: ToolSummaryPhase,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const key = `toolSteps.${category}${phase.charAt(0).toUpperCase()}${phase.slice(1)}`
  return t(key, { count })
}

function getToolSummaryCategory(toolName: string): ToolSummaryCategory {
  const lower = toolName.toLowerCase()

  if (lower.includes('todo')) return 'todo'
  if (isSubagentToolName(lower)) return 'task'
  if (lower.includes('question') || lower.includes('ask')) return 'question'
  if (lower.includes('skill')) return 'skill'
  if (
    lower.includes('bash') ||
    lower === 'sh' ||
    lower.includes('cmd') ||
    lower.includes('terminal') ||
    lower.includes('shell')
  ) {
    return 'execute'
  }
  if (lower.includes('write') || lower.includes('save')) {
    return 'write'
  }
  if (lower.includes('edit') || lower.includes('replace') || lower.includes('patch')) {
    return 'edit'
  }
  if (
    lower.includes('web') ||
    lower.includes('fetch') ||
    lower.includes('http') ||
    lower.includes('browse') ||
    lower.includes('network') ||
    lower.includes('exa')
  ) {
    return 'network'
  }
  if (lower.includes('read') || lower.includes('cat')) return 'read'
  if (lower.includes('grep') || lower.includes('search')) return 'search'
  if (lower.includes('glob') || lower.includes('find')) return 'list'
  if (lower.includes('think') || lower.includes('reason') || lower.includes('plan')) return 'think'
  return 'other'
}

function isToolPartActive(part: ToolPart): boolean {
  return part.state.status === 'running' || part.state.status === 'pending'
}

function getTaskChildSessionId(part: ToolPart): string | undefined {
  return getSubagentSessionId(part)
}
