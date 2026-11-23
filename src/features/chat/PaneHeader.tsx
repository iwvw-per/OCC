/**
 * PaneHeader — Compact header bar for each split pane.
 *
 * Shows: session title (editable) | split H | split V | close
 * Supports drag-to-swap via native drag & drop between pane headers.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { NativeTooltip } from '../../components/ui/Tooltip'
import {
  CloseIcon,
  SplitHorizontalIcon,
  SplitVerticalIcon,
  PanelBottomIcon,
  PanelRightIcon,
  SidebarIcon,
  MaximizeIcon,
  MinimizeIcon,
} from '../../components/Icons'
import { IconButton } from '../../components/ui'
import { cn } from '../../utils/cn'
import { interactive } from '../../utils/interaction'
import { paneLayoutStore } from '../../store/paneLayoutStore'
import { useSessionState } from '../../store'
import { layoutStore, useLayoutSelector } from '../../store/layoutStore'
import { messageStore } from '../../store'
import { updateSession } from '../../api'
import { useDirectory } from '../../contexts/useDirectory'
import { uiErrorHandler } from '../../utils'
import { useChatViewport, canUseSplitPane } from './chatViewport'
import {
  getInternalDragSnapshot,
  isPointInsideElement,
  startInternalDrag,
  subscribeInternalDrag,
  subscribeInternalDrop,
} from '../../lib/internalDragCore'

interface PaneHeaderProps {
  paneId: string
  sessionId: string | null
  isFocused: boolean
  paneCount: number
  canSplitPane?: boolean
  isPaneFullscreen?: boolean
  showSidebarButton?: boolean
  onOpenSidebar?: () => void
  onToggleRightPanel?: () => void
  onTogglePaneFullscreen?: () => void
  /** 网页/Linux 桌面端：pane 顶栏顶在最上方，需与侧栏 logo 区（h-11）等高对齐。
   *  Windows/macOS 桌面（顶栏在标题栏之下）与移动端（另有 3.5rem 顶部栏）不适用。 */
  alignHeaderWithSidebar?: boolean
  onFocus: () => void
}

export function PaneHeader({
  paneId,
  sessionId,
  isFocused,
  paneCount,
  canSplitPane,
  isPaneFullscreen = false,
  showSidebarButton = false,
  onOpenSidebar,
  onToggleRightPanel,
  onTogglePaneFullscreen,
  alignHeaderWithSidebar = false,
  onFocus,
}: PaneHeaderProps) {
  const { t } = useTranslation('chat')
  const viewport = useChatViewport()
  const sessionState = useSessionState(sessionId)
  const { currentDirectory } = useDirectory()
  const rightPanelOpen = useLayoutSelector(s => s.rightPanelOpen)
  const bottomPanelOpen = useLayoutSelector(s => s.bottomPanelOpen)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)

  // Drag state for swap
  const [isDragOver, setIsDragOver] = useState(false)

  const title = sessionState?.title || t('header.newChat')
  const splitEnabled = canSplitPane ?? canUseSplitPane(viewport)

  // Reset editing when session changes
  useEffect(() => {
    setIsEditing(false)
  }, [sessionId])

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleStartEdit = useCallback(() => {
    if (!sessionId) return
    setEditValue(title)
    setIsEditing(true)
  }, [sessionId, title])

  const handleRename = useCallback(async () => {
    if (!sessionId || !editValue.trim() || editValue === title) {
      setIsEditing(false)
      return
    }
    try {
      const dir = sessionState?.directory || currentDirectory
      const updated = await updateSession(sessionId, { title: editValue.trim() }, dir)
      messageStore.updateSessionMetadata(sessionId, { title: updated.title })
    } catch (e) {
      uiErrorHandler('rename session', e)
    } finally {
      setIsEditing(false)
    }
  }, [sessionId, editValue, title, sessionState?.directory, currentDirectory])

  // ---- Split actions ----
  const handleSplitH = useCallback(() => {
    paneLayoutStore.splitPane(paneId, 'horizontal')
  }, [paneId])

  const handleSplitV = useCallback(() => {
    paneLayoutStore.splitPane(paneId, 'vertical')
  }, [paneId])

  const handleClose = useCallback(() => {
    paneLayoutStore.closePane(paneId)
  }, [paneId])

  // ---- Drag & Drop (swap panes) ----
  const handlePointerDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      if (target.closest('button, input')) return
      startInternalDrag(e, { kind: 'pane', paneId })
    },
    [paneId],
  )

  useEffect(() => {
    return subscribeInternalDrag(() => {
      const active = getInternalDragSnapshot().active
      setIsDragOver(
        Boolean(
          active?.payload.kind === 'pane' &&
          active.payload.paneId !== paneId &&
          isPointInsideElement(active.current, headerRef.current),
        ),
      )
    })
  }, [paneId])

  useEffect(() => {
    return subscribeInternalDrop(event => {
      if (event.payload.kind !== 'pane') return
      setIsDragOver(false)
      if (event.payload.paneId !== paneId && isPointInsideElement(event.point, headerRef.current)) {
        paneLayoutStore.swapPanes(event.payload.paneId, paneId)
      }
    })
  }, [paneId])

  return (
    <div
      ref={headerRef}
      className={`relative ${alignHeaderWithSidebar ? 'pane-header' : 'mobile-safe-topbar-10'} flex items-center justify-between px-2 select-none transition-colors duration-200 shrink-0 z-20 border-b border-border-200/50 ${
        isDragOver ? 'bg-accent-main-100/10' : 'bg-bg-100'
      }`}
      onClick={onFocus}
      onPointerDown={handlePointerDragStart}
    >
      {/* Left: Title */}
      <div className="flex items-center min-w-0 flex-1">
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setIsEditing(false)
            }}
            className="px-1.5 py-0.5 text-ui-caption font-medium text-text-100 bg-transparent border-none outline-none w-[140px]"
          />
        ) : (
          <NativeTooltip>
            <button
              onClick={handleStartEdit}
              className="px-1.5 py-0.5 text-ui-caption font-medium text-text-200 hover:bg-bg-200 hover:border-border-200 border border-transparent rounded transition-colors truncate max-w-[200px] cursor-text select-none"
              title={t('header.clickToRename')}
            >
              {title}
            </button>
          </NativeTooltip>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <div className="flex items-center gap-0.5 shrink-0">
          {paneCount > 1 && (
            <IconButton
              size="sm"
              aria-label={t('header.closePane')}
              onClick={e => {
                e.stopPropagation()
                handleClose()
              }}
              className={cn('text-text-300 hover:text-danger-100', interactive.danger)}
            >
              <CloseIcon size={14} />
            </IconButton>
          )}

          {/* 全屏按钮属于本 pane 自身，不随焦点隐藏：子代理分屏打开时焦点仍留在
              原 pane（见 ChatPane.openSessionInSplit），若按焦点隐藏会导致新 pane
              的顶部按钮全部消失。 */}
          {onTogglePaneFullscreen && (
            <IconButton
              size="sm"
              aria-label={isPaneFullscreen ? t('header.exitFullscreenPane') : t('header.enterFullscreenPane')}
              onClick={e => {
                e.stopPropagation()
                onTogglePaneFullscreen()
              }}
              className={cn(
                isPaneFullscreen
                  ? interactive.toggleActive
                  : 'text-text-300 hover:text-text-100 border border-transparent',
                interactive.subtle,
              )}
            >
              {isPaneFullscreen ? <MinimizeIcon size={14} /> : <MaximizeIcon size={14} />}
            </IconButton>
          )}

          {splitEnabled && (
            <>
              <IconButton
                size="sm"
                aria-label={t('header.splitHorizontal')}
                onClick={e => {
                  e.stopPropagation()
                  handleSplitH()
                }}
                className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
              >
                <SplitHorizontalIcon size={14} />
              </IconButton>

              <IconButton
                size="sm"
                aria-label={t('header.splitVertical')}
                onClick={e => {
                  e.stopPropagation()
                  handleSplitV()
                }}
                className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
              >
                <SplitVerticalIcon size={14} />
              </IconButton>
            </>
          )}
        </div>

        {/* 面板类按钮作用于整个布局而非当前 pane，此前按焦点隐藏：
            子代理分屏是「后台打开」的，焦点留在原 pane，新 pane 就一个按钮都不剩。
            改为始终渲染，未聚焦时降低不透明度以保留层级提示。 */}
        <div className={cn('flex items-center gap-1 shrink-0', !isFocused && 'opacity-60')}>
          {showSidebarButton && onOpenSidebar && (
            <IconButton
              size="sm"
              aria-label={t('header.openSidebar')}
              onClick={e => {
                e.stopPropagation()
                onOpenSidebar()
              }}
              className={cn('text-text-300 hover:text-text-100', interactive.subtle)}
            >
              <SidebarIcon size={14} />
            </IconButton>
          )}

          <IconButton
            size="sm"
            aria-label={bottomPanelOpen ? t('header.closeBottomPanel') : t('header.openBottomPanel')}
            onClick={e => {
              e.stopPropagation()
              layoutStore.toggleBottomPanel()
            }}
            className={cn(
              bottomPanelOpen
                ? interactive.toggleActive
                : 'text-text-300 hover:text-text-100 border border-transparent',
              interactive.subtle,
            )}
          >
            <PanelBottomIcon size={14} />
          </IconButton>

          <IconButton
            size="sm"
            aria-label={rightPanelOpen ? t('header.closePanel') : t('header.openPanel')}
            onClick={e => {
              e.stopPropagation()
              if (onToggleRightPanel) {
                onToggleRightPanel()
              } else {
                layoutStore.toggleRightPanel()
              }
            }}
            className={cn(
              rightPanelOpen ? interactive.toggleActive : 'text-text-300 hover:text-text-100 border border-transparent',
              interactive.subtle,
            )}
          >
            <PanelRightIcon size={14} />
          </IconButton>
        </div>
      </div>

      <div data-chat-header-shadow className="absolute top-full left-0 right-0 h-8 pointer-events-none" />
    </div>
  )
}
