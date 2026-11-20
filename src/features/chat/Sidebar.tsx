import { useState, useCallback, useEffect, useRef, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { SidePanel } from './sidebar/SidePanel'
import { ProjectDialog } from './ProjectDialog'
import { useMultiServerStore } from '../../store/multiServerStore'
import { notificationStore } from '../../store/notificationStore'
import { useDirectory } from '../../hooks'
import { isAbsoluteDirectory, isSameDirectory, normalizeToForwardSlash } from '../../utils'
import { canUseNativeDirectoryPicker } from '../../utils/nativeFileIntegration'
import { getDesktopPlatform } from '../../utils/tauri'
import { DESKTOP_TITLEBAR_HEIGHT } from '../../constants/desktopWindow'
import { DesktopNavControls } from '../../components/DesktopNavControls'
import { type ApiSession } from '../../api'
import { useChatViewport } from './chatViewport'

function clampSidebarWidth(width: number, minWidth: number, maxWidth: number) {
  return Math.min(Math.max(width, minWidth), maxWidth)
}

const SIDEBAR_TRANSITION_MS = 300
const SIDEBAR_SWIPE_LOCK_PX = 10
const SIDEBAR_SWIPE_HORIZONTAL_BIAS = 1.25
const SIDEBAR_SWIPE_CLOSE_PX = 80

type SidebarSwipeAxis = 'pending' | 'horizontal' | 'vertical'

interface SidebarProps {
  isOpen: boolean
  selectedSessionId: string | null
  onSelectSession: (session: ApiSession) => void
  onNewSession: (target?: { serverId?: string; directory?: string }) => void
  onOpen: () => void
  onClose: () => void
  contextLimit?: number
  onOpenSettings?: () => void
  projectDialogOpen?: boolean
  onProjectDialogClose?: () => void
  mobileInline?: boolean
}

export const Sidebar = memo(function Sidebar({
  isOpen,
  selectedSessionId,
  onSelectSession,
  onNewSession,
  onOpen,
  onClose,
  contextLimit,
  onOpenSettings,
  projectDialogOpen,
  onProjectDialogClose,
  mobileInline = false,
}: SidebarProps) {
  const { t } = useTranslation(['chat', 'common'])
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false)
  const [projectDialogKey, setProjectDialogKey] = useState(0)
  const { addDirectory, pruneInvalidDirectories, pathInfo, currentDirectory, savedDirectories } = useDirectory()
  // 已在项目里时，从当前项目路径起步，方便加相邻目录；否则回落 home。
  // 只接受绝对路径：URL 里可能是外部链接带来的 `../code/OCC`，不能带进弹窗。
  const projectDialogInitialPath = currentDirectory || pathInfo?.home

  // 历史版本可能把相对路径存进项目列表，后端会拒绝并导致项目「消失」。
  // 路径信息（home）就绪后清理一次；没有合法起点时宁可不动，避免误删。
  const hasInvalidSavedDirectories = savedDirectories.some(
    directory => !isAbsoluteDirectory(normalizeToForwardSlash(directory.path)),
  )
  useEffect(() => {
    if (!hasInvalidSavedDirectories) return
    if (!pathInfo?.home) return
    pruneInvalidDirectories()
  }, [hasInvalidSavedDirectories, pathInfo?.home, pruneInvalidDirectories])

  const { interaction, layout, actions } = useChatViewport()
  const isOverlay = interaction.sidebarBehavior === 'overlay'
  const touchCapable = interaction.touchCapable
  const isProjectDialogVisible = isProjectDialogOpen || !!projectDialogOpen

  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const currentWidthRef = useRef(layout.sidebar.openWidth)
  const rafRef = useRef<number>(0)
  const transitionResizeTimerRef = useRef<number | null>(null)

  // 订阅多服务器焦点：focusedServerId 变化时本组件需重渲染，
  // 下方 ProjectDialog 的 serverId 才能跟着更新
  const { focusedServerId } = useMultiServerStore()
  const handleAddProject = useCallback(
    (path: string) => {
      // 项目列表按服务器分桶（srv:{serverId}:opencode-saved-directories），
      // 这里只写入当前活动主机的桶；切主机后各自看到自己的列表。
      const alreadySaved = savedDirectories.some(d => isSameDirectory(d.path, path))
      const added = addDirectory(path)
      if (!added) {
        notificationStore.toast('error', t('projectDialog.invalidPathTitle'), t('projectDialog.invalidPath'))
        return
      }
      // 已存在时 addDirectory 只切换当前目录、不改列表，界面上几乎没有反馈，
      // 用户会以为「添加没生效」。这里明确提示，而不是静默吞掉。
      if (alreadySaved) {
        notificationStore.toast('completed', t('projectDialog.alreadyInListTitle'), t('projectDialog.alreadyInList'))
      }
      if (!isOverlay) {
        onOpen()
      }
    },
    [addDirectory, isOverlay, onOpen, savedDirectories, t],
  )

  const openProjectDialog = useCallback(async () => {
    // 系统文件夹选择器只能浏览本机磁盘，仅当焦点服务器是本地服务器时使用；
    // 远程服务器必须用内置 ProjectDialog 通过 listDirectory(serverId) 远程浏览，
    // 否则会把本机路径当成远程项目的目录。
    if (canUseNativeDirectoryPicker(focusedServerId)) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({
          directory: true,
          multiple: false,
          title: t('sidebar.addProject', { defaultValue: 'Add project…' }),
        })
        if (typeof selected === 'string' && selected) {
          handleAddProject(selected)
        }
        return
      } catch {
        // 回退到内置 ProjectDialog
      }
    }
    setProjectDialogKey(key => key + 1)
    setIsProjectDialogOpen(true)
  }, [focusedServerId, handleAddProject, t])

  const closeProjectDialog = useCallback(() => {
    setIsProjectDialogOpen(false)
    onProjectDialogClose?.()
  }, [onProjectDialogClose])

  const persistSidebarWidth = useCallback(
    (nextWidth: number) => {
      const finalWidth = clampSidebarWidth(nextWidth, layout.sidebar.hardMinWidth, layout.sidebar.resizeMaxWidth)
      actions.setSidebarRequestedWidth(finalWidth)
      setIsResizing(false)
      return finalWidth
    },
    [actions, layout.sidebar.hardMinWidth, layout.sidebar.resizeMaxWidth],
  )

  const startResizing = useCallback(
    (e: React.MouseEvent) => {
      if (isOverlay) return
      e.preventDefault()

      const sidebar = sidebarRef.current
      if (!sidebar) return

      setIsResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => {
          const newWidth = clampSidebarWidth(
            moveEvent.clientX,
            layout.sidebar.hardMinWidth,
            layout.sidebar.resizeMaxWidth,
          )
          sidebar.style.width = `${newWidth}px`
          currentWidthRef.current = newWidth
        })
      }

      const handleMouseUp = () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        persistSidebarWidth(currentWidthRef.current)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [isOverlay, layout.sidebar.hardMinWidth, layout.sidebar.resizeMaxWidth, persistSidebarWidth],
  )

  const startTouchResizing = useCallback(
    (e: React.TouchEvent) => {
      if (isOverlay || !touchCapable || e.touches.length !== 1) return
      e.preventDefault()

      const sidebar = sidebarRef.current
      if (!sidebar) return

      setIsResizing(true)
      document.body.style.userSelect = 'none'

      const handleTouchMove = (moveEvent: TouchEvent) => {
        if (moveEvent.touches.length !== 1) return
        moveEvent.preventDefault()
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => {
          const newWidth = clampSidebarWidth(
            moveEvent.touches[0].clientX,
            layout.sidebar.hardMinWidth,
            layout.sidebar.resizeMaxWidth,
          )
          sidebar.style.width = `${newWidth}px`
          currentWidthRef.current = newWidth
        })
      }

      const handleTouchEnd = () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        document.body.style.userSelect = ''
        document.removeEventListener('touchmove', handleTouchMove)
        document.removeEventListener('touchend', handleTouchEnd)
        document.removeEventListener('touchcancel', handleTouchEnd)
        persistSidebarWidth(currentWidthRef.current)
      }

      document.addEventListener('touchmove', handleTouchMove, { passive: false })
      document.addEventListener('touchend', handleTouchEnd)
      document.addEventListener('touchcancel', handleTouchEnd)
    },
    [isOverlay, layout.sidebar.hardMinWidth, layout.sidebar.resizeMaxWidth, persistSidebarWidth, touchCapable],
  )

  useEffect(() => {
    currentWidthRef.current = layout.sidebar.openWidth
  }, [layout.sidebar.openWidth])

  const handleBackdropClick = useCallback(() => {
    if (isOverlay && isOpen) {
      onClose()
    }
  }, [isOverlay, isOpen, onClose])

  const handleToggle = useCallback(() => {
    if (!isOverlay) {
      if (transitionResizeTimerRef.current !== null) window.clearTimeout(transitionResizeTimerRef.current)
      window.dispatchEvent(new CustomEvent('panel-resize-start'))
      transitionResizeTimerRef.current = window.setTimeout(() => {
        transitionResizeTimerRef.current = null
        window.dispatchEvent(new CustomEvent('panel-resize-end'))
      }, SIDEBAR_TRANSITION_MS + 50)
    }

    if (isOpen) {
      onClose()
    } else {
      onOpen()
    }
  }, [isOverlay, isOpen, onClose, onOpen])

  useEffect(() => {
    return () => {
      if (transitionResizeTimerRef.current !== null) {
        window.clearTimeout(transitionResizeTimerRef.current)
        window.dispatchEvent(new CustomEvent('panel-resize-end'))
      }
    }
  }, [])

  const handleSelectSession = useCallback(
    (session: ApiSession) => {
      onSelectSession(session)
      if (isOverlay) {
        onClose()
      }
    },
    [onClose, onSelectSession, isOverlay],
  )

  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const touchDeltaX = useRef(0)
  const touchSwipeAxis = useRef<SidebarSwipeAxis>('pending')
  const [swipeX, setSwipeX] = useState(0)
  const isSwiping = useRef(false)
  const [isSwipingActive, setIsSwipingActive] = useState(false)

  const handleSidebarTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    touchDeltaX.current = 0
    touchSwipeAxis.current = 'pending'
    isSwiping.current = false
    setIsSwipingActive(false)
  }, [])

  const handleSidebarTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return

    const deltaX = e.touches[0].clientX - touchStartX.current
    const deltaY = e.touches[0].clientY - touchStartY.current
    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)

    if (touchSwipeAxis.current === 'pending') {
      if (Math.max(absX, absY) < SIDEBAR_SWIPE_LOCK_PX) return

      touchSwipeAxis.current = absX > absY * SIDEBAR_SWIPE_HORIZONTAL_BIAS ? 'horizontal' : 'vertical'
      if (touchSwipeAxis.current === 'vertical') {
        isSwiping.current = false
        setIsSwipingActive(false)
        touchDeltaX.current = 0
        setSwipeX(0)
        return
      }
    }

    if (touchSwipeAxis.current !== 'horizontal') return

    e.preventDefault()
    isSwiping.current = true
    setIsSwipingActive(true)
    const nextDeltaX = Math.min(0, deltaX)
    touchDeltaX.current = nextDeltaX
    setSwipeX(nextDeltaX)
  }, [])

  const handleSidebarTouchEnd = useCallback(() => {
    if (touchSwipeAxis.current === 'horizontal' && isSwiping.current && touchDeltaX.current < -SIDEBAR_SWIPE_CLOSE_PX) {
      onClose()
    }
    touchSwipeAxis.current = 'pending'
    isSwiping.current = false
    setIsSwipingActive(false)
    touchDeltaX.current = 0
    setSwipeX(0)
  }, [onClose])

  if (isOverlay) {
    if (mobileInline) {
      return (
        <>
          <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg-100 [contain:strict]">
            <SidePanel
              onNewSession={onNewSession}
              onSelectSession={handleSelectSession}
              onCloseMobile={onClose}
              selectedSessionId={selectedSessionId}
              onAddProject={openProjectDialog}
              isMobile={true}
              isExpanded={true}
              onToggleSidebar={onClose}
              contextLimit={contextLimit}
              onOpenSettings={onOpenSettings}
            />
          </div>

          <ProjectDialog
            key={`mobile-${projectDialogKey}-${Number(isProjectDialogVisible)}`}
            isOpen={isProjectDialogVisible}
            onClose={closeProjectDialog}
            onSelect={handleAddProject}
            initialPath={projectDialogInitialPath}
            serverId={focusedServerId ?? undefined}
          />
        </>
      )
    }

    return (
      <>
        <div
          className={`
            fixed left-0 right-0 bg-[hsl(var(--always-black)/0.4)] z-30
            transition-opacity duration-300
            ${isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
          `}
          style={{
            top: 'calc(var(--overlay-safe-top, 0px) + var(--desktop-titlebar-height, 0px))',
            height: 'calc(100% - var(--overlay-safe-top, 0px) - var(--desktop-titlebar-height, 0px))',
          }}
          onClick={handleBackdropClick}
        />

        <div
          onTouchStart={handleSidebarTouchStart}
          onTouchMove={handleSidebarTouchMove}
          onTouchEnd={handleSidebarTouchEnd}
          onTouchCancel={handleSidebarTouchEnd}
          className={`
            fixed left-0 z-40
            flex flex-col bg-bg-100 shadow-lg
            ${isSwipingActive ? '' : 'transition-transform duration-300 ease-out'}
            ${isOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
          style={{
            width: `${layout.sidebar.overlayWidth}px`,
            transform: isOpen ? `translateX(${Math.min(0, swipeX)}px)` : 'translateX(-100%)',
            top: 'calc(var(--overlay-safe-top, 0px) + var(--desktop-titlebar-height, 0px))',
            height: 'calc(100% - var(--overlay-safe-top, 0px) - var(--desktop-titlebar-height, 0px))',
          }}
        >
          <SidePanel
            onNewSession={onNewSession}
            onSelectSession={handleSelectSession}
            onCloseMobile={onClose}
            selectedSessionId={selectedSessionId}
            onAddProject={openProjectDialog}
            isMobile={true}
            isExpanded={true}
            onToggleSidebar={onClose}
            contextLimit={contextLimit}
            onOpenSettings={onOpenSettings}
          />
        </div>

        <ProjectDialog
          key={`mobile-${projectDialogKey}-${Number(isProjectDialogVisible)}`}
          isOpen={isProjectDialogVisible}
          onClose={closeProjectDialog}
          onSelect={handleAddProject}
          initialPath={projectDialogInitialPath}
          serverId={focusedServerId ?? undefined}
        />
      </>
    )
  }

  return (
    <>
      <div
        ref={sidebarRef}
        style={{ width: `${layout.sidebar.dockedWidth}px` }}
        className={`
          relative flex flex-col h-full bg-bg-100 overflow-hidden shrink-0 min-w-0
          border-r border-border-200/50
          ${isResizing ? 'transition-none' : 'transition-[width] duration-300 ease-out'}
        `}
      >
        {/* Windows 桌面：侧边栏顶部工具栏 —— 承载侧栏开关 + 导航控件，与下方内容用分隔线分开。
            开关图标与下方各项图标（mx-2 + paddingLeft:6，图标中心 24px）水平对齐；
            展开/收起时位置固定，其余导航按钮仅在展开时依次排列（gap-1）。
            左右各留 pl-2 / pr-2：拉到最小宽度时按钮行与左右边界、竖线都留出间距。 */}
        {getDesktopPlatform() === 'windows' && (
          <div
            className="flex items-center shrink-0 border-b border-border-200/50 pl-2 pr-2 gap-1"
            style={{ height: DESKTOP_TITLEBAR_HEIGHT }}
          >
            <DesktopNavControls sidebarOpen={isOpen} onToggleSidebar={handleToggle} showExtra={isOpen} />
          </div>
        )}

        {/* 网页端顶栏与桌面端共用同一排导航控件（DesktopNavControls）：
            两端若各写一套按钮，尺寸/间距/hover 必然逐渐分叉。桌面端 Windows
            用全高侧栏，控件放在上面那条独立工具栏里（见上方分支）。 */}
        <SidePanel
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onCloseMobile={onClose}
          selectedSessionId={selectedSessionId}
          onAddProject={openProjectDialog}
          isMobile={false}
          isExpanded={isOpen}
          onToggleSidebar={handleToggle}
          contextLimit={contextLimit}
          onOpenSettings={onOpenSettings}
          hideHeader={getDesktopPlatform() === 'windows'}
          headerContent={<DesktopNavControls sidebarOpen={isOpen} onToggleSidebar={handleToggle} showExtra={isOpen} />}
        />

        {isOpen && (
          <div
            className={`
              absolute top-0 right-0 h-full cursor-col-resize z-50 touch-none bg-transparent
              ${touchCapable ? 'w-4' : 'w-1'}
            `}
            onMouseDown={startResizing}
            onTouchStart={startTouchResizing}
          >
            <div
              aria-hidden="true"
              className={`absolute top-0 bottom-0 right-0 transition-colors ${touchCapable ? 'w-1 rounded-full' : 'w-full'} ${
                isResizing ? 'bg-accent-main-100' : 'bg-transparent hover:bg-accent-main-100/50'
              }`}
            />
          </div>
        )}
      </div>

      <ProjectDialog
        key={`desktop-${projectDialogKey}-${Number(isProjectDialogVisible)}`}
        isOpen={isProjectDialogVisible}
        onClose={closeProjectDialog}
        onSelect={handleAddProject}
        initialPath={projectDialogInitialPath}
        serverId={focusedServerId ?? undefined}
      />
    </>
  )
})
