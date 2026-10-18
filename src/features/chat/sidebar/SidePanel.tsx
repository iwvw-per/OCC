import { useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderRecentList, type FolderRecentProject } from './FolderRecentList'
import { HostQuickSwitcher } from './HostQuickSwitcher'
import { SessionSortMenu } from './SessionSortMenu'
import { useServerStore } from '../../../hooks/useServerStore'
import { useHostSlideState } from './hostSwitchDirection'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { IconButton } from '../../../components/ui/IconButton'
import { SidebarFooter } from './SidebarFooter'
import {
  SidebarIcon,
  PlusIcon,
  NewChatIcon,
  TrashIcon,
  SearchIcon,
  CloseIcon,
  ManageSessionsIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  FolderMinusIcon,
  CheckIcon,
} from '../../../components/Icons'
import { useDirectory, useKeybindingLabel } from '../../../hooks'
import { Spinner } from '../../../components/ui/Spinner'
import { useSessionContext } from '../../../contexts/useSessionContext'
import { useLayoutStore, childSessionStore } from '../../../store'
import { useBusySessions } from '../../../store/activeSessionStore'
import { notificationStore, useNotifications } from '../../../store/notificationStore'
import { pinnedSessionsStore } from '../../../store/pinnedSessionsStore'
import {
  updateSession,
  deleteSession as apiDeleteSession,
  subscribeToConnectionState,
  type ApiSession,
  type ConnectionInfo,
} from '../../../api'
import { isSameDirectory } from '../../../utils'
import { makeSessionKey, splitSessionKey } from '../../../utils/sessionKey'
import { uiErrorHandler } from '../../../utils'
import { useSessionSelection as useSessionSelection2 } from './useSessionSelection'
import { resolveSavedProjectPaths, useProjectGroups, type ProjectItem } from './useProjectGroups'
import { useMissingSessionFetch } from './useMissingSessionFetch'
import { cn } from '../../../utils/cn'
import { interactive } from '../../../utils/interaction'

// 侧边栏设计模式：
// - 按钮结构统一，不因 expanded/collapsed 改变 DOM
// - 按钮内容使用 -translate-x-2 让图标在收起时居中
// - 文字用 opacity 过渡，不改变布局
// - 收起宽度 49px，展开宽度 288px

interface SidePanelProps {
  /**
   * 新建会话。可传入目标服务器与目录（项目行的「新对话」按钮）：
   * 不传时沿用当前焦点服务器；传入时切到该服务器，避免点 A 项目的按钮
   * 却因焦点服务器是 B 而跳到 B。
   */
  onNewSession: (target?: { serverId?: string; directory?: string }) => void
  onSelectSession: (session: ApiSession) => void
  onCloseMobile?: () => void
  selectedSessionId: string | null
  onAddProject: () => void
  isMobile?: boolean
  isExpanded?: boolean
  onToggleSidebar: () => void
  contextLimit?: number
  onOpenSettings?: () => void
  /** 桌面端标题栏已承载 logo 与开关：隐藏顶部 header 行 */
  hideHeader?: boolean
}

export function SidePanel({
  onNewSession,
  onSelectSession,
  onCloseMobile,
  selectedSessionId,
  onAddProject,
  isMobile = false,
  isExpanded = true,
  onToggleSidebar,
  contextLimit = 200000,
  onOpenSettings,
  hideHeader = false,
}: SidePanelProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { currentDirectory, setCurrentDirectory, removeDirectory, reorderDirectories } = useDirectory()
  // 项目 tab 数据源 = 活动服务器（per-server 存储）里用户显式保存的项目。
  // 不做服务器侧自动发现：项目列表完全由同步的 saved-directories 决定，
  // 这样多端看到的是同一份，用户不必在每台设备上重复隐藏噪音目录。
  const { servers, activeServer } = useServerStore()
  const activeServerId = activeServer?.id ?? 'local'
  // 切换主机时项目列表按方位平移：目标主机在切换条中更靠右则从右滑入，否则从左。
  const hostSlide = useHostSlideState(
    useMemo(() => servers.map(server => server.id), [servers]),
    activeServerId,
  ).className
  const { sidebarChildSessions } = useLayoutStore()
  // all = 始终列出全部子会话；active = 只列活跃/正在查看；off = 不额外列出
  const showAllChildSessions = sidebarChildSessions === 'all'
  const showActiveChildSessions = sidebarChildSessions !== 'off'
  const [connectionState, setConnectionState] = useState<ConnectionInfo | null>(null)
  const selection = useSessionSelection2()
  const {
    isEditMode,
    selectedSessionIds,
    selectedProjectIds,
    toggleSessionSelection,
    toggleProjectSelection,
    enterEditMode,
    rootRef: selectionRootRef,
    exitEditMode,
    clearSessionSelection,
    clearProjectSelection,
  } = selection
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pendingFocusSearchRef = useRef(false)
  // 批量删除确认弹窗
  const [batchDeleteSessionConfirm, setBatchDeleteSessionConfirm] = useState(false)
  const [batchRemoveProjectConfirm, setBatchRemoveProjectConfirm] = useState(false)
  const [isBatchDeleting, setIsBatchDeleting] = useState(false)

  const showLabels = isExpanded || isMobile
  const newChatShortcut = useKeybindingLabel('newSession')

  // 收起态点搜索：展开后再聚焦输入框
  useEffect(() => {
    if (!showLabels) return

    if (pendingFocusSearchRef.current) {
      pendingFocusSearchRef.current = false
      const frameId = requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
      return () => cancelAnimationFrame(frameId)
    }
  }, [showLabels])

  // Active sessions
  const busySessions = useBusySessions()
  useSyncExternalStore(
    childSessionStore.subscribe.bind(childSessionStore),
    childSessionStore.getVersion,
    childSessionStore.getVersion,
  )
  // Notification history
  const notifications = useNotifications()

  useEffect(() => {
    return subscribeToConnectionState(setConnectionState)
  }, [])

  const { sessions, search, setSearch, refresh, isLoading } = useSessionContext()

  const pinnedEntries = useSyncExternalStore(
    pinnedSessionsStore.subscribe,
    pinnedSessionsStore.getSnapshot,
    pinnedSessionsStore.getSnapshot,
  )
  // 补全不在当前列表里的会话（忙碌/通知/置顶/选中），返回 sessionId → ApiSession
  const { sessionLookup } = useMissingSessionFetch({
    sessions,
    busy: busySessions,
    notifications,
    pinned: pinnedEntries,
    selectedSessionId,
    currentDirectory,
  })

  const resolvedPinnedSessions = useMemo(
    () =>
      pinnedEntries
        .map(entry => sessionLookup.get(entry.sessionId))
        .filter((session): session is ApiSession => Boolean(session)),
    [pinnedEntries, sessionLookup],
  )
  // 当前 lookup 里没有的置顶：灰色展示，始终可取消
  const unavailablePinnedEntries = useMemo(
    () => pinnedEntries.filter(entry => !sessionLookup.has(entry.sessionId)),
    [pinnedEntries, sessionLookup],
  )

  // ---- 子 session 展示数据 ----
  const rootSessionIds = useMemo(() => new Set(sessions.map(s => s.id)), [sessions])

  const findParentId = useCallback(
    (id: string) => {
      // 输入可能是复合 key（serverId::sessionId）或原始 id；返回「原始 parentID」
      // （sessions/sessionLookup 以原始 id 存；childSessionStore 以复合 key 存）
      const { serverId, sessionId } = splitSessionKey(id)
      const s = sessionLookup.get(sessionId)
      if (s?.parentID) return s.parentID
      const childInfo = childSessionStore.getSessionInfo(id.includes('::') ? id : makeSessionKey(serverId, id))
      return childInfo ? splitSessionKey(childInfo.parentID).sessionId : undefined
    },
    [sessionLookup],
  )

  // all → 拉 /children 全量：选中的 root 或选中子 session 时保持其父展开
  const expandedChildSessionIds = useMemo(() => {
    if (search || !showAllChildSessions || !selectedSessionId) return undefined
    // 选中子 session → 展开其父；否则（root）展开自身，交给 SessionChildrenSlot
    // 走 fetchAll 拉 /children。不能依赖 childSessionStore 的内存注册来判断——
    // 历史子会话（本客户端连接之前创建）不在注册表里，按注册判断会永远不展开，
    // 「显示全部子会话」形同无效。
    const pid = findParentId(selectedSessionId)
    if (pid) return new Set([pid])
    return new Set([splitSessionKey(selectedSessionId).sessionId])
  }, [search, showAllChildSessions, selectedSessionId, findParentId])

  // active → 只挂活跃的 + 选中的子 session；off → 只挂选中的那个
  const inlineChildSessions = useMemo(() => {
    if (search) return undefined
    const map = new Map<string, ApiSession[]>()
    const add = (parentId: string, session: ApiSession) => {
      if (expandedChildSessionIds?.has(parentId)) return
      let arr = map.get(parentId)
      if (!arr) {
        arr = []
        map.set(parentId, arr)
      }
      if (!arr.some(s => s.id === session.id)) arr.push(session)
    }
    if (showActiveChildSessions) {
      for (const entry of busySessions) {
        const pid = findParentId(entry.sessionId)
        // 父可能在其它服务器的会话列表里，因此放宽为「只要解析出父 id 就挂上」，
        // 不再要求父在 rootSessionIds（那只是当前服务器的列表）
        if (pid) {
          const rawId = splitSessionKey(entry.sessionId).sessionId
          // sessionLookup 只含 active 服务器会话；其他服务器的子 session 用 entry 构造
          const s =
            sessionLookup.get(rawId) ??
            (entry.title || entry.directory
              ? ({ id: rawId, title: entry.title, directory: entry.directory } as ApiSession)
              : undefined)
          if (s) add(pid, s)
        }
      }
    }
    if (selectedSessionId && !rootSessionIds.has(splitSessionKey(selectedSessionId).sessionId)) {
      // 只挂「当前服务器列表里能确认是父」的，避免把别的服务器的会话误挂上来
      const pid = findParentId(selectedSessionId)
      if (pid && rootSessionIds.has(pid)) {
        const s = sessionLookup.get(splitSessionKey(selectedSessionId).sessionId)
        if (s) add(pid, s)
      }
    }
    return map.size > 0 ? map : undefined
  }, [
    search,
    busySessions,
    selectedSessionId,
    showActiveChildSessions,
    rootSessionIds,
    expandedChildSessionIds,
    sessionLookup,
    findParentId,
  ])

  const projects = useProjectGroups({ activeServerId, currentDirectory })
  const {
    folderProjects,
    sortedFolderProjects,
    expandedProjectIds: expandedRecentProjectIds,
    setExpandedProjectIds: setExpandedRecentProjectIds,
    allProjectsCollapsed,
    projectLastUsedAt,
    savedDirectoryPaths,
    hideProjectDirectory,
  } = projects

  // 需求 3：点击项目目录/名称不跳转（只展开/收起），只有点击会话才导航。
  // 保持签名兼容 FolderRecentList 的 onSelectProject 调用，但不再 setCurrentDirectory。
  const handleSelectFolderProject = useCallback((_project: ProjectItem) => {}, [])

  // 仅用于 git workspace 内部「工作区文件夹」的拖拽重排（项目行本身不再可拖拽）。
  const handleReorderProjectGroup = useCallback(
    (draggedId: string, targetId: string) => {
      const draggedIdx = folderProjects.findIndex(project => project.id === draggedId)
      const targetIdx = folderProjects.findIndex(project => project.id === targetId)
      if (draggedIdx === -1 || targetIdx === -1 || draggedIdx === targetIdx) return

      // 不展示「全局」文件夹，故不存在全局行拖拽分支
      const draggedReorderPath = folderProjects[draggedIdx].reorderPath
      const targetReorderPath = folderProjects[targetIdx].reorderPath
      if (!draggedReorderPath || !targetReorderPath) return
      reorderDirectories(draggedReorderPath, targetReorderPath)
    },
    [folderProjects, reorderDirectories],
  )

  const handleSelectActive = useCallback(
    (session: ApiSession & { serverId?: string }) => {
      // 只导航，不自动保存目录到项目列表：目录由 URL（?dir=）派生，currentDirectory 自动跟随；
      // 若在此 addDirectory，点一次会话就把项目塞进已保存列表，触发列表重建 + 自动展开级联。
      onSelectSession(session)
      if (window.innerWidth < 768 && onCloseMobile) {
        onCloseMobile()
      }
    },
    [onSelectSession, onCloseMobile],
  )

  const handleRenameFolderSession = useCallback(
    async (session: ApiSession, newTitle: string) => {
      try {
        await updateSession(session.id, { title: newTitle }, session.directory)
        pinnedSessionsStore.update(session.id, { title: newTitle })
        if (!currentDirectory || isSameDirectory(currentDirectory, session.directory)) {
          await refresh()
        }
      } catch (e) {
        uiErrorHandler('rename session', e)
        // 重新抛出让行内编辑态保持打开，用户可以原地重试
        throw e
      }
    },
    [currentDirectory, refresh],
  )

  const handleDeleteFolderSession = useCallback(
    async (session: ApiSession) => {
      await apiDeleteSession(session.id, session.directory)
      // 清掉该会话的通知：否则项目行会因孤儿通知一直亮未读点
      notificationStore.removeSessionNotifications(session.id)
      pinnedSessionsStore.unpin(session.id)

      if (!currentDirectory || isSameDirectory(currentDirectory, session.directory)) {
        await refresh()
      }

      if (selectedSessionId === session.id) {
        onNewSession()
      }
    },
    [currentDirectory, onNewSession, refresh, selectedSessionId],
  )

  // ---- 批量删除 session ----
  const handleBatchDeleteSessions = useCallback(async () => {
    if (selectedSessionIds.size === 0) return
    setIsBatchDeleting(true)

    const needSwitchSession = selectedSessionId && selectedSessionIds.has(selectedSessionId)

    // 文件夹模式下可能跨目录，需要按 session 逐个调用
    // 普通模式下也用 sessionLookup 获取目录信息
    const ids = Array.from(selectedSessionIds)
    await Promise.allSettled(
      ids.map(async id => {
        try {
          const s = sessionLookup.get(id)
          if (s) {
            await apiDeleteSession(id, s.directory)
          } else {
            await apiDeleteSession(id, currentDirectory)
          }
          notificationStore.removeSessionNotifications(id)
          pinnedSessionsStore.unpin(id)
        } catch (e) {
          uiErrorHandler('batch delete session', e)
        }
      }),
    )

    await refresh()
    clearSessionSelection()
    setBatchDeleteSessionConfirm(false)
    setIsBatchDeleting(false)

    if (needSwitchSession) {
      onNewSession()
    }
  }, [selectedSessionIds, selectedSessionId, sessionLookup, currentDirectory, refresh, onNewSession, clearSessionSelection])

  // ---- 批量移除项目 ----
  const handleBatchRemoveProjects = useCallback(() => {
    if (selectedProjectIds.size === 0) return
    for (const projectId of selectedProjectIds) {
      const project = folderProjects.find(item => item.id === projectId)
      if (!project) continue
      const targets = resolveSavedProjectPaths(project, savedDirectoryPaths)
      let removed = false
      for (const directory of targets) {
        removeDirectory(directory)
        removed = true
      }
      // 派生项目（服务器当前 worktree）不在已保存列表里：持久隐藏它
      if (!removed && project.worktree) hideProjectDirectory(project.worktree)
    }
    clearProjectSelection()
    setBatchRemoveProjectConfirm(false)
  }, [folderProjects, savedDirectoryPaths, selectedProjectIds, removeDirectory, clearProjectSelection, hideProjectDirectory])

  // 单个项目移除：二次点击防误触（按钮层），这里直接执行。
  //
  // 两种语义，按项目是否真的「已保存」分流：
  //   - 在 saved-directories 里 → 从列表移除（不动磁盘文件、不动会话）；
  //   - 不在（服务器当前 worktree 自动置顶的派生项目）→ 持久隐藏。
  //     后者以前只是内存状态，刷新就回来 —— 用户报的「删了又出现」正是这个。
  const handleRemoveProjectClick = useCallback(
    (project: FolderRecentProject) => {
      const targets = resolveSavedProjectPaths(project, savedDirectoryPaths)
      let removed = false
      for (const directory of targets) {
        removeDirectory(directory)
        removed = true
      }
      if (!removed && project.worktree) hideProjectDirectory(project.worktree)
    },
    [removeDirectory, savedDirectoryPaths, hideProjectDirectory],
  )

  // 需求 4：在指定项目目录下新建会话。
  //
  // 必须带上项目所属服务器：onNewSession 默认切到「焦点服务器」，而焦点服务器
  // 可能是另一台（用户在别处点过会话），于是点 A 项目的「新对话」会跳到 B —— 表现为
  // 「随机跳服务器」。项目行属于活动服务器，这里显式指定即可。
  const handleNewSessionInDirectory = useCallback(
    (directory: string) => {
      if (!isSameDirectory(currentDirectory, directory)) {
        setCurrentDirectory(directory)
      }
      onNewSession({ serverId: activeServerId, directory })
    },
    [currentDirectory, setCurrentDirectory, onNewSession, activeServerId],
  )

  const commonFolderRecentListProps = {
    currentDirectory,
    selectedSessionId,
    // 项目 tab 的数据源是活动服务器；状态汇总（busy/未读）必须用同一个 serverId 收窄，
    // 否则另一台服务器同名路径的会话状态会挂到本服务器项目行上
    serverId: activeServerId,
    // 搜索时强制展开所有项目：让各项目加载会话供就地筛选（否则折叠项目的会话未加载会被误隐藏）
    expandedProjectIds: search ? folderProjects.map(project => project.id) : expandedRecentProjectIds,
    onExpandedProjectIdsChange: setExpandedRecentProjectIds,
    onSelectProject: handleSelectFolderProject,
    onSelectSession: handleSelectActive,
    onRenameSession: handleRenameFolderSession,
    onDeleteSession: handleDeleteFolderSession,
    onSessionChanged: () => void refresh(),
    onNewSessionInDirectory: handleNewSessionInDirectory,
    onRemoveProject: handleRemoveProjectClick,
    expandedChildSessionIds,
    inlineChildSessions,
    onSelectChildSession: handleSelectActive,
    search,
    isEditMode,
    selectedSessionIds,
    selectedProjectIds,
    onToggleSessionSelection: toggleSessionSelection,
    onToggleProjectSelection: toggleProjectSelection,
    projectLastUsedAt,
  }

  // 统一的结构，通过 CSS 控制显示/隐藏
  return (
    <div data-sidebar className="flex flex-col h-full overflow-hidden">
      {/* ===== Header ===== */}
      {hideHeader ? null : (
        <div
          className={`shrink-0 flex items-center border-b border-border-200/60 px-2 gap-1 ${
            isMobile ? 'chat-topbar' : 'h-11'
          }`}
        >
          {/* 折叠按钮 - 最左侧，与下方各项目图标对齐（mx-2 + paddingLeft 6） */}
          {!isMobile && (
            <button
              onClick={onToggleSidebar}
              aria-label={isExpanded ? t('sidebar.collapseSidebar') : t('sidebar.expandSidebar')}
              className={cn(
                'h-8 w-8 flex items-center justify-center rounded-lg text-text-300 hover:text-text-100 shrink-0',
                interactive.row,
                'transition-all duration-200',
              )}
              style={{ paddingLeft: 6, paddingRight: 6 }}
            >
              <SidebarIcon size={16} />
            </button>
          )}

          {/* Logo 区域 - 折叠按钮右侧，占满剩余宽度，展开时显示 */}
          <div
            className="flex-1 overflow-hidden transition-[opacity] duration-300 ease-out min-w-0"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            {/* 用 hash 路由跳 home：`href="/"` 会触发整页导航，丢掉当前 hash，
                未落盘的本地状态（如刚添加的项目）会因此看起来「消失」。 */}
            <a href="#/" className="flex items-center whitespace-nowrap h-full">
              <span className="text-[length:var(--fs-heading-3)] font-semibold text-text-100 tracking-tight">
                {t('header.openCode')}
              </span>
            </a>
          </div>
        </div>
      )}

      {/* ===== Navigation - 图标位置固定；间距与 Header 面板按钮对齐 ===== */}
      <div className={`flex flex-col gap-1 mx-2 ${hideHeader ? 'mt-2' : 'mt-1'}`}>
        {/* New Chat - 图标始终在 padding-left: 6px 位置，收起时刚好居中 */}
        <button
          type="button"
          onClick={() => onNewSession()}
          aria-label={t('sidebar.newChat')}
          className={cn(
            'h-8 flex items-center rounded-lg text-text-300 group overflow-hidden',
            interactive.row,
            'transition-all duration-300',
          )}
          style={{
            width: showLabels ? '100%' : 32,
            paddingLeft: 6,
            paddingRight: 6,
          }}
          title={t('sidebar.newChat')}
        >
          <span className="size-5 flex items-center justify-center shrink-0">
            <NewChatIcon size={16} />
          </span>
          <span
            className="ml-2 text-[length:var(--fs-base)] whitespace-nowrap transition-opacity duration-300"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            {t('sidebar.newChat')}
          </span>
          <span
            className="ml-auto text-[length:var(--fs-xxs)] text-text-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap"
            style={{ opacity: showLabels ? undefined : 0 }}
          >
            {newChatShortcut}
          </span>
        </button>

        {/* 新建项目 - 收起时仅图标 */}
        <button
          type="button"
          onClick={onAddProject}
          aria-label={t('sidebar.newProject')}
          className={cn(
            'h-8 flex items-center rounded-lg text-text-300 group overflow-hidden',
            interactive.row,
            'transition-all duration-300',
          )}
          style={{
            width: showLabels ? '100%' : 32,
            paddingLeft: 6,
            paddingRight: 6,
          }}
          title={t('sidebar.newProject')}
        >
          <span className="size-5 flex items-center justify-center shrink-0">
            <PlusIcon size={16} />
          </span>
          <span
            className="ml-2 text-[length:var(--fs-base)] whitespace-nowrap transition-opacity duration-300"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            {t('sidebar.newProject')}
          </span>
        </button>

        {/* Search — 与上方导航同列 gap-0.5；收起时图标，展开时输入框 */}
        {showLabels ? (
          <div className="relative w-full mb-1.5">
            <span className="pointer-events-none absolute left-[6px] top-1/2 -translate-y-1/2 size-5 flex items-center justify-center text-text-300">
              <SearchIcon size={16} />
            </span>
            <input
              ref={searchInputRef}
              type="text"
              name="sidebar-chat-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('sidebar.searchChats')}
              aria-label={t('sidebar.searchChats')}
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-full appearance-none rounded-lg border-0 bg-transparent pl-[34px] pr-[26px] text-[length:var(--fs-base)] text-text-100 shadow-none outline-none ring-0 placeholder:text-text-300 transition-shadow focus-visible:ring-1 focus-visible:ring-accent-main-100/30"
            />
            {search && isLoading ? (
              <span
                className="absolute right-[6px] top-1/2 flex size-[14px] -translate-y-1/2 items-center justify-center"
                aria-label={t('sidebar.searchingChats', { defaultValue: 'Searching' })}
              >
                <Spinner size="xs" tone="accent" variant="pixel" />
              </span>
            ) : (
              search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-[6px] top-1/2 flex size-[14px] -translate-y-1/2 items-center justify-center text-text-400 hover:text-text-100"
                  aria-label={t('sidebar.clearSearch')}
                >
                  <CloseIcon size={14} />
                </button>
              )
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              pendingFocusSearchRef.current = true
              onToggleSidebar()
            }}
            aria-label={t('sidebar.searchChats')}
            className={cn(
              'h-8 mb-1.5 flex items-center rounded-lg text-text-300 hover:text-text-100 overflow-hidden',
              interactive.row,
              'transition-all duration-300',
            )}
            style={{ width: 32, paddingLeft: 6, paddingRight: 6 }}
            title={t('sidebar.searchChats')}
          >
            <span className="size-5 flex items-center justify-center shrink-0">
              <SearchIcon size={16} />
            </span>
          </button>
        )}
      </div>

      {/* 搜索与列表之间的全宽分割线（负 margin 抵消导航区的 mx-2，通栏显示） */}
      {showLabels && <div className="-mx-2 h-px bg-border-200/50" />}

      {/* ===== Main Content ===== */}
      <div
        className="flex-1 flex flex-col min-h-0 overflow-hidden transition-opacity duration-300 ease-out"
        style={{
          opacity: showLabels ? 1 : 0,
          visibility: showLabels ? 'visible' : 'hidden',
        }}
      >
        {/* Tab Bar: Recents / Active */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* 固定行高：普通态是 TabsList（slider/sm：p-1 + 文字 + 边框，约 36px），
              管理态是提示文字 + 操作按钮。两态的 padding 天然凑不齐，不固定高度的话
              点「管理」整行会缩 ~6px，下方列表跟着上跳。这里钉死高度，
              两个分支的 py 只用来做垂直居中微调。 */}
          <div className="flex items-center mx-2 gap-1 shrink-0 h-9">
            {isEditMode ? (
              <>
                {/* 与 tab 同字号字重，左侧文案变成状态提示 */}
                <span className="pl-[6px] pr-2 py-1.5 text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider text-text-100 min-w-0 truncate">
                  {selectedSessionIds.size === 0 && selectedProjectIds.size === 0
                    ? t('sidebar.selectItems')
                    : selectedSessionIds.size > 0 && selectedProjectIds.size > 0
                      ? t('sidebar.selectedMixed', {
                          sessions: selectedSessionIds.size,
                          projects: selectedProjectIds.size,
                        })
                      : selectedSessionIds.size > 0
                        ? t('sidebar.selectedSessions', { count: selectedSessionIds.size })
                        : t('sidebar.selectedProjects', { count: selectedProjectIds.size })}
                </span>
                <div className="ml-auto flex items-center gap-2 md:gap-1.5">
                  {selectedSessionIds.size > 0 && (
                    <button
                      type="button"
                      data-icon-button
                      onClick={() => setBatchDeleteSessionConfirm(true)}
                      className={cn('p-1.5 rounded-md text-text-500 hover:text-danger-100', interactive.danger)}
                      title={t('sidebar.deleteSessionsWithCount', { count: selectedSessionIds.size })}
                      aria-label={t('sidebar.deleteSessionsWithCount', { count: selectedSessionIds.size })}
                    >
                      <TrashIcon size={14} />
                    </button>
                  )}
                  {selectedProjectIds.size > 0 && (
                    <button
                      type="button"
                      data-icon-button
                      onClick={() => setBatchRemoveProjectConfirm(true)}
                      className={cn(
                        'p-1.5 rounded-md text-text-500 hover:text-warning-100',
                        interactive.warning,
                        interactive.focusRingCompact,
                      )}
                      title={t('sidebar.removeProjectsWithCount', { count: selectedProjectIds.size })}
                      aria-label={t('sidebar.removeProjectsWithCount', { count: selectedProjectIds.size })}
                    >
                      <FolderMinusIcon size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    data-icon-button
                    onMouseDown={e => e.preventDefault()}
                    onClick={exitEditMode}
                    aria-label={t('sidebar.doneManaging')}
                    aria-pressed
                    className={cn('p-1.5 rounded-md text-text-500 hover:text-text-100', interactive.subtle)}
                    title={t('sidebar.doneManaging')}
                  >
                    <CheckIcon size={14} />
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* 最左：当前主机名（只读标识）；右侧按钮组仍靠右 */}
                <span
                  className="min-w-0 flex-1 truncate pl-[6px] text-[length:var(--fs-sm)] font-medium text-text-400"
                  title={activeServer?.name}
                >
                  {activeServer?.name}
                </span>
                {/* 收起优先：默认先收起全部；全部收起后点击才展开全部 */}
                <div className="ml-auto shrink-0 flex items-center gap-1.5 md:gap-0.5">
                  <IconButton
                    size="sm"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setExpandedRecentProjectIds(allProjectsCollapsed ? folderProjects.map(p => p.id) : [])
                    }}
                    aria-label={
                      allProjectsCollapsed ? t('sidebar.expandAllProjects') : t('sidebar.collapseAllProjects')
                    }
                    title={allProjectsCollapsed ? t('sidebar.expandAllProjects') : t('sidebar.collapseAllProjects')}
                  >
                    {allProjectsCollapsed ? <ExpandAllIcon size={14} /> : <CollapseAllIcon size={14} />}
                  </IconButton>
                  <SessionSortMenu />
                  <IconButton
                    size="sm"
                    onMouseDown={e => e.preventDefault()}
                    onClick={enterEditMode}
                    aria-label={t('sidebar.manageSessions')}
                    title={t('sidebar.manageSessions')}
                  >
                    <ManageSessionsIcon size={14} />
                  </IconButton>
                </div>
              </>
            )}
          </div>

          {/* 主机标题与工具栏下方：与项目列表之间的全宽分割线 */}
          <div className="h-px bg-border-200/50" />

          {/* 项目列表：已保存项目文件夹树（统一按目录查询）。
              列表为空时由 FolderRecentList 渲染空状态；工作区解析的等待用文件夹内
              的局部 spinner 过渡，不做整列表转圈，避免打开会话导致侧栏整体重载。
              主机切换由底部 HostQuickSwitcher 承担，不再单独占一个 tab。 */}
          <div
            ref={selectionRootRef}
            key={activeServerId}
            className={`flex-1 overflow-hidden ${hostSlide || 'animate-in fade-in duration-150'} ${isEditMode ? 'select-none' : ''}`}
          >
            <FolderRecentList
              projects={sortedFolderProjects}
              {...commonFolderRecentListProps}
              onReorderProject={handleReorderProjectGroup}
              workspaceDirectoriesByProjectId={projects.workspaceDirectoriesByProjectId}
              pinnedSessions={resolvedPinnedSessions}
              unavailablePinnedEntries={unavailablePinnedEntries}
            />
          </div>
        </div>
      </div>

      {/* Spacer for collapsed */}
      {!showLabels && <div className="flex-1" />}

      {/* ===== 主机快速切换条（对话区底部，仅展开显示；同步图标在其右侧） ===== */}
      {showLabels && <HostQuickSwitcher />}

      {/* ===== Footer ===== */}
      <SidebarFooter
        showLabels={showLabels}
        connectionState={connectionState?.state || 'disconnected'}
        contextLimit={contextLimit}
        onOpenSettings={onOpenSettings}
      />

      {/* 批量删除会话确认弹窗 */}
      <ConfirmDialog
        isOpen={batchDeleteSessionConfirm}
        onClose={() => setBatchDeleteSessionConfirm(false)}
        onConfirm={handleBatchDeleteSessions}
        title={t('sidebar.batchDeleteSessions', { count: selectedSessionIds.size })}
        description={
          <>
            {t('sidebar.batchDeleteSessionsConfirm', { count: selectedSessionIds.size })}
            {selectedSessionId && selectedSessionIds.has(selectedSessionId) && (
              <div className="mt-2 text-[length:var(--fs-sm)] text-warning-100">
                {t('sidebar.batchDeleteIncludesCurrent')}
              </div>
            )}
          </>
        }
        confirmText={t('common:delete')}
        variant="danger"
        isLoading={isBatchDeleting}
      />

      {/* 批量移除项目确认弹窗 */}
      <ConfirmDialog
        isOpen={batchRemoveProjectConfirm}
        onClose={() => setBatchRemoveProjectConfirm(false)}
        onConfirm={handleBatchRemoveProjects}
        title={t('sidebar.batchRemoveProjects', { count: selectedProjectIds.size })}
        description={t('sidebar.batchRemoveProjectsConfirm', { count: selectedProjectIds.size })}
        confirmText={t('common:remove')}
        variant="warning"
      />
    </div>
  )
}
