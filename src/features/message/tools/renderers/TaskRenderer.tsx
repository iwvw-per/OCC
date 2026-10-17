import { memo, useCallback, useRef, useEffect, type RefCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ContentBlock } from '../../../../components'
import { ExternalLinkIcon, StopIcon, UsersIcon, TaskDoneIcon } from '../../../../components/Icons'
import { Chip } from '../../../../components/ui/Chip'
import { DisclosureRow } from '../../../../components/ui/DisclosureRow'
import { Spinner } from '../../../../components/ui/Spinner'
import { StatusDot } from '../../../../components/ui/StatusDot'
import { useResponsiveMaxHeight } from '../../../../hooks'
import { useSessionState, messageStore, childSessionStore } from '../../../../store'
import { useSessionNavigation } from '../../../../contexts/SessionNavigationContext'
import { getSessionMessages } from '../../../../api'
import { makeSessionKey, splitSessionKey } from '../../../../utils/sessionKey'
import { serverStore } from '../../../../store/serverStore'
import { sessionErrorHandler } from '../../../../utils'
import { formatToolName } from '../../../../utils/formatUtils'
import type { ToolRendererProps } from '../types'
import type { Message, TextPart, ToolPart } from '../../../../types/message'
import { isVisibleTextContent } from '../../../../types/message'
import { getSubagentSessionId } from '../../subagentUtils'

const EMPTY_MESSAGES: Message[] = []

// ============================================
// Task Tool Renderer (子 agent)
//
// 设计原则：
// 1. 渐进式展开 - 默认显示摘要，点击展开详情
// 2. 视觉层次 - 左侧缩进线区分嵌套层级
// 3. 状态优先 - 运行中/完成/错误状态一目了然
// 4. 按需交互 - 输入框只在需要时显示
// ============================================

/**
 * 子代理任务渲染器 —— 只负责「内容」，不再渲染表头。
 *
 * task 工具本身就是派生子代理的入口，两者是「调用手段」与「被调起的执行体」，
 * 不是并列关系。此前它自己又画一行表头，导致同一个 task 出现
 * 「Task 描述」+「explore 描述」两行重复、描述文字出现两次。
 * 表头统一由 ToolPartView 的 task 行提供（图标 + 子代理徽标 + 描述）。
 */
export const TaskRenderer = memo(function TaskRenderer({ part, onFullscreenChange }: ToolRendererProps) {
  return <TaskBody part={part} onFullscreenChange={onFullscreenChange} />
})

/**
 * 子代理任务的「内容部分」：prompt、子会话消息、结果、错误。
 *
 * 不含表头——表头已由调用方（ToolPartView 的 task 行）提供。
 * 这样 task 工具只渲染一行「[子代理徽标] 描述」，不再出现
 * 「Task 描述」+「explore 描述」两行重复。
 */
export const TaskBody = memo(function TaskBody({
  part,
  onFullscreenChange,
}: {
  part: ToolPart
  onFullscreenChange?: (isFullscreen: boolean) => void
}) {
  const { t } = useTranslation('message')
  const { currentSessionId } = useSessionNavigation()
  const { state } = part

  const input = state.input as Record<string, unknown> | undefined
  const prompt = (input?.prompt as string) || ''

  const metadata = state.metadata as Record<string, unknown> | undefined
  // v2 的子会话 id 可能在输出里（<subagent sessionID="...">），统一从 helper 取
  const targetSessionId = getSubagentSessionId(part) ?? (metadata?.sessionId as string | undefined)

  const isCompleted = state.status === 'completed'
  const isError = state.status === 'error'

  // 子 session 属于当前消息所属 session（父 session）的服务器
  const taskServerId = currentSessionId ? splitSessionKey(currentSessionId).serverId : undefined

  const handleContentFullscreenChange = useCallback(
    (isFullscreen: boolean) => {
      onFullscreenChange?.(isFullscreen)
    },
    [onFullscreenChange],
  )

  return (
    <div className="pt-2 space-y-3">
      {/* Prompt：有子会话时不再外显——派发给子代理的消息已在子会话框内作为
          用户消息展示，外面再重复一遍既冗余又占地方。只有拿不到子会话
          （旧数据 / 尚未创建）时才在外层兜底显示，避免信息丢失。 */}
      {prompt && !targetSessionId && (
        <div className="text-[length:var(--fs-xs)] text-text-500 leading-relaxed whitespace-nowrap overflow-hidden text-ellipsis">
          {prompt}
        </div>
      )}

      {/* 子会话内容 */}
      {targetSessionId && (
        <SubSessionView
          sessionId={targetSessionId}
          serverId={taskServerId}
          isParentRunning={state.status === 'running' || state.status === 'pending'}
        />
      )}

      {/* 完成时的输出 */}
      {isCompleted && state.output !== undefined && state.output !== null && (
        <ContentBlock
          label={t('task.result')}
          stateKey={`message:${part.messageID}:tool:${part.id}:task-result`}
          content={typeof state.output === 'string' ? state.output : JSON.stringify(state.output, null, 2)}
          defaultCollapsed={true}
          onFullscreenChange={handleContentFullscreenChange}
          fullscreenId={`task:${part.sessionID}:${part.messageID}:${part.id}:result`}
        />
      )}

      {/* 错误信息 */}
      {isError && state.error !== undefined && (
        <ContentBlock
          label={t('task.error')}
          stateKey={`message:${part.messageID}:tool:${part.id}:task-error`}
          content={typeof state.error === 'string' ? state.error : JSON.stringify(state.error)}
          variant="error"
          onFullscreenChange={handleContentFullscreenChange}
          fullscreenId={`task:${part.sessionID}:${part.messageID}:${part.id}:error`}
        />
      )}
    </div>
  )
})

// ============================================
// Task Header
// ============================================

/**
 * 打开某个子会话：未分屏时优先在分屏视图中打开（父会话保留在当前 pane），
 * 否则在当前 pane 内导航过去。
 *
 * 抽成 hook 是因为「task 工具行」和「子代理表头」现在是同一行（见 ToolPartView），
 * 两处都要这个跳转，逻辑只能有一份。
 */
function useOpenTaskSession(sessionId?: string) {
  const { navigateToSession, openSessionInSplit, currentSessionId, currentDirectory } = useSessionNavigation()

  return useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!sessionId) return

      const serverId = currentSessionId ? splitSessionKey(currentSessionId).serverId : undefined
      const scoped = sessionId.includes('::')
        ? sessionId
        : makeSessionKey(serverId ?? serverStore.getActiveServerId(), sessionId)
      const childInfo = childSessionStore.getSessionInfo(scoped)
      const parentSessionId = childInfo?.parentID || currentSessionId || null
      const parentState = parentSessionId ? messageStore.getSessionState(parentSessionId) : null
      const directory = parentState?.directory || currentDirectory || ''

      if (openSessionInSplit?.(sessionId, directory || undefined)) return
      navigateToSession(sessionId, directory || undefined)
    },
    [sessionId, navigateToSession, openSessionInSplit, currentSessionId, currentDirectory],
  )
}

interface TaskHeaderProps {
  agentType: string
  description: string
  status: string
  expanded: boolean
  onToggle: () => void
  headerRef?: RefCallback<HTMLElement>
  sessionId?: string
  onStop?: (e: React.MouseEvent) => void
}

export const TaskHeader = memo(function TaskHeader({
  agentType,
  description,
  status,
  expanded,
  onToggle,
  headerRef,
  sessionId,
  onStop,
}: TaskHeaderProps) {
  const { t } = useTranslation('message')
  const handleOpenSession = useOpenTaskSession(sessionId)

  const isRunning = status === 'running' || status === 'pending'
  const isError = status === 'error'
  const isCompleted = status === 'completed'

  const agentBadgeTone = isRunning ? 'accent' : isError ? 'danger' : isCompleted ? 'success' : 'neutral'

  return (
    <DisclosureRow
      ref={headerRef}
      expanded={expanded}
      onClick={onToggle}
      // 与 ToolPartView 的工具行用同一套几何（inset={false} + pl-2 pr-0）。
      // 此前用默认 inset（contentRow 的 -mx-1.5 rounded-md），
      // 悬停高亮框的圆角和左右宽度都和上下相邻的工具行对不齐。
      size="lg"
      inset={false}
      className="group/header gap-2.5 pl-2 pr-0"
      truncateLabel={false}
      labelTone={isRunning ? 'active' : isError ? 'error' : 'idle'}
      icon={
        isRunning ? (
          <Spinner size="sm" tone="muted" />
        ) : isCompleted ? (
          <TaskDoneIcon size={13} className="text-success-100" />
        ) : (
          <UsersIcon size={13} className="text-text-500" />
        )
      }
      label={
        <span className="flex items-center gap-2">
          <TaskAgentBadge agentType={agentType} tone={agentBadgeTone} sessionId={sessionId} />
          <span className="min-w-0 truncate text-[length:var(--fs-sm)]">{description}</span>
        </span>
      }
      meta={
        <>
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              aria-label={t('task.stop')}
              className="w-[18px] h-[18px] p-0 flex items-center justify-center text-text-400 hover:text-danger-100 hover:bg-danger-100/10 active:bg-danger-100/20 rounded-sm transition-colors bg-transparent border-none"
              title={t('task.stop')}
            >
              <StopIcon size={10} />
            </button>
          )}
          {sessionId && (
            <button
              type="button"
              onClick={handleOpenSession}
              aria-label={t('task.openSession')}
              className="p-1 text-text-500 hover:text-accent-main-100 transition-all bg-transparent border-none"
              title={t('task.openSession')}
            >
              <ExternalLinkIcon size={12} />
            </button>
          )}
        </>
      }
    />
  )
})

/**
 * 子代理徽标。有子会话时点它直接跳过去，否则就是个静态标签。
 * 被「合并后的 task 行」和独立表头共用，保证同一语义只有一种外观。
 */
export const TaskAgentBadge = memo(function TaskAgentBadge({
  agentType,
  tone,
  sessionId,
}: {
  agentType: string
  tone: 'accent' | 'danger' | 'success' | 'neutral'
  sessionId?: string
}) {
  const { t } = useTranslation('message')
  const openSession = useOpenTaskSession(sessionId)
  // 子代理类型名（general/explore/...）走 i18n 映射；未知 agent 回退原名
  const label = agentType ? t(`agent.${agentType}`, { defaultValue: agentType }) : agentType

  if (!sessionId) return <Chip tone={tone}>{label}</Chip>

  return (
    <button
      type="button"
      onClick={openSession}
      // 整行 hover 已经给底色，内层徽标按钮不再叠加自己的底色，
      // 否则一行里出现两层高亮。只补 cursor 与轻微透明度表达可点。
      // data-compact 关掉移动端 button 的 32px 最小高度：徽标是行内小标签，
      // 被撑高后 chip 会贴在顶部、与同行文字错位。
      data-compact=""
      className="inline-flex items-center cursor-pointer rounded-sm transition-opacity hover:opacity-80"
      title={t('task.openSession')}
    >
      <Chip tone={tone}>{label}</Chip>
    </button>
  )
})

// ============================================
// Sub Session View
// ============================================

interface SubSessionViewProps {
  sessionId: string
  /** 子 session 所属服务器（从父 session 复合 key 解析） */
  serverId?: string
  isParentRunning: boolean
}

const SubSessionView = memo(function SubSessionView({ sessionId, serverId }: SubSessionViewProps) {
  const { t } = useTranslation('message')
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadedRef = useRef(false)
  const isAtBottomRef = useRef(true)
  const subSessionMaxHeight = useResponsiveMaxHeight(0.25, 120, 240)

  // messageStore 以复合 key 存储：子 session 原始 id → 按服务器复合化
  const sessionKey = sessionId.includes('::')
    ? sessionId
    : makeSessionKey(serverId ?? serverStore.getActiveServerId(), sessionId)
  const sessionState = useSessionState(sessionKey)
  const messages = sessionState?.messages ?? EMPTY_MESSAGES
  const isStreaming = sessionState?.isStreaming || false
  const isLoading = sessionState?.loadState === 'loading'

  // 挂载即加载（SubSessionView 只在 task 展开时才渲染，loadedRef 防止重复请求）
  useEffect(() => {
    if (loadedRef.current) return

    const state = messageStore.getSessionState(sessionKey)
    if (state && (state.messages.length > 0 || state.isStreaming)) {
      loadedRef.current = true
      return
    }

    loadedRef.current = true
    messageStore.setLoadState(sessionKey, 'loading')

    getSessionMessages(sessionId, 20, undefined, serverId)
      .then(apiMessages => {
        const currentState = messageStore.getSessionState(sessionKey)
        if (currentState && currentState.messages.length > apiMessages.length) {
          messageStore.setLoadState(sessionKey, 'loaded')
          return
        }
        messageStore.setMessages(sessionKey, apiMessages, {
          directory: '',
          hasMoreHistory: apiMessages.length >= 20,
        })
      })
      .catch(err => {
        sessionErrorHandler('load sub-session', err)
        messageStore.setLoadState(sessionKey, 'error')
      })
  }, [sessionKey, sessionId, serverId])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  // 用户不在底部时不强制滚动
  useEffect(() => {
    if (!isStreaming) return
    const el = scrollRef.current
    if (!el || !isAtBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, isStreaming])

  // 过滤有内容的消息
  const visibleMessages = messages.filter((msg: Message) =>
    msg.content.some((part: Message['content'][0]) => {
      if (part.type === 'text') return isVisibleTextContent(part)
      if (part.type === 'tool') return true
      if (part.type === 'reasoning') return true
      return false
    }),
  )

  if (isLoading && messages.length === 0) {
    return <MessageSkeleton />
  }

  if (visibleMessages.length === 0) {
    return <div className="text-[length:var(--fs-sm)] text-text-500 italic py-2">{t('task.waitingForResponse')}</div>
  }

  return (
    <div className="rounded-md bg-bg-100/50 border border-border-200/30 overflow-hidden">
      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto custom-scrollbar px-3 py-2 space-y-2"
        style={{ maxHeight: subSessionMaxHeight }}
      >
        {visibleMessages.map((msg: Message, idx: number) => (
          <MessageItem key={msg.info.id} message={msg} isLast={idx === visibleMessages.length - 1} />
        ))}
      </div>
    </div>
  )
})

// ============================================
// Message Item
// ============================================

interface MessageItemProps {
  message: Message
  isLast: boolean
}

const MessageItem = memo(function MessageItem({ message, isLast }: MessageItemProps) {
  const { info, content } = message
  const isUser = info.role === 'user'

  const textParts = content.filter((p): p is TextPart => p.type === 'text' && !!p.text?.trim())
  const toolParts = content.filter((p): p is ToolPart => p.type === 'tool')

  const textContent = textParts
    .map(p => p.text)
    .join('\n')
    .trim()

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-2.5 py-1.5 rounded-md bg-bg-300 text-text-100 text-[length:var(--fs-xs)] whitespace-pre-wrap break-words">
          {textContent}
        </div>
      </div>
    )
  }

  // Assistant message
  return (
    <div className="space-y-1.5">
      {/* Text content */}
      {textContent && (
        <div className="text-[length:var(--fs-xs)] text-text-200 leading-relaxed whitespace-pre-wrap">
          {textContent.length > 500 && !isLast ? textContent.slice(0, 500) + '...' : textContent}
        </div>
      )}

      {/* Tool calls - compact summary */}
      {toolParts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {toolParts.map((tool, idx) => (
            <ToolBadge key={idx} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
})

// ============================================
// Tool Badge
// ============================================

const ToolBadge = memo(function ToolBadge({ tool }: { tool: ToolPart }) {
  const { state, tool: toolName } = tool
  const isRunning = state.status === 'running' || state.status === 'pending'
  const isError = state.status === 'error'

  const title = state.title || formatToolName(toolName)
  const displayTitle = title.length > 30 ? title.slice(0, 30) + '...' : title

  return (
    <Chip tone={isRunning ? 'accent' : isError ? 'danger' : 'neutral'} className="font-mono" title={title}>
      {isRunning && <StatusDot tone="running" size="xs" />}
      {displayTitle}
    </Chip>
  )
})

// ============================================
// Message Skeleton
// ============================================

function MessageSkeleton() {
  return (
    <div className="rounded-md bg-bg-100/50 border border-border-200/30 p-3 space-y-2">
      <div className="h-3 bg-bg-300/50 rounded animate-pulse w-3/4" />
      <div className="h-3 bg-bg-300/50 rounded animate-pulse w-1/2" />
      <div className="h-3 bg-bg-300/50 rounded animate-pulse w-2/3" />
    </div>
  )
}

// ============================================
// Icons & Helpers
// ============================================
