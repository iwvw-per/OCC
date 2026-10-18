import { useRef, useEffect, useCallback, useState, useMemo, memo, useSyncExternalStore, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchIcon, PencilIcon, TrashIcon, ComposeIcon, PinIcon, ArchiveIcon, SpinnerIcon } from '../../components/Icons'
import { getSelectionRoundClass } from './selectionRound'
import { formatRelativeTime } from '../../utils/dateUtils'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { IconButton, Spinner } from '../../components/ui'
import { useInputCapabilities } from '../../hooks/useInputCapabilities'
import { useSessionActiveEntry } from '../../store/activeSessionStore'
import { notificationStore, useHasUnreadCompletedNotification } from '../../store/notificationStore'
import { SessionChildrenSlot } from '../chat/sidebar/SessionChildrenSlot'
import type { ApiSession } from '../../api'
import { startInternalDrag } from '../../lib/internalDragCore'
import { makeSessionKey, splitSessionKey } from '../../utils/sessionKey'
import { pinnedSessionsStore, type PinnedSessionEntry } from '../../store/pinnedSessionsStore'
import { prefetchSessionMessages } from '../../utils/sessionPrefetch'
import { serverStore } from '../../store/serverStore'
import { interactive } from '../../utils/interaction'
import { cn } from '../../utils/cn'
import { hapticTap } from '../../utils/haptics'
import { SessionContextMenu } from './SessionContextMenu'

interface SessionListProps {
  sessions: ApiSession[]
  selectedId: string | null
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  search: string
  onSearchChange: (search: string) => void
  onSelect: (session: ApiSession) => void
  onDelete: (sessionId: string) => void
  onRename: (sessionId: string, newTitle: string) => void
  onLoadMore: () => void
  onNewChat: () => void
  showHeader?: boolean
  grouped?: boolean
  density?: 'default' | 'compact' | 'minimal'
  showStats?: boolean
  showDirectory?: boolean
  /** 拉 /children 全量展示的父 session ID */
  expandedChildSessionIds?: Set<string>
  /** 按父 ID 分组的直接挂出来的子 session */
  inlineChildSessions?: Map<string, ApiSession[]>
  /** 数据所属服务器（多服务器模式；缺省用活动服务器） */
  serverId?: string
  onSelectChildSession?: (session: ApiSession) => void
  pinnedDividerAfterIds?: Set<string>
  /** 拉不到的置顶（灰色展示，可取消） */
  unavailablePinnedEntries?: PinnedSessionEntry[]
  /** SidePanel 排好的可用置顶数量（flat 列表里用来定位插入点） */
  availablePinnedCount?: number
  // ---- 编辑模式 ----
  isEditMode?: boolean
  selectedSessionIds?: Set<string>
  onToggleSessionSelection?: (sessionId: string, options?: { shiftKey?: boolean }) => void
}

// 时间分组类型
type TimeGroup = 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older'

const SESSION_GROUP_ORDER: TimeGroup[] = ['today', 'yesterday', 'previous7Days', 'previous30Days', 'older']

export function SessionList({
  sessions,
  selectedId,
  isLoading,
  isLoadingMore,
  hasMore,
  search,
  onSearchChange,
  onSelect,
  onDelete,
  onRename,
  onLoadMore,
  onNewChat,
  showHeader = true,
  grouped = true,
  density = 'default',
  showStats = true,
  showDirectory = false,
  expandedChildSessionIds,
  inlineChildSessions,
  serverId,
  onSelectChildSession,
  pinnedDividerAfterIds,
  unavailablePinnedEntries = [],
  availablePinnedCount = 0,
  isEditMode = false,
  selectedSessionIds,
  onToggleSessionSelection,
}: SessionListProps) {
  const { t } = useTranslation(['commands', 'common', 'chat'])
  const { preferTouchUi } = useInputCapabilities()
  const listRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const hasUnavailablePinned = unavailablePinnedEntries.length > 0
  // SidePanel 把可用置顶排在 sessions[0..availablePinnedCount)；不可用接在这段后面
  const lastAvailablePinnedIndex = availablePinnedCount > 0 ? availablePinnedCount - 1 : -1

  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; sessionId: string | null }>({
    isOpen: false,
    sessionId: null,
  })

  // 滚动加载
  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (!el || isLoadingMore || !hasMore) return

    const { scrollTop, scrollHeight, clientHeight } = el
    if (scrollHeight - scrollTop - clientHeight < 100) {
      onLoadMore()
    }
  }, [isLoadingMore, hasMore, onLoadMore])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // 分组逻辑
  const groupedSessions = useMemo(() => {
    const groups: Record<TimeGroup, ApiSession[]> = {
      today: [],
      yesterday: [],
      previous7Days: [],
      previous30Days: [],
      older: [],
    }

    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const yesterday = today - 86400000
    const weekAgo = today - 86400000 * 7
    const monthAgo = today - 86400000 * 30

    sessions.forEach(session => {
      // 缺 time 的轻量会话：按「未知时间」处理，归到 older，且不能拿
      // undefined 参与比较（undefined >= x 恒为 false，会静默落进最后一个分支）
      const updated = session.time?.updated ?? session.time?.created
      if (updated == null) {
        groups.older.push(session)
      } else if (updated >= today) {
        groups.today.push(session)
      } else if (updated >= yesterday) {
        groups.yesterday.push(session)
      } else if (updated >= weekAgo) {
        groups.previous7Days.push(session)
      } else if (updated >= monthAgo) {
        groups.previous30Days.push(session)
      } else {
        groups.older.push(session)
      }
    })

    return groups
  }, [sessions])

  const isCompact = density === 'compact'

  // 只有非搜索状态才显示分组
  const showGroups = !search && grouped

  return (
    <div className="flex flex-col h-full">
      {/* Search Bar + New Chat */}
      {showHeader && (
        <div className="px-3 pb-2 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="relative group flex-1">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-400 w-3.5 h-3.5 group-focus-within:text-accent-main-100 transition-colors" />
              <input
                ref={searchInputRef}
                type="text"
                name="session-search"
                value={search}
                onChange={e => onSearchChange(e.target.value)}
                placeholder={t('sessions.searchChats')}
                aria-label={t('sessions.searchChats')}
                autoComplete="off"
                className="w-full bg-bg-200/40 hover:bg-bg-200 focus:bg-bg-000 border border-transparent focus:border-border-200 rounded-lg py-2 pl-9 pr-3 text-[length:var(--fs-sm)] text-text-100 placeholder:text-text-400/70 focus:outline-none focus:shadow-sm transition-all duration-200"
              />
            </div>
            <IconButton
              size="md"
              className="bg-bg-200/40 hover:bg-bg-200"
              onClick={onNewChat}
              title={t('sessions.newChat')}
              aria-label={t('sessions.newChat')}
            >
              <ComposeIcon size={16} />
            </IconButton>
          </div>
        </div>
      )}

      {/* Session List */}
      <div
        ref={listRef}
        className={`flex-1 overflow-y-auto custom-scrollbar px-2 ${isCompact ? 'pb-3 space-y-2' : 'pb-4 space-y-4'}`}
      >
        {isLoading && sessions.length === 0 && !hasUnavailablePinned ? (
          <div className="flex items-center justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : sessions.length === 0 && !hasUnavailablePinned ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-400 opacity-60">
            <p className="text-[length:var(--fs-sm)]">
              {search ? t('common:noMatchesFound') : t('sessions.noChatsYet')}
            </p>
          </div>
        ) : showGroups ? (
          // Grouped View
          <>
            {hasUnavailablePinned && (
              <div className="space-y-0.5 mt-1">
                {unavailablePinnedEntries.map(entry => (
                  <UnavailablePinnedSessionItem key={entry.sessionId} entry={entry} density={density} />
                ))}
                {sessions.length > 0 && <div className="mx-3 my-1.5 h-px bg-border-200/45" />}
              </div>
            )}
            {SESSION_GROUP_ORDER.map(group => {
              const groupSessions = groupedSessions[group]
              if (groupSessions.length === 0) return null
              return (
                <div key={group}>
                  <h3 className="px-3 mb-1.5 mt-2 text-[length:var(--fs-xxs)] font-bold text-text-400/60 uppercase tracking-widest select-none">
                    {t(`sessions.groups.${group}`)}
                  </h3>
                  <div className="space-y-0.5">
                    {groupSessions.map((session, index) => {
                      const isChecked = selectedSessionIds?.has(session.id) ?? false
                      const prevChecked =
                        isEditMode && index > 0 && (selectedSessionIds?.has(groupSessions[index - 1].id) ?? false)
                      const nextChecked =
                        isEditMode &&
                        index < groupSessions.length - 1 &&
                        (selectedSessionIds?.has(groupSessions[index + 1].id) ?? false)
                      return (
                        <div key={session.id}>
                          <SessionListItem
                            session={session}
                            isSelected={!!selectedId && session.id === splitSessionKey(selectedId).sessionId}
                            onSelect={() => onSelect(session)}
                            onDelete={() => setDeleteConfirm({ isOpen: true, sessionId: session.id })}
                            onRename={newTitle => onRename(session.id, newTitle)}
                            preferTouchUi={preferTouchUi}
                            density={density}
                            showStats={showStats}
                            showDirectory={showDirectory}
                            isEditMode={isEditMode}
                            isChecked={isChecked}
                            checkedPrev={prevChecked}
                            checkedNext={nextChecked}
                            onToggleCheck={
                              onToggleSessionSelection
                                ? options => onToggleSessionSelection(session.id, options)
                                : undefined
                            }
                          />
                          {onSelectChildSession &&
                            (expandedChildSessionIds?.has(session.id) || inlineChildSessions?.has(session.id)) && (
                              <SessionChildrenSlot
                                parentSession={session}
                                serverId={serverId}
                                selectedSessionId={selectedId}
                                fetchAll={expandedChildSessionIds?.has(session.id)}
                                children={inlineChildSessions?.get(session.id)}
                                onSelect={onSelectChildSession}
                                isEditMode={isEditMode}
                                selectedSessionIds={selectedSessionIds}
                                onToggleSessionSelection={onToggleSessionSelection}
                              />
                            )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </>
        ) : (
          // Flat View：可用置顶前缀 → 不可用置顶 → 分隔线 → 其余
          <div className="space-y-0.5 mt-1">
            {lastAvailablePinnedIndex < 0 && hasUnavailablePinned && (
              <>
                {unavailablePinnedEntries.map(entry => (
                  <UnavailablePinnedSessionItem key={entry.sessionId} entry={entry} density={density} />
                ))}
                {sessions.length > 0 && <div className="mx-3 my-1.5 h-px bg-border-200/45" />}
              </>
            )}
            {sessions.map((session, index) => {
              const inlineChildren = inlineChildSessions?.get(session.id)
              const shouldFetchAll = expandedChildSessionIds?.has(session.id)
              const hasChildren = shouldFetchAll || (inlineChildren && inlineChildren.length > 0)
              const showPinnedDivider = pinnedDividerAfterIds?.has(session.id)
              const showUnavailableAfter = hasUnavailablePinned && index === lastAvailablePinnedIndex
              const isChecked = selectedSessionIds?.has(session.id) ?? false
              const prevChecked =
                isEditMode && index > 0 && (selectedSessionIds?.has(sessions[index - 1].id) ?? false)
              const nextChecked =
                isEditMode &&
                index < sessions.length - 1 &&
                (selectedSessionIds?.has(sessions[index + 1].id) ?? false) &&
                !showPinnedDivider
              return (
                <div key={session.id}>
                  <SessionListItem
                    session={session}
                    isSelected={!!selectedId && session.id === splitSessionKey(selectedId).sessionId}
                    onSelect={() => onSelect(session)}
                    onDelete={() => setDeleteConfirm({ isOpen: true, sessionId: session.id })}
                    onRename={newTitle => onRename(session.id, newTitle)}
                    preferTouchUi={preferTouchUi}
                    density={density}
                    showStats={showStats}
                    showDirectory={showDirectory}
                    isEditMode={isEditMode}
                    isChecked={isChecked}
                    checkedPrev={prevChecked}
                    checkedNext={nextChecked}
                    onToggleCheck={
                      onToggleSessionSelection ? options => onToggleSessionSelection(session.id, options) : undefined
                    }
                  />
                  {hasChildren && onSelectChildSession && (
                    <SessionChildrenSlot
                      parentSession={session}
                      serverId={serverId}
                      selectedSessionId={selectedId}
                      fetchAll={shouldFetchAll}
                      children={inlineChildren}
                      onSelect={onSelectChildSession}
                      isEditMode={isEditMode}
                      selectedSessionIds={selectedSessionIds}
                      onToggleSessionSelection={onToggleSessionSelection}
                    />
                  )}
                  {showUnavailableAfter &&
                    unavailablePinnedEntries.map(entry => (
                      <UnavailablePinnedSessionItem key={entry.sessionId} entry={entry} density={density} />
                    ))}
                  {showPinnedDivider && <div className="mx-3 my-1.5 h-px bg-border-200/45" />}
                </div>
              )
            })}
          </div>
        )}

        {isLoadingMore && (
          <div className="flex items-center justify-center py-2">
            <LoadingSpinner size="sm" />
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        onClose={() => setDeleteConfirm({ isOpen: false, sessionId: null })}
        onConfirm={() => {
          if (deleteConfirm.sessionId) {
            onDelete(deleteConfirm.sessionId)
          }
          setDeleteConfirm({ isOpen: false, sessionId: null })
        }}
        title={t('chat:sidebar.deleteChat')}
        description={t('chat:sidebar.deleteChatConfirm')}
        confirmText={t('common:delete')}
        variant="danger"
      />
    </div>
  )
}

// ============================================
// Session Item
// ============================================

export interface SessionListItemProps {
  session: ApiSession
  isSelected: boolean
  onSelect: () => void
  onDelete: () => void
  /** 重命名保存。返回 Promise 时行内显示保存中态，失败则留在编辑态 */
  onRename: (newTitle: string) => void | Promise<void>
  /** 归档按钮（项目模式会话行尾部）；缺省不显示。可返回 Promise 以便按钮显示归档中动画 */
  onArchive?: () => void | Promise<void>
  preferTouchUi: boolean
  density?: 'default' | 'compact' | 'minimal'
  showStats?: boolean
  showDirectory?: boolean
  /** 活跃标记查询用复合 key（serverId::sessionId，多服务器模式传入；缺省用 session.id） */
  activeSessionKey?: string
  // ---- 编辑模式 ----
  isEditMode?: boolean
  isChecked?: boolean
  /** 上一项也选中时，去掉上圆角，拼成连续选中块 */
  checkedPrev?: boolean
  /** 下一项也选中时，去掉下圆角 */
  checkedNext?: boolean
  onToggleCheck?: (options?: { shiftKey?: boolean }) => void
  // ---- 右键菜单 ----
  /** 标题变更后刷新（AI 重命名成功后调用） */
  onChanged?: () => void
  /** 是否允许右键菜单（编辑模式下关闭） */
  contextMenuEnabled?: boolean
}

function SessionListItemComponent({
  session,
  isSelected,
  onSelect,
  onDelete,
  onRename,
  onArchive,
  preferTouchUi,
  density = 'default',
  showStats = true,
  showDirectory = false,
  activeSessionKey,
  isEditMode = false,
  isChecked = false,
  checkedPrev = false,
  checkedNext = false,
  onToggleCheck,
  onChanged,
  contextMenuEnabled = true,
}: SessionListItemProps) {
  const { t } = useTranslation(['commands', 'common', 'chat'])
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [editTitle, setEditTitle] = useState(session.title || '')
  const [showActions, setShowActions] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchMoved = useRef(false)

  // 回调经 ref 转发：memo 比较忽略回调身份（父级每次重渲都会重建行内闭包），
  // 这里始终读取最新一版，避免 memo 命中时拿到过期闭包。
  const callbacksRef = useRef({ onSelect, onDelete, onRename, onArchive, onToggleCheck })
  callbacksRef.current = { onSelect, onDelete, onRename, onArchive, onToggleCheck }

  // 活跃状态标记（activeSessionStore / notificationStore 的 key 是复合 serverId::sessionId；
  // 单服务器模式 session.id 是原始 id，需用活动服务器合成复合 key 查询）
  const activeQueryKey = activeSessionKey ?? makeSessionKey(serverStore.getActiveServerId(), session.id)
  const activeEntry = useSessionActiveEntry(activeQueryKey)
  const activeStatus = activeEntry
    ? activeEntry.pendingAction?.type === 'permission'
      ? { dot: 'bg-warning-100', label: t('chat:activeSession.awaitingPermission'), pulse: false }
      : activeEntry.pendingAction?.type === 'question'
        ? { dot: 'bg-info-100', label: t('chat:activeSession.awaitingAnswer'), pulse: false }
        : activeEntry.status.type === 'retry'
          ? { dot: 'bg-warning-100', label: t('chat:activeSession.retrying'), pulse: false }
          : { dot: 'bg-success-100', label: t('chat:activeSession.working'), pulse: true }
    : null
  const hasUnreadCompletedNotification = useHasUnreadCompletedNotification(activeQueryKey)
  const itemRef = useRef<HTMLDivElement>(null)
  const isCompact = density === 'compact'
  const isMinimal = density === 'minimal'
  const hasSummaryStats = Boolean(
    showStats &&
    session.summary &&
    (session.summary.additions > 0 || session.summary.deletions > 0 || session.summary.files > 0),
  )
  const itemPaddingClass = isCompact ? 'pl-[6px] pr-3 py-2' : 'px-3 py-2.5'
  const pinnedEntries = useSyncExternalStore(
    pinnedSessionsStore.subscribe,
    pinnedSessionsStore.getSnapshot,
    pinnedSessionsStore.getSnapshot,
  )
  const isPinned = useMemo(
    () => pinnedEntries.some(entry => entry.sessionId === session.id),
    [pinnedEntries, session.id],
  )

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowActions(false)
    callbacksRef.current.onDelete()
  }

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowActions(false)
    setEditTitle(session.title || '')
    setIsEditing(true)
  }

  // 右键菜单触发的重命名：无鼠标事件，直接进入编辑态
  const startEditFromMenu = useCallback(() => {
    setShowActions(false)
    setEditTitle(session.title || '')
    setIsEditing(true)
  }, [session.title])

  const handlePin = (e: React.MouseEvent) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).blur()
    if (isPinned) {
      pinnedSessionsStore.unpin(session.id)
    } else {
      pinnedSessionsStore.pin({
        sessionId: session.id,
        directory: session.directory || '',
        title: session.title || t('sessions.untitledChat'),
      })
    }
  }

  const handleSaveEdit = async () => {
    const trimmed = editTitle.trim()
    if (!trimmed) {
      setIsEditing(false)
      return
    }
    if (trimmed === session.title) {
      setIsEditing(false)
      return
    }
    setIsSaving(true)
    try {
      await callbacksRef.current.onRename(trimmed)
      setIsEditing(false)
    } catch {
      // 保存失败：留在编辑态，用户可重试（错误提示由调用方 toast）
    } finally {
      setIsSaving(false)
    }
  }

  // 归档：调用方负责 updateSession({ time: { archived } })，返回 Promise 以便失败时复位动画态
  const [isArchiving, setIsArchiving] = useState(false)
  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowActions(false)
    setIsArchiving(true)
    try {
      await callbacksRef.current.onArchive?.()
    } finally {
      setIsArchiving(false)
    }
  }

  // 右键菜单触发的归档：无鼠标事件
  const archiveFromMenu = useCallback(async () => {
    await callbacksRef.current.onArchive?.()
  }, [])

  const handleCancelEdit = () => {
    setEditTitle(session.title || '')
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isSaving) return
      void handleSaveEdit()
    } else if (e.key === 'Escape') {
      if (isSaving) return
      handleCancelEdit()
    }
  }

  // 右键：打开会话操作菜单
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!contextMenuEnabled || isEditMode) return
      e.preventDefault()
      e.stopPropagation()
      setShowActions(false)
      setContextMenu({ x: e.clientX, y: e.clientY })
    },
    [contextMenuEnabled, isEditMode],
  )

  // 长按触摸手势：打开右键菜单（位置取触点坐标）
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!preferTouchUi) return
      if (!isEditMode && !isEditing) {
        const serverId = activeSessionKey ? splitSessionKey(activeSessionKey).serverId : serverStore.getActiveServerId()
        prefetchSessionMessages(session.id, session.directory, serverId)
      }
      const touch = e.touches[0]
      const x = touch?.clientX ?? 0
      const y = touch?.clientY ?? 0
      touchMoved.current = false
      longPressTimer.current = setTimeout(() => {
        if (!touchMoved.current && contextMenuEnabled && !isEditMode) {
          hapticTap('medium')
          setShowActions(false)
          setContextMenu({ x, y })
        } else if (!touchMoved.current) {
          hapticTap('medium')
          setShowActions(true)
        }
      }, 500)
    },
    [preferTouchUi, isEditMode, isEditing, activeSessionKey, session.id, session.directory, contextMenuEnabled],
  )

  const handleTouchMove = useCallback(() => {
    if (!preferTouchUi) return
    touchMoved.current = true
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [preferTouchUi])

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  // 点击外部收起操作按钮
  useEffect(() => {
    if (!showActions) return
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (itemRef.current && !itemRef.current.contains(e.target as Node)) {
        setShowActions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [showActions])

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // 清理定时器
  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current)
    }
  }, [])

  const handleClick = (e?: React.MouseEvent) => {
    if (isEditMode) {
      callbacksRef.current.onToggleCheck?.({ shiftKey: e?.shiftKey })
      return
    }
    // 如果操作按钮已显示，点击空白区域收起它，不触发 select。
    // 注意：收起按钮的同时也要清未读——否则用户以为已经打开了会话，
    // 项目行上的未读点却还在（触摸端 showActions 常驻，第一次点击正好走这里）。
    if (showActions) {
      setShowActions(false)
      notificationStore.markSessionNotificationsRead(activeQueryKey, 'completed')
      return
    }
    notificationStore.markSessionNotificationsRead(activeQueryKey, 'completed')
    callbacksRef.current.onSelect()
  }

  // 管理模式：阻止浏览器原生文字选区（尤其是 Shift 点选时）
  const handleSelectionMouseDown = (e: React.MouseEvent) => {
    if (!isEditMode) return
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
  }

  // 拖拽会话到主信息流进行分屏 / 替换会话
  const handleSessionPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (isEditMode || isEditing) {
      return
    }
    startInternalDrag(
      e,
      {
        kind: 'session',
        sessionId: session.id,
        serverId: activeSessionKey ? splitSessionKey(activeSessionKey).serverId : undefined,
        directory: session.directory,
      },
    )
  }

  const isDraggable = !isEditMode && !isEditing
  const selectionAttrs = isEditMode
    ? {
        'data-selection-kind': 'session' as const,
        'data-selection-id': session.id,
        'aria-selected': isChecked,
      }
    : {}

  // hover 预取：鼠标移到会话行时提前拉首页消息进 store，点击即可首帧出内容。
  // 加一小段 intent 延迟，快速划过不会触发请求；触摸端没有 hover，由 onTouchStart 兜底。
  // serverId 解析与 App.handleSelectSession 保持一致（activeSessionKey 缺省时用活动服务器），
  // 否则预取写入的复合 key 与选中时的不一致，缓存命中不了。
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resolvePrefetchServerId = () =>
    activeSessionKey ? splitSessionKey(activeSessionKey).serverId : serverStore.getActiveServerId()
  // 通过 ref 读取最新解析函数，避免把 schedulePrefetch 变成依赖频繁变化对象
  const resolvePrefetchServerIdRef = useRef(resolvePrefetchServerId)
  resolvePrefetchServerIdRef.current = resolvePrefetchServerId
  const schedulePrefetch = () => {
    if (isEditMode || isEditing || prefetchTimerRef.current) return
    prefetchTimerRef.current = setTimeout(() => {
      prefetchTimerRef.current = null
      prefetchSessionMessages(session.id, session.directory, resolvePrefetchServerIdRef.current())
    }, 180)
  }
  const cancelPrefetch = () => {
    if (prefetchTimerRef.current) {
      clearTimeout(prefetchTimerRef.current)
      prefetchTimerRef.current = null
    }
  }
  useEffect(() => {
    return () => {
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current)
    }
  }, [])

  if (isEditing) {
    return (
      <div className={isMinimal ? 'px-2 py-0.5' : 'px-3 py-2'}>
        <input
          ref={inputRef}
          type="text"
          value={editTitle}
          onChange={e => setEditTitle(e.target.value)}
          onBlur={() => {
            if (!isSaving) void handleSaveEdit()
          }}
          onKeyDown={handleKeyDown}
          onClick={e => e.stopPropagation()}
          disabled={isSaving}
          aria-busy={isSaving}
          className={`w-full bg-bg-000 border border-accent-main-100/50 rounded px-2 text-text-100 focus:outline-none focus:ring-1 focus:ring-accent-main-100/30 disabled:opacity-60 ${
            isMinimal
              ? 'py-0.5 text-[length:var(--fs-sm)] leading-normal'
              : 'py-1.5 text-[length:var(--fs-base)] leading-relaxed'
          }`}
        />
      </div>
    )
  }

  // 触控优先设备：长按触发动作按钮
  // 鼠标/悬停设备：沿用 hover 触发
  const actionsVisible = preferTouchUi ? showActions : false

  // 会话右键菜单（桌面右键 / 移动长按），两个渲染分支共用
  const contextMenuNode = contextMenu ? (
    <SessionContextMenu
      state={{ x: contextMenu.x, y: contextMenu.y, session, activeSessionKey }}
      onClose={() => setContextMenu(null)}
      onRequestRename={startEditFromMenu}
      onArchive={onArchive ? archiveFromMenu : undefined}
      onDelete={() => callbacksRef.current.onDelete()}
      onChanged={onChanged}
      isPinned={isPinned}
    />
  ) : null

  // ============================================
  // Minimal 模式 —— 文件夹视图下的紧凑单行
  // 标题 + 时间 + 活跃状态圆点
  // ============================================
  if (isMinimal) {
    const statusIndicatorTitle =
      activeStatus?.label || (hasUnreadCompletedNotification ? t('chat:notification.completed') : undefined)
    // 活跃/工作中：显示旋转状态图标；否则显示状态点
    const isWorking = !!activeStatus?.pulse

    return (
      <>
      <div
        onContextMenu={handleContextMenu}
        className={cn(
          // 与父级会话行（ActiveSessionItem）保持同一套几何：
          // pl-[6px] pr-3 py-2 rounded-lg。子行此前用 px-2 py-1.5，
          // 悬停高亮的圆角与左右边界都和父行对不齐。
          'group relative flex items-center gap-1 pl-[6px] pr-3 py-1.5 rounded-lg border border-transparent select-none',
          getSelectionRoundClass(isEditMode && isChecked, checkedPrev, checkedNext, 'md'),
          interactive.row,
          isEditMode
            ? isChecked
              ? cn(interactive.rowSelected, 'border-border-200')
              : 'text-text-300'
            : isSelected
              ? cn(interactive.rowSelected, 'border-border-200')
              : 'text-text-300',
          showActions && !isEditMode && 'bg-bg-200',
        )}
      >
        <span className="relative shrink-0 flex items-center justify-center size-5" title={statusIndicatorTitle}>
          {/* 状态指示：hover（或触摸长按显示操作）时让位给 pin */}
          <span
            className={`flex items-center justify-center transition-opacity duration-150 ${
              !isEditMode ? (actionsVisible ? 'opacity-0' : 'group-hover:opacity-0') : ''
            }`}
          >
            {isWorking ? (
              <Spinner size="xs" tone="accent" variant="grid-orbit" />
            ) : activeStatus ? (
              <>
                <span className={`absolute w-1.5 h-1.5 rounded-full ${activeStatus.dot}`} />
                {activeStatus.pulse && (
                  <span className={`absolute w-1.5 h-1.5 rounded-full ${activeStatus.dot} animate-ping opacity-50`} />
                )}
              </>
            ) : hasUnreadCompletedNotification ? (
              <span className="absolute w-1.5 h-1.5 rounded-full bg-accent-main-100" />
            ) : null}
          </span>
          {/* pin：填补状态图标位的空白，hover 时淡入覆盖 */}
          {!isEditMode && (
            <button
              type="button"
              data-compact
              onClick={handlePin}
              className={cn(
                'absolute inset-0 flex items-center justify-center rounded transition-opacity duration-150 focus-visible:ring-1 focus-visible:ring-border-200 focus-visible:ring-inset',
                actionsVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
                isPinned ? 'text-accent-main-100' : 'text-text-500 hover:text-text-200',
              )}
              title={isPinned ? t('sessions.unpin') : t('sessions.pin')}
              aria-label={isPinned ? t('sessions.unpin') : t('sessions.pin')}
            >
              <PinIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </span>

        <button
          type="button"
          onPointerDown={isDraggable ? handleSessionPointerDown : undefined}
          onMouseDown={handleSelectionMouseDown}
          onClick={e => {
            e.stopPropagation()
            handleClick(e)
          }}
          className={`peer flex min-w-0 flex-1 items-center gap-1.5 bg-transparent border-none p-0 text-left select-none ${
            !isEditMode && onArchive
              ? isArchiving || actionsVisible
                ? 'pr-11 md:pr-7'
                : 'group-hover:pr-11 md:group-hover:pr-7 group-focus-within:pr-11 md:group-focus-within:pr-7'
              : ''
          }`}
        >
          <AutoScrollTitle text={session.title || t('sessions.untitledChat')} className="text-[length:var(--fs-xs)]" />

          {((hasSummaryStats && session.summary) || session.time?.updated) && (
            <span
              className={`shrink-0 flex items-center gap-1.5 text-[length:var(--fs-xxs)] text-text-500 transition-opacity duration-150 ${
                !isEditMode && onArchive
                  ? isArchiving || actionsVisible
                    ? 'hidden'
                    : 'group-hover:hidden group-focus-within:hidden'
                  : ''
              }`}
            >
              {hasSummaryStats && session.summary && (
                <span className="flex shrink-0 items-center gap-1 font-mono">
                  {session.summary.additions > 0 && (
                    <span className="text-success-100">+{session.summary.additions}</span>
                  )}
                  {session.summary.deletions > 0 && (
                    <span className="text-danger-100">-{session.summary.deletions}</span>
                  )}
                  {session.summary.files > 0 && <span>{session.summary.files}f</span>}
                </span>
              )}

              {session.time?.updated && (
                <span className="shrink-0 -mr-1.5 text-accent-main-100">{formatRelativeTime(session.time.updated)}</span>
              )}
            </span>
          )}
        </button>

        {/* 归档：主按钮之外的覆盖层，hover 时与时间互换显示（不在按钮内嵌套 <button>） */}
        {!isEditMode && onArchive && (
          <button
            type="button"
            data-compact
            onClick={handleArchive}
            className={cn(
              'absolute right-1 inset-y-0 z-10 flex items-center justify-center min-w-9 md:min-w-0 md:right-1.5 p-0.5 rounded transition-opacity duration-150 focus-visible:ring-1 focus-visible:ring-border-200 focus-visible:ring-inset',
              actionsVisible || isArchiving
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto',
              'text-text-500 hover:text-text-200',
              isArchiving ? 'pointer-events-none text-accent-main-100' : interactive.subtle,
            )}
            title={t('chat:sidebar.archiveConversation', { defaultValue: 'Archive' })}
            aria-label={t('chat:sidebar.archiveConversation', { defaultValue: 'Archive' })}
            disabled={isArchiving}
          >
            {isArchiving ? <Spinner size="lg" tone="accent" variant="pixel" /> : <ArchiveIcon className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
      {contextMenuNode}
      </>
    )
  }

  // ============================================
  // Default / Compact 模式
  // ============================================
  return (
    <div
      ref={itemRef}
      {...selectionAttrs}
      onClick={handleClick}
      onMouseDown={handleSelectionMouseDown}
      onContextMenu={handleContextMenu}
      onMouseEnter={!isEditMode ? schedulePrefetch : undefined}
      onMouseOver={!isEditMode ? schedulePrefetch : undefined}
      onMouseLeave={!isEditMode ? cancelPrefetch : undefined}
      onTouchStart={!isEditMode ? handleTouchStart : undefined}
      onTouchMove={!isEditMode ? handleTouchMove : undefined}
      onTouchEnd={!isEditMode ? handleTouchEnd : undefined}
      className={cn(
        'group relative flex items-start',
        itemPaddingClass,
        'cursor-default transition-all duration-200 border border-transparent select-none',
        getSelectionRoundClass(isEditMode && isChecked, checkedPrev, checkedNext, 'lg'),
        interactive.row,
        isEditMode
          ? isChecked
            ? cn(interactive.rowSelected, 'border-border-200')
            : ''
          : isSelected
            ? cn(interactive.rowSelected, 'border-border-200')
            : '',
        showActions && !isEditMode && 'bg-bg-200',
      )}
    >
      <button
        type="button"
        onPointerDown={isDraggable ? handleSessionPointerDown : undefined}
        onMouseDown={handleSelectionMouseDown}
        onClick={e => {
          e.stopPropagation()
          handleClick(e)
        }}
        className="peer flex min-w-0 flex-1 items-start bg-transparent border-none p-0 text-left select-none"
      >
        <div
          className={`flex-1 min-w-0 transition-[padding] duration-200 ${
            showActions ? 'pr-[132px] md:pr-[88px]' : 'pr-1 group-hover:pr-[132px] md:group-hover:pr-[88px]'
          }`}
        >
          <p
            className={`${isCompact ? 'text-[length:var(--fs-md)]' : 'text-[length:var(--fs-base)]'} truncate font-medium ${
              (isEditMode ? isChecked : isSelected)
                ? 'text-text-100'
                : 'text-text-200'
            }`}
            title={session.title || t('sessions.untitledChat')}
          >
            {session.title || t('sessions.untitledChat')}
          </p>

          <div
            className={`flex items-center ${isCompact ? 'mt-1' : 'mt-1.5'} h-4 text-[length:var(--fs-xxs)] text-text-400 gap-1 overflow-hidden`}
          >
            {activeStatus ? (
              <>
                <span className="relative shrink-0 flex items-center justify-center w-3 h-3">
                  <span className={`absolute w-1.5 h-1.5 rounded-full ${activeStatus.dot}`} />
                  {activeStatus.pulse && (
                    <span className={`absolute w-1.5 h-1.5 rounded-full ${activeStatus.dot} animate-ping opacity-50`} />
                  )}
                </span>
                <span className="opacity-30 shrink-0">·</span>
              </>
            ) : hasUnreadCompletedNotification ? (
              <>
                <span
                  className="relative shrink-0 flex items-center justify-center w-3 h-3"
                  title={t('chat:notification.completed')}
                >
                  <span className="absolute w-1.5 h-1.5 rounded-full bg-accent-main-100" />
                </span>
                <span className="opacity-30 shrink-0">·</span>
              </>
            ) : null}
            {session.time?.updated && (
              <span className="shrink-0 opacity-60">{formatRelativeTime(session.time.updated)}</span>
            )}
            {showStats && session.summary && (
              <>
                <span className="opacity-30">·</span>
                <span className="flex items-center gap-1.5 font-mono shrink-0">
                  {session.summary.additions > 0 && (
                    <span className="text-success-100">+{session.summary.additions}</span>
                  )}
                  {session.summary.deletions > 0 && <span className="text-danger-100">-{session.summary.deletions}</span>}
                  {session.summary.files > 0 && <span>{session.summary.files}f</span>}
                </span>
              </>
            )}
            {showDirectory && session.directory && (
              <>
                <span className="opacity-30 shrink-0">·</span>
                <span className="truncate opacity-50" title={session.directory}>
                  {session.directory.replace(/\\/g, '/').split('/').filter(Boolean).pop()}
                </span>
              </>
            )}
          </div>
        </div>
      </button>

      {/* Actions: hover on desktop, long-press on mobile — 管理模式下隐藏 */}
      {!isEditMode && (
        <div
          className={`absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-all duration-200 z-10 ${
            actionsVisible
              ? 'opacity-100 pointer-events-auto'
              : 'opacity-0 group-hover:opacity-100 peer-focus-visible:opacity-100 focus-within:opacity-100 pointer-events-none group-hover:pointer-events-auto peer-focus-visible:pointer-events-auto focus-within:pointer-events-auto'
          }`}
        >
          <IconButton
            size="sm"
            className={
              isPinned
                ? 'text-accent-main-100 hover:bg-transparent hover:text-accent-main-200'
                : interactive.subtle
            }
            onClick={handlePin}
            title={isPinned ? t('sessions.unpin') : t('sessions.pin')}
            aria-label={isPinned ? t('sessions.unpin') : t('sessions.pin')}
          >
            <PinIcon className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            onClick={handleStartEdit}
            className="text-text-400 hover:text-text-100"
            title={t('sessions.rename')}
            aria-label={t('sessions.rename')}
          >
            <PencilIcon className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton
            size="sm"
            variant="danger"
            onClick={handleDelete}
            title={t('common:delete')}
            aria-label={t('common:delete')}
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </IconButton>
        </div>
      )}
      {contextMenuNode}
    </div>
  )
}

/**
 * memo 比较：列表在侧栏每次重渲（busy 状态、选中态等）都会重建行内回调，
 * 若用默认浅比较，回调身份变化会让所有行失效重渲。这里忽略回调身份，
 * 只比较真正影响渲染的数据 prop；回调由组件内部读取最新的 props 即可
 * （组件本身订阅了 activeSessionStore / notificationStore，状态变化仍会自行更新）。
 * 可选回调（onArchive / onToggleCheck）用「是否有值」比较，避免出现/消失时漏渲染。
 */
export const SessionListItem = memo(SessionListItemComponent, (prev, next) => {
  return (
    prev.session === next.session &&
    prev.isSelected === next.isSelected &&
    prev.preferTouchUi === next.preferTouchUi &&
    prev.density === next.density &&
    prev.showStats === next.showStats &&
    prev.showDirectory === next.showDirectory &&
    prev.activeSessionKey === next.activeSessionKey &&
    prev.isEditMode === next.isEditMode &&
    prev.isChecked === next.isChecked &&
    prev.checkedPrev === next.checkedPrev &&
    prev.checkedNext === next.checkedNext &&
    prev.contextMenuEnabled === next.contextMenuEnabled &&
    (prev.onArchive == null) === (next.onArchive == null) &&
    (prev.onChanged == null) === (next.onChanged == null) &&
    (prev.onToggleCheck == null) === (next.onToggleCheck == null)
  )
})

function UnavailablePinnedSessionItem({
  entry,
  density = 'default',
}: {
  entry: PinnedSessionEntry
  density?: 'default' | 'compact' | 'minimal'
}) {
  const { t } = useTranslation(['commands'])
  const title = entry.title || entry.sessionId.slice(0, 12) + '...'
  const isCompact = density === 'compact'
  const padding = isCompact ? 'pl-[6px] pr-3 py-2' : 'px-3 py-2.5'

  return (
    <div className={`group relative flex items-start ${padding} border border-transparent`}>
      <div className="flex-1 min-w-0 mr-1 group-hover:mr-8 transition-[margin] duration-200">
        <p
          className={`${isCompact ? 'text-[length:var(--fs-md)]' : 'text-[length:var(--fs-base)]'} truncate font-medium text-text-500`}
          title={title}
        >
          {title}
        </p>
        <div className={`flex items-center ${isCompact ? 'mt-1' : 'mt-1.5'} h-4 text-[length:var(--fs-xxs)] text-text-500`}>
          <span>{t('sessions.unavailable')}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation()
          pinnedSessionsStore.unpin(entry.sessionId)
        }}
        className={cn(
          'absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-accent-main-100 hover:text-accent-main-200',
          'opacity-0 group-hover:opacity-100 transition-colors',
          interactive.subtle,
        )}
        title={t('sessions.unpin')}
        aria-label={t('sessions.unpin')}
      >
        <PinIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ============================================
// Loading Spinner
// ============================================

function LoadingSpinner({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const sizeClass = size === 'sm' ? 'w-3 h-3' : 'w-5 h-5'
  return <SpinnerIcon className={`animate-spin text-accent-main-100 ${sizeClass}`} size={size === 'sm' ? 12 : 20} />
}

// ============================================
// AutoScrollTitle - 标题过长时 hover 自动滚动
// ============================================

function AutoScrollTitle({ text, className }: { text: string; className?: string }) {
  const outerRef = useRef<HTMLSpanElement>(null)
  const innerRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return

    const measure = () => {
      setOverflow(inner.scrollWidth > outer.clientWidth)
    }
    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(outer)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [text])

  return (
    <span
      ref={outerRef}
      className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[length:var(--fs-sm)] optical-center ${
        overflow ? 'marquee-title name-fade-right' : 'truncate'
      } ${className ?? ''}`}
      title={text}
    >
      <span
        ref={innerRef}
        className="inline-block whitespace-nowrap marquee-title-inner max-w-none"
        style={
          overflow
            ? ({ ['--marquee-distance' as string]: `calc(${30}px - 100%)`, ['--marquee-duration' as string]: '2.8s' } as React.CSSProperties)
            : undefined
        }
      >
        {text}
      </span>
    </span>
  )
}
