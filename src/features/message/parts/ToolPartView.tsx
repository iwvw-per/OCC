import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { diffLines } from 'diff'
import { DisclosureRow } from '../../../components/ui/DisclosureRow'
import { StopIcon, TaskDoneIcon, ChevronDownIcon } from '../../../components/Icons'
import { ToolParamChip } from './ToolParamChip'
import type { ToolPart } from '../../../types/message'
import { isSubagentToolName, getSubagentSessionId, isBackgroundSubagentOutput } from '../subagentUtils'
import { useCompositorExpand, useDisclosureScrollLock } from '../../../hooks'
import { useNow } from '../../../hooks/useNow'
import { useMinDurationActive } from '../../../hooks/useMinDurationActive'
import { serverStore } from '../../../store/serverStore'
import { childSessionStore, useChildSessionStatus } from '../../../store/childSessionStore'
import { messageStore } from '../../../store/messageStore'
import { useSessionStatus } from '../../../store/activeSessionStore'
import { useSessionNavigation } from '../../../contexts/SessionNavigationContext'
import { abortSession, backgroundSessionTools } from '../../../api'
import { makeSessionKey, splitSessionKey } from '../../../utils/sessionKey'
import { useTheme } from '../../../hooks/useTheme'
import { formatToolName, formatDuration } from '../../../utils/formatUtils'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import {
  useInlineToolRequests,
  findPermissionRequestForTool,
  findQuestionRequestForTool,
} from '../../chat/InlineToolRequestContext'
import { InlinePermission } from '../../chat/InlinePermission'
import { InlineQuestion } from '../../chat/InlineQuestion'
import {
  getToolIcon,
  extractToolCallsFromCode,
  getToolColorClass,
  extractToolData,
  getToolConfig,
  DefaultRenderer,
  TaskRenderer,
  TaskAgentBadge,
} from '../tools'
import { MSG_SPACING } from '../messageSpacing'
import { MessageExpandPanel } from '../messageExpand'
import { useMessageExpandRender } from '../messageExpandShared'
import { getToolDisplayName } from './toolDisplayName'

// ============================================
// ToolPartView - 单个工具调用
// ============================================

/**
 * 「可能卡住」判定：不看是否收到完成事件，而看任务本身是否还在运行/产出。
 *
 * 旧实现只看 part 停在 running 的时长，长命令（如构建）只要没回完成事件就误报。
 * 现在综合两个信号：
 * - 会话是否还在运行（busy/retry）：会话已停但仍 active，说明 part 悬空；
 * - 工具是否还在产出（输出内容仍在变化）：仍在产出则不算卡住。
 *
 * 会话已停：active 超过 STUCK_TOOL_THRESHOLD_MS 即提示。
 * 会话仍在运行：此前有输出、但停更超过 STUCK_TOOL_STALL_MS 才提示，
 * 避免对「还在跑但暂无输出」的长命令误报。
 */
const STUCK_TOOL_THRESHOLD_MS = 60_000
const STUCK_TOOL_STALL_MS = 120_000
/** 工具耗时不可能超过 30 天；超过说明 start 是坏值（0 或单位错），视为缺失，避免「两万天」读数。 */
const MAX_TOOL_DURATION_MS = 30 * 24 * 60 * 60 * 1000

interface ToolPartViewProps {
  part: ToolPart
  isFirst?: boolean
  isLast?: boolean
  /** Compact layout: icon inline with text (14px column), no timeline connectors.
   *  Used for single-tool groups to align with ReasoningPartView. */
  compact?: boolean
  /** Descriptive steps mode: no icon/timeline, flat rows aligned with step summary. */
  descriptive?: boolean
  /** Parent assistant message is still streaming. */
  isStreaming?: boolean
}

export const ToolPartView = memo(function ToolPartView({
  part,
  isFirst = false,
  isLast = false,
  compact = false,
  descriptive = false,
  isStreaming = false,
}: ToolPartViewProps) {
  const { t } = useTranslation('message')
  const { state, tool: toolName } = part
  const { currentSessionId } = useSessionNavigation()
  // part.tool 就是真实工具名（已由数据库实测确认）。个别 MCP 代理工具会显式
  // 提供 displayName，仅在存在时才覆盖。
  const toolDisplayName = getToolDisplayName(part) ?? toolName
  const title = state.title || getInputDescription(part) || ''

  /**
   * execute（Code Mode）在 input.code 里通过 tools.xxx() 调用其它工具。
   * 只显示「Execute」等于什么都没说 —— 摘要里补上实际调用，例如
   * 「Execute · get_system_status, find_api」，一眼能看出做了什么。
   */
  const executeCallSummary = useMemo(() => {
    if (part.tool !== 'execute') return ''
    const code = (state.input as Record<string, unknown> | undefined)?.code
    if (typeof code !== 'string') return ''
    return extractToolCallsFromCode(code).slice(0, 3).join(', ')
  }, [part.tool, state.input])

  const isActive = state.status === 'running' || state.status === 'pending'
  const isError = state.status === 'error'
  const isInterrupted = state.status === 'interrupted'

  // 子代理（task/subagent）。v2 支持「后台子代理」：父工具调用已返回（completed），
  // 子会话仍在后台运行。此时按「后台运行中」呈现——保留转圈与停止按钮，
  // 否则用户会以为任务已经结束。子会话 id 从 metadata / 输出解析（含 v2 后台文本格式）。
  const childSessionId = getTaskChildSessionId(part)
  const subagentChildKey = useMemo(() => {
    if (!childSessionId) return null
    if (childSessionId.includes('::')) return childSessionId
    const serverId = splitSessionKey(part.sessionID).serverId || serverStore.getActiveServerId()
    return makeSessionKey(serverId, childSessionId)
  }, [childSessionId, part.sessionID])
  const childStatus = useChildSessionStatus(subagentChildKey)
  // 「后台子代理」需同时满足：输出是后台回执、父工具已返回、子会话仍在跑。
  // 用后台回执文本作门控，避免前台子代理在「父工具已完成、子会话 idle 尚未到达」
  // 的窗口内被误标为后台运行。
  const backgroundRunning =
    isSubagentToolName(toolName) &&
    isBackgroundSubagentOutput(state.output) &&
    !isActive &&
    childStatus === 'running'

  // 运行态视觉至少保持 300ms：工具跑得极快时扫光只闪一帧，看起来像界面在抖。
  // 计时读数仍用真实 isActive，只有视觉（扫光、图标旋转）用这个。
  const showRunningVisual = useMinDurationActive(isActive || backgroundRunning, 300)
  const now = useNow(250, isActive)
  const rawStart = state.time?.start
  const startTime = typeof rawStart === 'number' && rawStart > 0 ? rawStart : undefined
  const calibratedNow = isActive ? serverStore.getActiveCalibratedNow() : undefined
  const endTime = state.time?.end ?? (isActive ? (calibratedNow ?? now) : undefined)
  const rawDuration = startTime !== undefined && endTime !== undefined ? endTime - startTime : undefined
  const duration =
    rawDuration === undefined || rawDuration > MAX_TOOL_DURATION_MS
      ? undefined
      : isActive
        ? Math.max(0, rawDuration)
        : rawDuration

  // 会话是否还在运行（busy/retry）。会话已停但 part 仍 active，即为悬空。
  const sessionStatus = useSessionStatus(part.sessionID)
  const sessionRunning = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry'

  // 任务是否还在产出：运行态输出在 metadata.output，完成后在 state.output。
  const progressOutput = state.output ?? (state.metadata?.output as string | undefined)
  const [lastProgress, setLastProgress] = useState(() => ({ output: progressOutput ?? '', at: Date.now() }))
  useEffect(() => {
    if ((progressOutput ?? '') !== lastProgress.output) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 输出变化时刷新停更计时基准
      setLastProgress({ output: progressOutput ?? '', at: Date.now() })
    }
  }, [progressOutput, lastProgress.output])
  // 有输出但停更的时长；从未有过输出时返回 undefined，退回「会话是否运行」判断。
  const stalledFor = progressOutput ? now - lastProgress.at : undefined

  const isStuck = isActive && duration !== undefined && (
    sessionRunning
      ? stalledFor !== undefined && stalledFor >= STUCK_TOOL_STALL_MS
      : duration >= STUCK_TOOL_THRESHOLD_MS
  )
  const { inlineToolRequests, immersiveMode, compactInlinePermission } = useTheme()

  const { pendingPermissions, pendingQuestions, onPermissionReply, onQuestionReply, onQuestionReject, isReplying } =
    useInlineToolRequests()
  const permissionRequest = inlineToolRequests
    ? findPermissionRequestForTool(pendingPermissions, part.callID, childSessionId)
    : undefined
  const questionRequest = inlineToolRequests
    ? findQuestionRequestForTool(pendingQuestions, part.callID, childSessionId)
    : undefined

  const toolDone = state.status === 'completed' || state.status === 'error' || isInterrupted
  // 完成/中断/运行中都展示耗时读数；中断态 time.end 已由对账补齐
  const showDuration = duration !== undefined && (state.status === 'completed' || isActive || isInterrupted)
  // ── 延迟卸载 edit/write 权限组件 ──
  // 用户授权后 permissionRequest 会立即消失，但工具结果可能还没到，
  // 为了避免 "权限消失→空白→结果出现" 的跳动，缓存最后一次权限请求，
  // 在工具完成之前继续渲染（以 resolved 状态）
  const [cachedPermissionRequest, setCachedPermissionRequest] = useState(permissionRequest)
  useEffect(() => {
    let frameId: number | null = null

    if (permissionRequest) {
      frameId = requestAnimationFrame(() => {
        setCachedPermissionRequest(permissionRequest)
      })
    } else if (toolDone) {
      frameId = requestAnimationFrame(() => {
        setCachedPermissionRequest(undefined)
      })
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [permissionRequest, toolDone])

  const effectivePermissionRequest = permissionRequest || cachedPermissionRequest
  const isFilePermission =
    effectivePermissionRequest?.permission === 'edit' || effectivePermissionRequest?.permission === 'write'
  // 权限已批准但工具还没完成 → 保留渲染
  const permissionResolved = !permissionRequest && !!cachedPermissionRequest && isFilePermission && !toolDone

  const hasPendingInteraction = !!permissionRequest || !!questionRequest
  // 精简模式：非 edit/write 权限时不隐藏 ToolBody（ToolBody 已经渲染了命令内容）
  const isEditWritePermission =
    permissionRequest?.permission === 'edit' || permissionRequest?.permission === 'write' || permissionResolved
  const hideToolBodyForPermission = isEditWritePermission
  // 精简模式：ToolBody 已渲染时，InlinePermission 只显示按钮
  // task 工具除外：task renderer 无法显示详细的工具请求内容，需要完整展示权限信息
  const isTaskTool = isSubagentToolName(toolName)
  const permissionContentHidden =
    compactInlinePermission && !isEditWritePermission && !isTaskTool && !!permissionRequest
  const isReadable = isReadableTool(toolName)
  const shouldStartExpanded =
    isActive ||
    hasPendingInteraction ||
    permissionResolved ||
    (immersiveMode && descriptive && isStreaming && isReadable)

  const [expanded, setExpanded] = useUiDisclosureState(`message:${part.messageID}:tool:${part.id}`, shouldStartExpanded)
  const hasAutoExpandedReadableRef = useRef(shouldStartExpanded && immersiveMode && descriptive && isReadable)
  const [isChildFullscreen, setIsChildFullscreen] = useState(false)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const effectiveExpanded = expanded || hasPendingInteraction || permissionResolved || isChildFullscreen
  // Android expand: instant layout + max-height fake; collapse: original grid-rows.
  const {
    contentRef: expandContentRef,
    layoutOpen,
    keepMounted,
    panelClassName,
  } = useCompositorExpand(effectiveExpanded)
  // 展开即挂 body：默认展开的工具 header/body 同帧，不再先 header 后 body
  const shouldRenderBody = useMessageExpandRender(keepMounted)
  const toggleExpanded = useCallback(() => {
    withScrollLock(() => setExpanded(!expanded))
  }, [expanded, setExpanded, withScrollLock])

  useEffect(() => {
    let frameId: number | null = null

    if (isActive || hasPendingInteraction || permissionResolved) {
      if (immersiveMode && descriptive && isReadable) {
        hasAutoExpandedReadableRef.current = true
      }
      frameId = requestAnimationFrame(() => {
        setExpanded(true, { touched: false, respectUser: true })
      })
    } else if (immersiveMode && descriptive && !isReadable) {
      frameId = requestAnimationFrame(() => {
        setExpanded(false, { touched: false, respectUser: true })
      })
    } else if (immersiveMode && descriptive && isStreaming && isReadable && !hasAutoExpandedReadableRef.current) {
      hasAutoExpandedReadableRef.current = true
      frameId = requestAnimationFrame(() => {
        setExpanded(true, { touched: false, respectUser: true })
      })
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [
    isActive,
    hasPendingInteraction,
    permissionResolved,
    immersiveMode,
    descriptive,
    isStreaming,
    isReadable,
    setExpanded,
  ])

  // Shared icon element
  // 子代理（task）的图标语义是「正在跑」，运行时让它真的转；
  // 其它工具图标代表类型，不旋转（转一个文件/终端图标没有意义）。
  // task 完成后换成绿色空心圆对勾，明确表达「子任务已结束」。
  // 已完成的中性态按工具类别着色（多彩），运行中/失败仍用语义色。
  const isTaskDone = isSubagentToolName(toolName) && state.status === 'completed' && !backgroundRunning
  const iconSpins = showRunningVisual && isSubagentToolName(toolName)
  const neutralColorClass =
    !isActive && !backgroundRunning && !isError && !isInterrupted && !isTaskDone ? getToolColorClass(toolName) : ''
  const toolIcon = (
    <div
      className={`
      relative flex items-center justify-center transition-colors duration-200
      ${isActive || backgroundRunning ? 'text-accent-main-100' : ''}
      ${isError ? 'text-danger-100' : ''}
      ${isInterrupted ? 'text-warning-100' : ''}
      ${isTaskDone ? 'text-success-100' : ''}
      ${neutralColorClass}
      ${iconSpins ? 'animate-spin' : ''}
    `}
    >
      {isTaskDone ? <TaskDoneIcon size={16} /> : getToolIcon(toolName)}
    </div>
  )

  // 需要渲染权限组件的请求对象：优先用活跃的，否则用缓存的（resolved 态）
  const displayPermission = permissionRequest || (permissionResolved ? cachedPermissionRequest : undefined)

  // Memoize once — shared by both the descriptive header (diffStats) and ToolBody.
  const toolData = useMemo(() => extractToolData(part), [part])

  // ── task 工具的合并表头 ──
  // task 就是「派生子代理」这个动作本身，它和被派起的子代理不是两个东西，
  // 所以这一行直接显示「子代理徽标 + 描述」，而不是「Task + 描述」再另起一行。
  const taskSubagentType =
    isTaskTool && part.state.input ? ((part.state.input as Record<string, unknown>).subagent_type as string) : undefined
  const taskAgentLabel = taskSubagentType || (isTaskTool ? 'general' : undefined)
  const taskBadgeTone = isError
    ? 'danger'
    : isActive || backgroundRunning
      ? 'accent'
      : state.status === 'completed'
        ? 'success'
        : 'neutral'
  const taskTitle = taskAgentLabel ? (
    <span className="flex items-center gap-2">
      <TaskAgentBadge agentType={taskAgentLabel} tone={taskBadgeTone} sessionId={childSessionId} />
      {title && <span className="min-w-0 truncate text-[length:var(--fs-sm)]">{title}</span>}
      {backgroundRunning && (
        <span className="shrink-0 text-[length:var(--fs-xxs)] font-medium text-accent-main-100">
          {t('task.backgroundRunning')}
        </span>
      )}
    </span>
  ) : null

  // 合并表头后，原来挂在 TaskRenderer 表头里的「停止」按钮要移到这里，
  // 否则运行中无法中止子代理。
  const handleStopTask = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!childSessionId) return
      const serverId = currentSessionId ? splitSessionKey(currentSessionId).serverId : undefined
      const childScoped = childSessionId.includes('::')
        ? childSessionId
        : makeSessionKey(serverId ?? serverStore.getActiveServerId(), childSessionId)
      const childInfo = childSessionStore.getSessionInfo(childScoped)
      const parentSessionId = childInfo?.parentID || currentSessionId || null
      const parentState = parentSessionId ? messageStore.getSessionState(parentSessionId) : null
      const directory = parentState?.directory || ''
      void abortSession(childSessionId, directory, serverId)
    },
    [childSessionId, currentSessionId],
  )
  const taskStopButton = isTaskTool && (isActive || backgroundRunning) && childSessionId ? (
    <button
      type="button"
      onClick={handleStopTask}
      aria-label={t('task.stop')}
      title={t('task.stop')}
      className="w-[18px] h-[18px] p-0 flex items-center justify-center text-text-400 hover:text-danger-100 hover:bg-danger-100/10 active:bg-danger-100/20 rounded-sm transition-colors bg-transparent border-none"
    >
      <StopIcon size={10} />
    </button>
  ) : null

  // 非 task 工具卡住时没有单工具中止接口，只能中止整个会话；task 走上面的子会话 Stop。
  const handleAbortStuck = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!currentSessionId) return
      const { serverId } = splitSessionKey(currentSessionId)
      const state = messageStore.getSessionState(currentSessionId)
      void abortSession(currentSessionId, state?.directory || '', serverId || undefined)
    },
    [currentSessionId],
  )

  /**
   * 把卡住的工具转入后台（v2 session.background）。
   *
   * 比 abortSession 温和得多：工具继续跑，会话立刻可以继续下一轮。
   * 之前用户面对卡住的工具只有「中止整个会话」一条路，代价是这一轮全废。
   */
  const handleBackgroundStuck = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!currentSessionId) return
      const { serverId } = splitSessionKey(currentSessionId)
      const state = messageStore.getSessionState(currentSessionId)
      void backgroundSessionTools(currentSessionId, state?.directory || '', serverId || undefined).catch(() => {})
    },
    [currentSessionId],
  )
  const stuckHint = isStuck ? (
    <span className="flex items-center gap-1 shrink-0 text-[length:var(--fs-xxs)] font-medium text-warning-100">
      {t('toolPart.maybeStuck')}
      {!taskStopButton && (
        <>
          {/* 转后台：比「中止整个会话」温和得多 —— 工具继续跑，会话可以立刻继续 */}
          <button
            type="button"
            onClick={handleBackgroundStuck}
            aria-label={t('toolPart.moveToBackground')}
            title={t('toolPart.moveToBackground')}
            className="w-[18px] h-[18px] p-0 flex items-center justify-center text-warning-100 hover:text-accent-main-100 hover:bg-accent-main-100/10 active:bg-accent-main-100/20 rounded-sm transition-colors bg-transparent border-none"
          >
            <ChevronDownIcon size={10} />
          </button>
          <button
            type="button"
            onClick={handleAbortStuck}
            aria-label={t('toolPart.abortStuck')}
            title={t('toolPart.abortStuck')}
            className="w-[18px] h-[18px] p-0 flex items-center justify-center text-warning-100 hover:text-danger-100 hover:bg-danger-100/10 active:bg-danger-100/20 rounded-sm transition-colors bg-transparent border-none"
          >
            <StopIcon size={10} />
          </button>
        </>
      )}
    </span>
  ) : null

  const handleFullscreenChange = useCallback((isFullscreen: boolean) => {
    setIsChildFullscreen(isFullscreen)
  }, [])

  const bodyContent = (
    <>
      {!hideToolBodyForPermission && (
        <ToolBody part={part} data={toolData} onFullscreenChange={handleFullscreenChange} />
      )}
      {displayPermission && (
        <div className={hideToolBodyForPermission && !permissionContentHidden ? '' : MSG_SPACING.inner}>
          <InlinePermission
            request={displayPermission}
            onReply={onPermissionReply}
            isReplying={isReplying}
            resolved={permissionResolved}
            contentHidden={permissionContentHidden}
          />
        </div>
      )}
      {questionRequest && (
        <div className={MSG_SPACING.inner}>
          <InlineQuestion
            request={questionRequest}
            onReply={onQuestionReply}
            onReject={onQuestionReject}
            isReplying={isReplying}
          />
        </div>
      )}
    </>
  )

  const expandBody = (padClass: string) => (
    <MessageExpandPanel
      open={layoutOpen}
      panelClassName={panelClassName}
      contentRef={expandContentRef}
      innerClassName="overflow-hidden min-h-0"
      contentClassName={padClass}
    >
      {shouldRenderBody && bodyContent}
    </MessageExpandPanel>
  )

  if (descriptive) {
    const hasDiffFiles = !!toolData.files?.length
    // diffStats 可能从 metadata 来，也可能需要从 diff 数据计算
    const diffStats = toolData.diffStats || computeDiffStatsFromData(toolData)

    return (
      <div ref={rootRef} className={`group ${MSG_SPACING.item}`}>
        <DisclosureRow
          ref={headerRef}
          expanded={effectiveExpanded}
          onClick={toggleExpanded}
          size="sm"
          className="group/header gap-2"
          truncateLabel={false}
          labelTone={showRunningVisual ? 'active' : isError ? 'error' : isInterrupted ? 'warning' : 'idle'}
          icon={toolIcon}
          label={
            <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              {taskTitle ?? (
                <>
                  <span className="shrink-0 font-medium text-[length:var(--fs-md)] leading-tight">
                    {formatToolName(toolDisplayName)}
                  </span>

                  {title && <ToolParamChip text={title} error={isError} />}
                  {!title && executeCallSummary && <ToolParamChip text={executeCallSummary} error={isError} />}
                </>
              )}

              {/* Diff stats — 紧跟 title，收起时且非失败时显示 */}
              {!effectiveExpanded && !isActive && !isError && (diffStats || hasDiffFiles) && (
                <span className="shrink-0 flex items-center gap-1 text-[length:var(--fs-xxs)] font-medium tabular-nums">
                  {(diffStats?.additions ?? 0) > 0 && <span className="text-success-100">+{diffStats!.additions}</span>}
                  {(diffStats?.deletions ?? 0) > 0 && <span className="text-danger-100">-{diffStats!.deletions}</span>}
                </span>
              )}
            </span>
          }
          meta={
            <>
              {stuckHint}
              {isInterrupted && (
                <span className="shrink-0 text-[length:var(--fs-xxs)] font-medium text-warning-100">
                  {t('toolPart.interrupted')}
                </span>
              )}
              {showDuration && (
                <span
                  className={`text-[length:var(--fs-xxs)] tabular-nums ${isError ? 'text-danger-100/70' : isActive ? 'reasoning-shimmer-text' : 'text-text-500'}`}
                >
                  {formatDuration(duration!)}
                </span>
              )}
            </>
          }
        />

        {expandBody(MSG_SPACING.body)}
      </div>
    )
  }

  // ── Compact layout (single-tool, no timeline) ──
  // Grid: [14px icon] [gap 6px] [content] — mirrors ReasoningPartView alignment
  if (compact) {
    return (
      <div
        ref={rootRef}
        className={`group relative grid grid-cols-[16px_minmax(0,1fr)] gap-x-1.5 items-start ${MSG_SPACING.item}`}
      >
        {/* Icon column — fixed, outside of interactive area */}
        <span className="inline-flex h-9 w-4 items-center justify-center shrink-0">{toolIcon}</span>

        {/* Content column */}
        <div className="min-w-0">
          <DisclosureRow
            ref={headerRef}
            expanded={effectiveExpanded}
            onClick={toggleExpanded}
            size="lg"
            inset={false}
            className="group/header pl-2 pr-0"
            truncateLabel={false}
            labelTone={showRunningVisual ? 'active' : isError ? 'error' : isInterrupted ? 'warning' : 'idle'}
            label={
              <span className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
                {taskTitle ?? (
                  <>
                    <span className="font-medium text-[length:var(--fs-md)] leading-tight transition-colors duration-300 shrink-0">
                      {formatToolName(toolDisplayName)}
                    </span>
                    {title && <ToolParamChip text={title} error={isError} />}
                    {!title && executeCallSummary && <ToolParamChip text={executeCallSummary} error={isError} />}
                  </>
                )}
              </span>
            }
            meta={
              <>
                {stuckHint}
                {isInterrupted && (
                  <span className="text-[length:var(--fs-xxs)] font-medium text-warning-100">
                    {t('toolPart.interrupted')}
                  </span>
                )}
                {showDuration && (
                  <span
                    className={`text-[length:var(--fs-xxs)] tabular-nums ${
                      isActive ? 'reasoning-shimmer-text' : 'text-text-500'
                    }`}
                  >
                    {formatDuration(duration!)}
                  </span>
                )}
                <span
                  className={`text-[length:var(--fs-xxs)] font-medium transition-all duration-300 ${
                    isActive ? 'opacity-100 text-text-400' : 'opacity-0 w-0 overflow-hidden'
                  }`}
                >
                  {t('toolPart.running')}
                </span>
                <span
                  className={`text-[length:var(--fs-xxs)] font-medium transition-all duration-300 ${
                    isError ? 'opacity-100 text-danger-100' : 'opacity-0 w-0 overflow-hidden'
                  }`}
                >
                  {t('toolPart.failed')}
                </span>
              </>
            }
          />

          {expandBody(MSG_SPACING.toolBodyInset)}
        </div>
      </div>
    )
  }

  // ── Timeline layout (multi-tool groups) ──
  // 根节点不加垂直 padding，连接线要贴 icon
  return (
    <div ref={rootRef} className="group relative flex min-w-0">
      {/* Timeline Column */}
      <div className="w-8 shrink-0 relative">
        {/* Top connector — 留 4px gap 到 icon */}
        {!isFirst && <div className="absolute left-1/2 -translate-x-1/2 top-0 h-[7px] w-px bg-border-300/40" />}

        {/* Tool icon — h-9 和右侧 header 等高，flex 自然居中 */}
        <div className="h-9 flex items-center justify-center relative z-10">{toolIcon}</div>

        {/* Bottom connector — 留 4px gap 到 icon */}
        {!isLast && <div className="absolute left-1/2 -translate-x-1/2 top-[29px] bottom-0 w-px bg-border-300/40" />}
      </div>

      {/* Content Column */}
      <div className="flex-1 min-w-0">
        {/* Header - h-9 和 timeline 图标行等高 */}
        <DisclosureRow
          ref={headerRef}
          expanded={effectiveExpanded}
          onClick={toggleExpanded}
          size="lg"
          inset={false}
          className="group/header gap-2.5 pl-2 pr-0"
          truncateLabel={false}
          labelTone={showRunningVisual ? 'active' : isError ? 'error' : isInterrupted ? 'warning' : 'idle'}
          label={
            <span className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
              {taskTitle ?? (
                <>
                  <span className="font-medium text-[length:var(--fs-md)] leading-tight transition-colors duration-300 shrink-0">
                    {formatToolName(toolDisplayName)}
                  </span>

                  {title && <ToolParamChip text={title} error={isError} />}
                  {!title && executeCallSummary && <ToolParamChip text={executeCallSummary} error={isError} />}
                </>
              )}
            </span>
          }
          meta={
            <>
              {taskStopButton}
              {stuckHint}
              {isInterrupted && (
                <span className="text-[length:var(--fs-xxs)] font-medium text-warning-100">
                  {t('toolPart.interrupted')}
                </span>
              )}
              {showDuration && (
                <span
                  className={`text-[length:var(--fs-xxs)] tabular-nums transition-opacity duration-300 ${
                    isActive ? 'reasoning-shimmer-text' : 'text-text-500'
                  }`}
                >
                  {formatDuration(duration!)}
                </span>
              )}
              <span
                className={`text-[length:var(--fs-xxs)] font-medium transition-all duration-300 ${
                  isActive ? 'opacity-100 text-text-400' : 'opacity-0 w-0 overflow-hidden'
                }`}
              >
                {t('toolPart.running')}
              </span>
              <span
                className={`text-[length:var(--fs-xxs)] font-medium transition-all duration-300 ${
                  isError ? 'opacity-100 text-danger-100' : 'opacity-0 w-0 overflow-hidden'
                }`}
              >
                {t('toolPart.failed')}
              </span>
            </>
          }
        />

        {expandBody(MSG_SPACING.toolBodyInset)}
      </div>
    </div>
  )
})

// ============================================
// Helpers
// ============================================

/** 用户需要阅读/交互的工具 */
const READABLE_TOOL_PATTERNS = /bash|\bsh\b|cmd|terminal|shell|write|save|edit|replace|patch|todo|question|ask/i

function isReadableTool(toolName: string): boolean {
  return READABLE_TOOL_PATTERNS.test(toolName.toLowerCase())
}

/** 从 diff 数据计算 diffStats（当 metadata 没给 diffStats 时用） */
function computeDiffStatsFromData(data: {
  diff?: { before: string; after: string } | string
  files?: Array<{ before?: string; after?: string; additions?: number; deletions?: number }>
}): { additions: number; deletions: number } | undefined {
  // 多文件
  if (data.files?.length) {
    let additions = 0,
      deletions = 0
    for (const f of data.files) {
      if (f.additions !== undefined) additions += f.additions
      if (f.deletions !== undefined) deletions += f.deletions
      if (f.additions === undefined && f.before !== undefined && f.after !== undefined) {
        const s = computeDiffPair(f.before, f.after)
        additions += s.additions
        deletions += s.deletions
      }
    }
    return additions || deletions ? { additions, deletions } : undefined
  }

  // 单个 diff
  if (data.diff && typeof data.diff === 'object') {
    const s = computeDiffPair(data.diff.before, data.diff.after)
    return s.additions || s.deletions ? s : undefined
  }

  return undefined
}

function computeDiffPair(before: string, after: string): { additions: number; deletions: number } {
  const changes = diffLines(before, after)
  let additions = 0,
    deletions = 0
  for (const c of changes) {
    if (c.added) additions += c.count || 0
    if (c.removed) deletions += c.count || 0
  }
  return { additions, deletions }
}

// ============================================
// ToolBody - 根据工具类型选择渲染器
// ============================================

const ToolBody = memo(function ToolBody({
  part,
  data,
  onFullscreenChange,
}: {
  part: ToolPart
  data: ReturnType<typeof extractToolData>
  onFullscreenChange?: (isFullscreen: boolean) => void
}) {
  const { tool } = part
  const lowerTool = tool.toLowerCase()

  if (isSubagentToolName(lowerTool)) {
    return <TaskRenderer part={part} data={data} onFullscreenChange={onFullscreenChange} />
  }

  /**
   * todowrite 不在对话里渲染。
   *
   * 待办列表已经在两个更合适的位置常驻：输入框下方的信息栏（一行进度 + 可展开
   * 明细）与右侧工作状态面板（Tasks 板块，完整视图）。在对话流里再画一张卡片
   * 属于第三份重复，而且会把正文推远。
   *
   * 返回 null 而不是走 DefaultRenderer：默认渲染器会画成一张工具调用卡片
   * （图标 + 「Updated tasks」+ 折叠箭头），仍然是同一份信息。
   */
  if (lowerTool.includes('todo')) {
    return null
  }

  const config = getToolConfig(tool)
  if (config?.renderer) {
    const CustomRenderer = config.renderer
    return <CustomRenderer part={part} data={data} onFullscreenChange={onFullscreenChange} />
  }

  return <DefaultRenderer part={part} data={data} onFullscreenChange={onFullscreenChange} />
})

function getTaskChildSessionId(part: ToolPart): string | undefined {
  return getSubagentSessionId(part)
}

/** Extract description from tool input as title fallback (available while running) */
function getInputDescription(part: ToolPart): string | undefined {
  const input = part.state.input as Record<string, unknown> | undefined
  return (input?.description as string) || undefined
}

// ============================================
// Helpers
// ============================================
