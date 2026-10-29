import { useState, useRef, useEffect, useLayoutEffect, Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PanelRightIcon,
  PanelBottomIcon,
  SidebarIcon,
  SplitHorizontalIcon,
  MaximizeIcon,
  MinimizeIcon,
  ShareIcon,
  PlugIcon,
  SpinnerIcon,
  LayersIcon,
} from '../../components/Icons'
import { Dialog, IconButton } from '../../components/ui'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'
import { ShareDialog } from './ShareDialog'
import { OpenDirectoryButton } from './OpenDirectoryButton'
import { messageStore, useHeaderSessionMeta, usePaneLayout, usePaneController } from '../../store'
import { useLayoutStore, layoutStore } from '../../store/layoutStore'
import { useWorkStatusPanelVisible } from '../workStatus/workStatusVisibilityStore'
import { ContextUsageRing } from './ContextUsageRing'
import { ContextDetailsDialog } from './sidebar/ContextDetailsDialog'
import { serverStore } from '../../store/serverStore'
import { workStatusStore, useWorkStatus } from '../../store/workStatusStore'
import { useSessionContext } from '../../contexts/useSessionContext'
import { updateSession } from '../../api'
import { useDirectory } from '../../contexts/useDirectory'
import { uiErrorHandler } from '../../utils'
import { sessionKeyToServerId } from '../../utils/sessionKey'
import { useChatViewport } from './chatViewport'
import { isTauri, isTauriMobile } from '../../utils/tauri'

interface HeaderProps {
  onOpenSidebar?: () => void
  onToggleRightPanel?: () => void
  onSplitPane?: () => void
  isPaneFullscreen?: boolean
  onTogglePaneFullscreen?: () => void
  /** 桌面端标题栏内嵌模式：不占独立行高，去掉背景/边框，嵌入 DesktopTitlebar */
  embedded?: boolean
}

/** MCP 面板较重（拉状态 + resources）：仅在打开弹窗时才加载 */
const McpPanel = lazy(() => import('../../components/McpPanel').then(module => ({ default: module.McpPanel })))

interface SessionTitleControlProps {
  compact: boolean
  isEditingTitle: boolean
  editTitle: string
  sessionTitle: string
  titleInputRef: React.RefObject<HTMLInputElement | null>
  setEditTitle: (value: string) => void
  setIsEditingTitle: (value: boolean) => void
  handleRename: () => void
  handleStartEdit: () => void
  clickToRenameTitle: string
}

function SessionTitleControl({
  compact,
  isEditingTitle,
  editTitle,
  sessionTitle,
  titleInputRef,
  setEditTitle,
  setIsEditingTitle,
  handleRename,
  handleStartEdit,
  clickToRenameTitle,
}: SessionTitleControlProps) {
  // 编辑态宽度贴合文字：<input> 不会随 value 自动伸缩，用隐藏镜像 span 量测
  // 同字体的文字宽度，再作为 input 的宽度。纯 CSS 的 ch 单位在中文/中英混排下
  // 偏差明显，镜像法不依赖字体度量假设。
  const measureRef = useRef<HTMLSpanElement>(null)
  const [inputWidth, setInputWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!isEditingTitle) return
    const node = measureRef.current
    if (!node) return
    // 量测的是「当前输入值」而非原始标题，这样删除/新增字符时宽度实时跟随。
    setInputWidth(node.getBoundingClientRect().width)
  }, [isEditingTitle, editTitle, compact])

  const inputClass = cn(
    'py-1.5 text-[length:var(--fs-base)] font-medium text-text-100 bg-transparent border-none outline-none h-full',
    compact ? 'px-2' : 'px-3',
  )
  const buttonClass = cn(
    'py-1.5 text-[length:var(--fs-base)] font-medium text-text-200 transition-colors truncate max-w-full text-left cursor-text select-none',
    compact ? 'px-2' : 'px-3',
  )

  return (
    <div
      className={cn(
        'relative flex items-center rounded-lg transition-all duration-200 p-0.5 min-w-0 max-w-full',
        // w-fit：宽度贴合标题内容（短标题不占满整行，避免大片空白热区）。
        // 编辑态同样不撑满，由量测出的 inputWidth 决定。
        'w-fit',
        // hover 只用底色，不用 border：border 占盒模型空间，悬停加边框会撑大 1~2px 推动相邻元素。
        isEditingTitle
          ? 'bg-bg-200 ring-1 ring-accent-main-100'
          : cn('bg-transparent', interactive.subtle),
      )}
    >
      {isEditingTitle ? (
        <>
          <input
            ref={titleInputRef}
            type="text"
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setIsEditingTitle(false)
            }}
            className={inputClass}
            style={inputWidth === null ? undefined : { width: `${Math.ceil(inputWidth)}px` }}
          />
          {/* 量测镜像：与 input 同字体同内边距，内容为当前输入值。
              absolute + invisible 使其不参与布局、不可见，但仍可被量测。 */}
          <span
            ref={measureRef}
            aria-hidden
            className={cn(inputClass, 'pointer-events-none invisible absolute whitespace-pre w-auto')}
          >
            {editTitle || ' '}
          </span>
        </>
      ) : (
          <button type="button" onClick={handleStartEdit} className={buttonClass} title={clickToRenameTitle}>
            {sessionTitle}
          </button>
      )}
    </div>
  )
}

export function Header({
  onOpenSidebar,
  onToggleRightPanel,
  onSplitPane,
  isPaneFullscreen = false,
  onTogglePaneFullscreen,
  embedded = false,
}: HeaderProps) {
  const { t } = useTranslation('chat')
  const { sessionId, sessionDirectory, sessionTitle: currentSessionTitle } = useHeaderSessionMeta()
  const { rightPanelOpen, bottomPanelOpen } = useLayoutStore()
  const workStatus = useWorkStatus()
  const { refresh } = useSessionContext()
  const { currentDirectory } = useDirectory()
  const { presentation, interaction } = useChatViewport()

  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [contextDialogOpen, setContextDialogOpen] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // 顶栏上下文圆环：仅单视图（聚焦 pane）渲染。桌面端工作状态面板可见时隐藏
  // （面板内已有上下文信息）；移动端面板永不占位，圆环始终显示。
  const paneLayout = usePaneLayout()
  const focusedController = usePaneController(paneLayout.focusedPaneId)
  const workStatusPanelVisible = useWorkStatusPanelVisible(paneLayout.focusedPaneId)
  const showContextRing = !!sessionId && !workStatusPanelVisible
  /**
   * 圆环用的窗口大小：**不兜底**。拿不到模型声明时传 0，圆环会显示「窗口未知」
   * 而不是按一个猜来的 200000 算百分比（实测真实值可能差 5 倍）。
   */
  const contextRingLimit = focusedController?.contextLimit ?? 0

  const sessionTitle = currentSessionTitle || t('header.newChat')
  const isCompact = presentation.isCompact
  // 移动端：顶栏只保留会话标题与面板开关，
  // 隐藏分享、MCP、工作状态三个按钮，避免窄屏顶栏过于拥挤。
  const isMobileLayout = isTauriMobile()

  useEffect(() => {
    document.title = currentSessionTitle ? `${currentSessionTitle} - OCC` : 'OCC'
    return () => {
      document.title = 'OCC'
    }
  }, [currentSessionTitle])

  useEffect(() => {
    setIsEditingTitle(false)
  }, [sessionId])

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [isEditingTitle])

  const handleStartEdit = () => {
    if (!sessionId) return
    setEditTitle(sessionTitle)
    setIsEditingTitle(true)
  }

  const handleRename = async () => {
    if (!sessionId || !editTitle.trim() || editTitle === sessionTitle) {
      setIsEditingTitle(false)
      return
    }
    try {
      const updated = await updateSession(sessionId, { title: editTitle.trim() }, sessionDirectory || currentDirectory)
      messageStore.updateSessionMetadata(sessionId, { title: updated.title })
      refresh()
    } catch (e) {
      uiErrorHandler('rename session', e)
    } finally {
      setIsEditingTitle(false)
    }
  }

  const targetDirectory = sessionDirectory || currentDirectory
  const canOpenDirectory = isTauri() && !isTauriMobile() && !!targetDirectory
  // 系统文件管理器只能打开本机磁盘。远程服务器（经网关访问）的目录通常在本机
  // 不存在；但 AI Agent 实例可能就跑在本机，此时该路径确实存在，仍应直接用本机
  // 程序打开。OpenDirectoryButton 内部用 canOpenDirectoryNatively 判定，本机不
  // 存在的远程路径退回应用内右侧面板的文件树（走 listDirectory(serverId) 远程读取）。
  const targetServerId = sessionId ? sessionKeyToServerId(sessionId) : serverStore.getActiveServerId()

  const titleControl = (
    <SessionTitleControl
      compact={isCompact || embedded}
      isEditingTitle={isEditingTitle}
      editTitle={editTitle}
      sessionTitle={sessionTitle}
      titleInputRef={titleInputRef}
      setEditTitle={setEditTitle}
      setIsEditingTitle={setIsEditingTitle}
      handleRename={handleRename}
      handleStartEdit={handleStartEdit}
      clickToRenameTitle={t('header.clickToRename')}
    />
  )

  // 桌面端标题栏内嵌：不占独立行高，去掉背景/边框，与 DesktopTitlebar 同排。
  // data-chat-header-shadow 锚点由 ChatPane 在 pane 内保留占位（斜杠/提及菜单按 pane root 查找）。
  if (embedded) {
    return (
      <div className="flex h-full w-full items-center min-w-0">
        {/* 会话标题在顶部左侧；标题与右侧按钮之间为拖拽区。
            空间分配：标题组按内容宽度自适应（max-w 限制不超过可用空间），
            拖拽区 flex-1 占满剩余 —— 拖拽区必须尽可能大，否则窗口无法拖动。
            注意：标题容器不能用 flex-1 撑满，那会吃掉拖拽区（曾导致拖拽失效）。 */}
        <div className="flex items-center gap-2 min-w-0 max-w-full z-20">
          {interaction.sidebarBehavior === 'overlay' && onOpenSidebar && (
            <IconButton
              aria-label={t('header.openSidebar')}
              onClick={onOpenSidebar}
              className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
            >
              <SidebarIcon size={16} />
            </IconButton>
          )}
        {/* min-w-0 允许收缩；宽度贴合标题内容，不撑满容器。 */}
        <div className="min-w-0 shrink">{titleControl}</div>
        </div>

        <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

        <div className="flex items-center gap-1 pointer-events-auto shrink-0 z-20">
            {showContextRing && (
              <ContextUsageRing
                contextLimit={contextRingLimit}
                onOpenDetails={() => setContextDialogOpen(true)}
              />
            )}

            {canOpenDirectory && (
              <OpenDirectoryButton
                directory={targetDirectory}
                serverId={targetServerId}
                onOpenInApp={() => layoutStore.openRightPanel('files')}
              />
            )}

            {onTogglePaneFullscreen && (
              <IconButton
                aria-label={isPaneFullscreen ? t('header.exitFullscreenPane') : t('header.enterFullscreenPane')}
                onClick={onTogglePaneFullscreen}
                className={cn(
                  isPaneFullscreen ? interactive.toggleActive : 'text-text-300 hover:text-text-100 border border-transparent',
                  interactive.subtle,
                )}
              >
                {isPaneFullscreen ? <MinimizeIcon size={16} /> : <MaximizeIcon size={16} />}
              </IconButton>
            )}

            {onSplitPane && (
              <IconButton
                aria-label={t('header.splitPane')}
                onClick={onSplitPane}
                className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
              >
                <SplitHorizontalIcon size={16} />
              </IconButton>
            )}

            <IconButton
              aria-label={bottomPanelOpen ? t('header.closeBottomPanel') : t('header.openBottomPanel')}
              onClick={() => layoutStore.toggleBottomPanel()}
              className={cn(
                bottomPanelOpen ? interactive.toggleActive : 'text-text-300 hover:text-text-100 border border-transparent',
                interactive.subtle,
              )}
            >
              <PanelBottomIcon size={16} />
            </IconButton>

            <IconButton
              aria-label={rightPanelOpen ? t('header.closePanel') : t('header.openPanel')}
              onClick={onToggleRightPanel ?? (() => layoutStore.toggleRightPanel())}
              className={cn(
                rightPanelOpen ? interactive.toggleActive : 'text-text-300 hover:text-text-100 border border-transparent',
                interactive.subtle,
              )}
            >
              <PanelRightIcon size={16} />
            </IconButton>

            <IconButton
              aria-label={t('workStatus.railToggle')}
              title={t('workStatus.railToggle')}
              aria-pressed={workStatus.enabled}
              onClick={() => workStatusStore.toggleEnabled()}
              className={cn(
                workStatus.enabled ? interactive.toggleActive : 'text-text-300 hover:text-text-100 border border-transparent',
                interactive.subtle,
              )}
            >
              <LayersIcon size={16} />
            </IconButton>

            <IconButton
              aria-label={t('header.mcpStatus')}
              title={t('header.mcpStatus')}
              onClick={() => setMcpDialogOpen(true)}
              className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
            >
              <PlugIcon size={16} />
            </IconButton>

            {sessionId && (
              <IconButton
                aria-label={t('header.shareSession')}
                title={t('header.shareSession')}
                onClick={() => setShareDialogOpen(true)}
                className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
              >
                <ShareIcon size={16} />
              </IconButton>
            )}
        </div>

        <ShareDialog isOpen={shareDialogOpen} onClose={() => setShareDialogOpen(false)} />

        <ContextDetailsDialog
          isOpen={contextDialogOpen}
          onClose={() => setContextDialogOpen(false)}
          contextLimit={contextRingLimit}
        />

        <Dialog
          isOpen={mcpDialogOpen}
          onClose={() => setMcpDialogOpen(false)}
          title={t('header.mcpStatus')}
          width="min(560px, calc(100vw - 24px))"
          className="max-h-[70vh]!"
          rawContent
        >
          {mcpDialogOpen && (
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-12 text-text-400">
                  <SpinnerIcon size={16} className="animate-spin" />
                </div>
              }
            >
              <McpPanel onClose={() => setMcpDialogOpen(false)} />
            </Suspense>
          )}
        </Dialog>
      </div>
    )
  }

  return (
    <div
      className={`chat-topbar flex justify-between items-center z-20 bg-bg-100 transition-colors duration-200 relative border-b border-border-200/60 ${isCompact ? 'px-2' : 'px-4'}`}
    >
        <div className="flex min-w-0 flex-1 items-center gap-2 z-20">
        {interaction.sidebarBehavior === 'overlay' && onOpenSidebar && (
          <IconButton
            aria-label={t('header.openSidebar')}
            onClick={onOpenSidebar}
            className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
          >
            <SidebarIcon size={16} />
          </IconButton>
        )}

          <div className="min-w-0 flex-1 max-w-[min(720px,72%)]">{titleControl}</div>
      </div>

      <div className="flex items-center gap-1 pointer-events-auto shrink-0 z-20">
        <div className="flex items-center gap-0.5">
          {showContextRing && (
            <ContextUsageRing
              contextLimit={contextRingLimit}
              onOpenDetails={() => setContextDialogOpen(true)}
            />
          )}

          {canOpenDirectory && (
            <OpenDirectoryButton
              directory={targetDirectory}
              serverId={targetServerId}
              onOpenInApp={() => layoutStore.openRightPanel('files')}
            />
          )}

          {onTogglePaneFullscreen && (
            <IconButton
              aria-label={isPaneFullscreen ? t('header.exitFullscreenPane') : t('header.enterFullscreenPane')}
              onClick={onTogglePaneFullscreen}
              className={cn(
                isPaneFullscreen ? interactive.toggleActive : 'text-text-300 hover:text-text-100 border border-transparent',
                interactive.subtle,
              )}
            >
              {isPaneFullscreen ? <MinimizeIcon size={16} /> : <MaximizeIcon size={16} />}
            </IconButton>
          )}

          {onSplitPane && (
            <IconButton
              aria-label={t('header.splitPane')}
              onClick={onSplitPane}
              className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
            >
              <SplitHorizontalIcon size={16} />
            </IconButton>
          )}

          <IconButton
            aria-label={bottomPanelOpen ? t('header.closeBottomPanel') : t('header.openBottomPanel')}
            onClick={() => layoutStore.toggleBottomPanel()}
            className={cn(
              bottomPanelOpen ? interactive.toggleActive : 'text-text-300 hover:text-text-100 border border-transparent',
              interactive.subtle,
            )}
          >
            <PanelBottomIcon size={16} />
          </IconButton>

          <IconButton
            aria-label={rightPanelOpen ? t('header.closePanel') : t('header.openPanel')}
            onClick={onToggleRightPanel ?? (() => layoutStore.toggleRightPanel())}
            className={cn(
              rightPanelOpen ? interactive.toggleActive : 'text-text-300 hover:text-text-100 border border-transparent',
              interactive.subtle,
            )}
          >
            <PanelRightIcon size={16} />
          </IconButton>

          {!isMobileLayout && (
            <IconButton
              aria-label={t('workStatus.railToggle')}
              title={t('workStatus.railToggle')}
              aria-pressed={workStatus.enabled}
              onClick={() => workStatusStore.toggleEnabled()}
              className={cn(
                workStatus.enabled ? interactive.toggleActive : 'text-text-300 hover:text-text-100 border border-transparent',
                interactive.subtle,
              )}
            >
              <LayersIcon size={16} />
            </IconButton>
          )}

          {/* MCP 连接状态与开关：弹窗内嵌 McpPanel（懒加载）。移动端隐藏。 */}
          {!isMobileLayout && (
            <IconButton
              aria-label={t('header.mcpStatus')}
              title={t('header.mcpStatus')}
              onClick={() => setMcpDialogOpen(true)}
              className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
            >
              <PlugIcon size={16} />
            </IconButton>
          )}

          {/* 分享会话：与标题分离，作为常规操作按钮（仅有会话时显示）。移动端隐藏。 */}
          {sessionId && !isMobileLayout && (
            <IconButton
              aria-label={t('header.shareSession')}
              title={t('header.shareSession')}
              onClick={() => setShareDialogOpen(true)}
              className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
            >
              <ShareIcon size={16} />
            </IconButton>
          )}
        </div>
      </div>

      <ShareDialog isOpen={shareDialogOpen} onClose={() => setShareDialogOpen(false)} />

      <ContextDetailsDialog
        isOpen={contextDialogOpen}
        onClose={() => setContextDialogOpen(false)}
        contextLimit={contextRingLimit}
      />

      {/* MCP 服务器状态与开关。
          高度：McpPanel 根节点是 h-full，弹窗必须给出确定高度，否则内部列表的 overflow-auto 不生效；
          这里让它按内容自适应、上限 70vh（Dialog 的 inline max-height:100% 需用 important 覆盖）。 */}
      <Dialog
        isOpen={mcpDialogOpen}
        onClose={() => setMcpDialogOpen(false)}
        title={t('header.mcpStatus')}
        width="min(560px, calc(100vw - 24px))"
        className="max-h-[70vh]!"
        rawContent
      >
        {mcpDialogOpen && (
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-12 text-text-400">
                <SpinnerIcon size={16} className="animate-spin" />
              </div>
            }
          >
            <McpPanel onClose={() => setMcpDialogOpen(false)} />
          </Suspense>
        )}
      </Dialog>

      {/* 测量锚点，不是装饰：斜杠菜单 / @ 提及菜单用它的底边作为弹出层
          不可越过的上边界（见 SlashCommandMenu / MentionMenu）。
          底边由 Header 自身的 border-b 表达，这里保持透明、只负责留出缓冲高度。 */}
      <div data-chat-header-shadow className="absolute top-full left-0 right-0 h-8 pointer-events-none" />
    </div>
  )
}
