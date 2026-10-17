import { useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderRecentList, type FolderRecentProject } from './FolderRecentList'
import { HostQuickSwitcher } from './HostQuickSwitcher'
import { SessionSortMenu } from './SessionSortMenu'
import { useMultiServerStore } from '../../../store/multiServerStore'
import { useServerStore } from '../../../hooks/useServerStore'
import { getProjectGroupIdentity, sortProjects, mergeProjectLastUsed } from './projectGrouping'
import { useHostSlideState } from './hostSwitchDirection'
import { sessionActivityStore } from '../../../store/sessionActivityStore'
import { mergeExpandedProjectNames } from './expandedProjects'
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
import { useDirectory, useKeybindingLabel, useGitWorkspaceCatalog, useMissingDirectories } from '../../../hooks'
import { Spinner } from '../../../components/ui/Spinner'
import { useProjectLastUsedAt } from '../../../hooks/useProjectLastUsedAt'
import { useSessionContext } from '../../../contexts/useSessionContext'
import { useLayoutStore, childSessionStore } from '../../../store'
import { useBusySessions } from '../../../store/activeSessionStore'
import { notificationStore, useNotifications } from '../../../store/notificationStore'
import { pinnedSessionsStore } from '../../../store/pinnedSessionsStore'
import { serverStore } from '../../../store/serverStore'
import { layoutStore } from '../../../store/layoutStore'
import {
  updateSession,
  deleteSession as apiDeleteSession,
  getSession,
  subscribeToConnectionState,
  type ApiSession,
  type ConnectionInfo,
} from '../../../api'
import { getDirectoryName, isSameDirectory, normalizeToForwardSlash } from '../../../utils'
import { makeSessionKey, splitSessionKey } from '../../../utils/sessionKey'
import { uiErrorHandler } from '../../../utils'
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

interface ProjectItem {
  id: string
  worktree: string
  name: string
  canReorder?: boolean
  memberDirectories?: string[]
  reorderPath?: string
  workspaceDirectories?: string[]
  sectionKind?: 'project' | 'workspace'
  /** 推导项目（无已保存工作区时从服务器会话自动生成）：不参与重排/移除 */
  isDerived?: boolean
  /** 保存到侧栏的时间（稳定，仅用于 auto+created 排序） */
  addedAt?: number
}

function getSelectionRange(visibleIds: string[], anchorId: string, targetId: string) {
  const startIndex = visibleIds.indexOf(anchorId)
  const endIndex = visibleIds.indexOf(targetId)

  if (startIndex === -1 || endIndex === -1) return null

  const from = Math.min(startIndex, endIndex)
  const to = Math.max(startIndex, endIndex)
  return visibleIds.slice(from, to + 1)
}

/**
 * 项目展开状态在存储里的 key。
 *
 * 用项目名而非 id：id 通常是 worktree 绝对路径（含盘符），跨设备不可比，
 * 用名字才能让「哪几个项目展开」在多端对齐。名字缺失时退回 worktree。
 */
function projectExpandKey(project: ProjectItem): string {
  return project.name || project.worktree || project.id
}

function findProjectGroupForDirectory(projects: ProjectItem[], directory: string) {
  return projects.find(project => {
    if (isSameDirectory(project.id, directory) || isSameDirectory(project.worktree, directory)) {
      return true
    }

    if (project.workspaceDirectories?.some(workspace => isSameDirectory(workspace, directory))) {
      return true
    }

    if (project.memberDirectories?.some(memberDirectory => isSameDirectory(memberDirectory, directory))) {
      return true
    }

    return false
  })
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
  const {
    currentDirectory,
    savedDirectories,
    setCurrentDirectory,
    removeDirectory,
    reorderDirectories,
    pathInfo,
    recentProjects,
  } = useDirectory()
  const catalogDirectories = useMemo(
    () =>
      Array.from(
        new Set(
          savedDirectories
            .map(directory => normalizeToForwardSlash(directory.path))
            .concat(currentDirectory ? [normalizeToForwardSlash(currentDirectory)] : []),
        ),
      ),
    [savedDirectories, currentDirectory],
  )
  // 多服务器：Git/路径信息跟随「焦点服务器」（焦点缺省 = 活动服务器）。
  // 不再用 enabled 门控 —— 现在始终连接所有服务器，多服务器是默认行为。
  const multiServerConfig = useMultiServerStore()
  const { servers, activeServer } = useServerStore()
  const catalogServerId = multiServerConfig.focusedServerId ?? activeServer?.id
  // 项目 tab 数据源 = 活动服务器（per-server 存储）里用户显式保存的项目。
  // 不做服务器侧自动发现：项目列表完全由同步的 saved-directories 决定，
  // 这样多端看到的是同一份，用户不必在每台设备上重复隐藏噪音目录。
  const activeServerId = activeServer?.id ?? 'local'
  // 切换主机时项目列表按方位平移：目标主机在切换条中更靠右则从右滑入，否则从左。
  // 列表容器以 activeServerId 为 key 重挂载，动画类随重挂载生效；首次渲染不播放。
  const hostSlide = useHostSlideState(
    useMemo(() => servers.map(server => server.id), [servers]),
    activeServerId,
  ).className
  const { catalog: gitWorkspaceCatalog } = useGitWorkspaceCatalog(catalogDirectories, catalogServerId)
  // 已保存目录里磁盘上已不存在的（项目整体迁移后留下的旧路径）：只从侧栏隐藏，
  // 不删存储 —— 目录若重新出现会自动恢复显示，误判也不会丢用户配置。
  const missingDirectories = useMissingDirectories(
    savedDirectories.map(directory => directory.path),
    activeServerId,
  )
  const visibleSavedDirectories = useMemo(
    () => savedDirectories.filter(directory => !missingDirectories.has(normalizeToForwardSlash(directory.path))),
    [savedDirectories, missingDirectories],
  )
  const { sidebarChildSessions, sidebarProjectSortField, sidebarProjectSortDesc } = useLayoutStore()
  // all = 始终列出全部子会话；active = 只列活跃/正在查看；off = 不额外列出
  const showAllChildSessions = sidebarChildSessions === 'all'
  const showActiveChildSessions = sidebarChildSessions !== 'off'
  const normalizedCurrentDirectory = useMemo(
    () => (currentDirectory ? normalizeToForwardSlash(currentDirectory) : undefined),
    [currentDirectory],
  )
  const [connectionState, setConnectionState] = useState<ConnectionInfo | null>(null)
  // ---- 编辑模式状态 ----
  const [isEditMode, setIsEditMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set())
  const sessionSelectionAnchorIdRef = useRef<string | null>(null)
  const projectSelectionAnchorIdRef = useRef<string | null>(null)
  const recentsSelectionRootRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pendingFocusSearchRef = useRef(false)
  // 批量删除确认弹窗
  const [batchDeleteSessionConfirm, setBatchDeleteSessionConfirm] = useState(false)
  const [batchRemoveProjectConfirm, setBatchRemoveProjectConfirm] = useState(false)
  const [isBatchDeleting, setIsBatchDeleting] = useState(false)

  const getVisibleSelectionIds = useCallback((kind: 'session' | 'project') => {
    const root = recentsSelectionRootRef.current
    if (!root) return []

    return Array.from(root.querySelectorAll<HTMLElement>(`[data-selection-kind="${kind}"]`))
      .filter(element => element.getClientRects().length > 0)
      .map(element => element.dataset.selectionId)
      .filter((id): id is string => Boolean(id))
  }, [])

  const toggleSessionSelection = useCallback(
    (sessionId: string, options?: { shiftKey?: boolean }) => {
      const anchorId = sessionSelectionAnchorIdRef.current
      const visibleIds = getVisibleSelectionIds('session')

      setSelectedSessionIds(prev => {
        if (options?.shiftKey && anchorId) {
          const range = getSelectionRange(visibleIds, anchorId, sessionId)
          if (range) {
            const next = new Set(prev)
            // 目标已选中 → 整段取消；未选中 → 整段选中
            const shouldSelect = !prev.has(sessionId)
            for (const id of range) {
              if (shouldSelect) next.add(id)
              else next.delete(id)
            }
            return next
          }
        }

        const next = new Set(prev)
        if (next.has(sessionId)) next.delete(sessionId)
        else next.add(sessionId)
        return next
      })
      // Shift 范围操作后仍保留锚点，方便连续扩选/缩选
      if (!(options?.shiftKey && anchorId)) {
        sessionSelectionAnchorIdRef.current = sessionId
      }
    },
    [getVisibleSelectionIds],
  )

  const toggleProjectSelection = useCallback(
    (projectId: string, options?: { shiftKey?: boolean }) => {
      const anchorId = projectSelectionAnchorIdRef.current
      const visibleIds = getVisibleSelectionIds('project')

      setSelectedProjectIds(prev => {
        if (options?.shiftKey && anchorId) {
          const range = getSelectionRange(visibleIds, anchorId, projectId)
          if (range) {
            const next = new Set(prev)
            const shouldSelect = !prev.has(projectId)
            for (const id of range) {
              if (shouldSelect) next.add(id)
              else next.delete(id)
            }
            return next
          }
        }

        const next = new Set(prev)
        if (next.has(projectId)) next.delete(projectId)
        else next.add(projectId)
        return next
      })
      if (!(options?.shiftKey && anchorId)) {
        projectSelectionAnchorIdRef.current = projectId
      }
    },
    [getVisibleSelectionIds],
  )

  const exitEditMode = useCallback(() => {
    setIsEditMode(false)
    setSelectedSessionIds(new Set())
    setSelectedProjectIds(new Set())
    sessionSelectionAnchorIdRef.current = null
    projectSelectionAnchorIdRef.current = null
  }, [])

  const enterEditMode = useCallback(() => {
    setIsEditMode(true)
    sessionSelectionAnchorIdRef.current = null
    projectSelectionAnchorIdRef.current = null
  }, [])

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
  // 缓存通过 API 拉取的 session 数据（sessions 列表中不存在的）
  const [fetchedSessions, setFetchedSessions] = useState<Record<string, ApiSession>>({})
  // 防止 busySessions 等数组引用抖动时 cancel+重拉，导致 /session 风暴
  const inflightSessionIdsRef = useRef(new Set<string>())
  const failedSessionIdsRef = useRef(new Set<string>())

  // 为 active sessions 构建 sessionId -> ApiSession 的查找表
  const sessionLookup = useMemo(() => {
    const map = new Map<string, ApiSession>()
    for (const s of sessions) {
      map.set(s.id, s)
    }
    // fetchedSessions 作为补充（其他项目的 session）
    for (const [id, s] of Object.entries(fetchedSessions)) {
      if (!map.has(id)) {
        map.set(id, s)
      }
    }
    return map
  }, [sessions, fetchedSessions])

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

  // 切服务器时清空跨目录 fetch 缓存，避免串服
  useEffect(() => {
    return serverStore.onServerChange(() => {
      setFetchedSessions({})
      inflightSessionIdsRef.current.clear()
      failedSessionIdsRef.current.clear()
    })
  }, [])

  // 需要补全的 session 集合：用内容 key 稳定，避免 busySessions 数组引用抖动触发重拉
  const missingSessionsKey = useMemo(() => {
    const byId = new Map<string, { sessionId: string; directory?: string; pinned?: boolean }>()
    const add = (sessionId: string, directory?: string, pinned?: boolean) => {
      if (sessionLookup.has(sessionId)) return
      const existing = byId.get(sessionId)
      if (existing) {
        byId.set(sessionId, {
          sessionId,
          directory: existing.directory || directory,
          pinned: existing.pinned || pinned,
        })
        return
      }
      byId.set(sessionId, { sessionId, directory, pinned })
    }

    for (const entry of busySessions) add(entry.sessionId, entry.directory)
    for (const entry of notifications) add(entry.sessionId, entry.directory)
    for (const entry of pinnedEntries) add(entry.sessionId, entry.directory, true)
    if (selectedSessionId) add(selectedSessionId, currentDirectory || undefined)

    return Array.from(byId.values())
      .map(e => `${e.sessionId}\0${e.directory ?? ''}\0${e.pinned ? '1' : '0'}`)
      .sort()
      .join('|')
  }, [busySessions, notifications, pinnedEntries, sessionLookup, selectedSessionId, currentDirectory])

  // 异步拉取不在 lookup 中的 active/notification/pinned/selected session
  useEffect(() => {
    const neededIds = new Set<string>()
    const missing: Array<{ sessionId: string; directory?: string; pinned?: boolean }> = []

    if (missingSessionsKey) {
      for (const token of missingSessionsKey.split('|')) {
        const [sessionId, directory, pinned] = token.split('\0')
        if (!sessionId) continue
        neededIds.add(sessionId)
        if (sessionLookup.has(sessionId)) continue
        if (inflightSessionIdsRef.current.has(sessionId)) continue
        if (failedSessionIdsRef.current.has(sessionId)) continue
        missing.push({
          sessionId,
          directory: directory || undefined,
          pinned: pinned === '1',
        })
      }
    }

    // 不再需要的失败记录清掉，session 再次出现时允许重试
    for (const sessionId of [...failedSessionIdsRef.current]) {
      if (!neededIds.has(sessionId)) failedSessionIdsRef.current.delete(sessionId)
    }

    if (missing.length === 0) return

    for (const entry of missing) {
      inflightSessionIdsRef.current.add(entry.sessionId)
    }

    void Promise.allSettled(
      missing.map(async entry => {
        try {
          const session = await getSession(entry.sessionId, entry.directory)
          inflightSessionIdsRef.current.delete(entry.sessionId)
          setFetchedSessions(prev => (prev[session.id] ? prev : { ...prev, [session.id]: session }))
          if (entry.pinned) {
            pinnedSessionsStore.update(session.id, {
              directory: session.directory || entry.directory,
              title: session.title || session.id.slice(0, 12) + '...',
            })
          }
        } catch {
          inflightSessionIdsRef.current.delete(entry.sessionId)
          // 失败只记一次，避免 SSE/busy 抖动时无限重试 /session
          failedSessionIdsRef.current.add(entry.sessionId)
        }
      }),
    )
  }, [missingSessionsKey, sessionLookup])

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

  const buildProjectGroups = useCallback(
    (directories: typeof savedDirectories): ProjectItem[] => {
      const savedNameByPath = new Map(
        directories.map(directory => [normalizeToForwardSlash(directory.path), directory.name]),
      )
      const savedAddedAtByPath = new Map(
        directories.map(directory => [normalizeToForwardSlash(directory.path), directory.addedAt]),
      )
      const groups = new Map<string, ProjectItem>()

      for (const directory of directories) {
        const normalizedDirectory = normalizeToForwardSlash(directory.path)
        const meta = gitWorkspaceCatalog.get(normalizedDirectory)
        const { projectId, workspaceDirectories } = getProjectGroupIdentity(normalizedDirectory, meta)
        const existing = groups.get(projectId)

        if (existing) {
          groups.set(projectId, {
            ...existing,
            memberDirectories: [...(existing.memberDirectories ?? []), directory.path],
            reorderPath: existing.reorderPath ?? directory.path,
          })
          continue
        }

        groups.set(projectId, {
          id: projectId,
          worktree: projectId,
          name: savedNameByPath.get(projectId) ?? getDirectoryName(projectId),
          canReorder: true,
          memberDirectories: [directory.path],
          reorderPath: directory.path,
          workspaceDirectories,
          addedAt: savedAddedAtByPath.get(projectId),
        })
      }

      return Array.from(groups.values()).map(project => {
        if (!project.workspaceDirectories?.length) return project

        const savedWorkspaceDirectories = (project.memberDirectories ?? [])
          .map(directory => normalizeToForwardSlash(directory))
          .filter(directory => project.workspaceDirectories?.some(workspace => isSameDirectory(workspace, directory)))

        const remainingWorkspaceDirectories = project.workspaceDirectories.filter(
          workspace => !savedWorkspaceDirectories.some(directory => isSameDirectory(directory, workspace)),
        )

        return {
          ...project,
          workspaceDirectories: [...savedWorkspaceDirectories, ...remainingWorkspaceDirectories],
        }
      })
    },
    [gitWorkspaceCatalog],
  )

  const folderProjectGroups = useMemo<ProjectItem[]>(() => {
    return buildProjectGroups(visibleSavedDirectories)
  }, [buildProjectGroups, visibleSavedDirectories])

  const globalProject = useMemo<ProjectItem>(
    () => ({
      id: 'global',
      worktree: t('sidebar.allProjects'),
      name: t('sidebar.global'),
    }),
    [t],
  )

  const currentProject = useMemo<ProjectItem>(() => {
    if (!currentDirectory) return globalProject

    const groupedProject = findProjectGroupForDirectory(folderProjectGroups, normalizedCurrentDirectory!)
    if (groupedProject) return groupedProject

    const meta = gitWorkspaceCatalog.get(normalizedCurrentDirectory!)
    const { projectId, workspaceDirectories } = getProjectGroupIdentity(normalizedCurrentDirectory!, meta)
    const found = findProjectGroupForDirectory(folderProjectGroups, projectId)
    if (found) return found

    return {
      id: projectId,
      worktree: projectId,
      name: getDirectoryName(projectId),
      canReorder: false,
      isDerived: true,
      memberDirectories: [],
      workspaceDirectories,
    }
  }, [currentDirectory, folderProjectGroups, gitWorkspaceCatalog, globalProject, normalizedCurrentDirectory])

  // 当前激活项目 = 服务器当前 worktree（pathInfo）。仅当是真实目录时自动置顶；
  // 根 worktree（global 项目）不展示 —— 用户明确不要「全局」文件夹
  const serverCurrentProject = useMemo<ProjectItem | null>(() => {
    const raw = pathInfo?.worktree
    if (!raw) return null
    const worktree = normalizeToForwardSlash(raw)
    if (!worktree || worktree === '/') return null
    return {
      id: worktree,
      worktree,
      name: getDirectoryName(worktree) || worktree,
      canReorder: false,
      isDerived: true,
    }
  }, [pathInfo])

  const folderProjects = useMemo<ProjectItem[]>(() => {
    const list: ProjectItem[] = []
    // 已保存项目（当前主机的 per-server 列表）；根路径（global 项目，归一化后为空）不展示「全局」文件夹
    const nonRootGroups = folderProjectGroups.filter(project => normalizeToForwardSlash(project.worktree || '') !== '')
    // 当前激活项目（真实目录）置顶，与已保存项目重复时不重复添加
    if (
      serverCurrentProject &&
      !nonRootGroups.some(project => isSameDirectory(project.worktree, serverCurrentProject.worktree))
    ) {
      list.push(serverCurrentProject)
    }
    list.push(...nonRootGroups)

    if (currentDirectory && !list.some(project => isSameDirectory(project.worktree, currentProject.worktree))) {
      list.push({ ...currentProject, canReorder: false })
    }

    // 不展示「全局」文件夹：全局把所有会话堆在一起条目多且卡，用户只按项目打开会话。
    // 显示顺序由 savedDirectories 自身的顺序决定（拖拽重排即写回该列表）。
    return list
  }, [serverCurrentProject, folderProjectGroups, currentDirectory, currentProject])

  // ---- 项目行展开/收起（跨端对齐）----
  // 状态存在 layoutStore 里，键是「项目名」而非 id：id 通常是 worktree 绝对路径
  // （含盘符），跨设备不可比；项目名两端一致，才能让展开状态在多端对齐。
  // 这里把它映射回当前端的项目 id 供列表消费。
  const expandedProjectNames = useLayoutStore().sidebarExpandedProjects
  const expandedRecentProjectIds = useMemo(
    () => folderProjects.filter(p => expandedProjectNames.includes(projectExpandKey(p))).map(p => p.id),
    [folderProjects, expandedProjectNames],
  )
  // 全部可展开项目是否都已收起：驱动「收起优先」的切换按钮。
  // 默认点击收起全部；只有全部已收起时，按钮才转为「展开全部」。
  // 派生项目（isDerived，未保存的当前项目）不参与，与自动展开逻辑保持一致。
  const allProjectIds = useMemo(() => folderProjects.filter(p => !p.isDerived).map(p => p.id), [folderProjects])
  const allProjectsCollapsed = useMemo(
    () => allProjectIds.length > 0 && allProjectIds.every(id => !expandedRecentProjectIds.includes(id)),
    [allProjectIds, expandedRecentProjectIds],
  )
  const setExpandedRecentProjectIds = useCallback(
    (updater: SetStateAction<string[]>) => {
      const currentIds = folderProjects.filter(p => expandedProjectNames.includes(projectExpandKey(p))).map(p => p.id)
      const nextIds = typeof updater === 'function' ? updater(currentIds) : updater
      const nextNames = nextIds
        .map(id => folderProjects.find(p => p.id === id))
        .filter((p): p is ProjectItem => !!p)
        .map(projectExpandKey)

      // 项目列表尚未加载时一律不写回：此刻映射必然为空，会把存储里真实的展开状态
      // 清空（启动阶段 FolderRecentList 的 reconcile 会触发一次回调），
      // 随后同步拉取又用服务端值覆盖，用户看到的展开状态就随机变化。
      if (folderProjects.length === 0) return

      // 只替换「属于当前服务器」的那部分名字，保留其它服务器的展开项。
      // 存储是全局单键、项目列表按服务器分区：整体覆盖会清掉别的服务器的展开
      // 状态，切回去就变成「全部收起」。
      const currentNames = folderProjects.map(projectExpandKey)
      layoutStore.setSidebarExpandedProjects(mergeExpandedProjectNames(expandedProjectNames, currentNames, nextNames))
    },
    [folderProjects, expandedProjectNames],
  )

  // 新添加/新保存的项目自动展开。
  //
  // 基线按服务器记录：切换服务器时整份项目列表都会换掉，若只存一份 id 列表，
  // 另一台的项目会被当成「新增项目」而全部展开（用户报的「切换服务器后全部
  // 都展开了」）。按服务器存基线后，只有「同一台服务器内新增的项目」才自动展开。
  const prevFolderProjectIdsRef = useRef<{ serverId: string; ids: string[] } | null>(null)
  useEffect(() => {
    const ids = folderProjects.filter(project => !project.isDerived).map(project => project.id)
    const prev = prevFolderProjectIdsRef.current
    prevFolderProjectIdsRef.current = { serverId: activeServerId, ids }
    if (!prev || prev.serverId !== activeServerId) return

    const added = ids.filter(id => !prev.ids.includes(id))
    if (added.length > 0) {
      setExpandedRecentProjectIds(current => {
        const missing = added.filter(id => !current.includes(id))
        return missing.length > 0 ? [...current, ...missing] : current
      })
    }
  }, [folderProjects, setExpandedRecentProjectIds, activeServerId])

  const workspaceDirectoriesByProjectId = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const project of folderProjects) {
      if (project.workspaceDirectories && project.workspaceDirectories.length > 1) {
        map.set(project.id, project.workspaceDirectories)
      }
    }
    return map
  }, [folderProjects])

  const allDisplayedProjects = useMemo(() => {
    return [...folderProjects]
  }, [folderProjects])

  // 锚点变化版本：用户发送/加载会话时触发器通知，用于实时重算项目顺序与时间。
  const activityVersion = useSyncExternalStore(
    cb => sessionActivityStore.subscribe(() => cb()),
    () => sessionActivityStore.getVersion(),
    () => sessionActivityStore.getVersion(),
  )

  // ---- 项目行「最后对话时间」----
  // 优先用会话活动锚点（用户最后一条消息时间，实时、单调）；冷启动时回退到
  // 服务端按目录拉取的最大会话时间；再兜底本地点击记录（recentProjects）。
  const uncoveredProjectWorktrees = useMemo(
    () => allDisplayedProjects.map(project => normalizeToForwardSlash(project.worktree || '')).filter(Boolean),
    [allDisplayedProjects],
  )
  const fetchedProjectLastUsed = useProjectLastUsedAt(activeServerId, uncoveredProjectWorktrees, true)

  const projectLastUsedAt = useMemo(() => {
    return mergeProjectLastUsed(uncoveredProjectWorktrees, recentProjects, fetchedProjectLastUsed, worktree =>
      sessionActivityStore.getDirectoryAnchor(activeServerId, worktree),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentProjects, fetchedProjectLastUsed, uncoveredProjectWorktrees, activeServerId, activityVersion])

  /**
   * 项目（文件夹）的最终显示顺序：始终自动排序，不保留手动拖拽顺序。
   *
   * created：按项目保存时间（稳定值）；updated：按最后一次对话时间（默认）。
   * 时间缺失的项目排到末尾（created 下派生项目无 addedAt，自然沉底）。
   */
  const sortedFolderProjects = useMemo(() => {
    return sortProjects(folderProjects, sidebarProjectSortField, projectLastUsedAt, sidebarProjectSortDesc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    folderProjects,
    projectLastUsedAt,
    sidebarProjectSortField,
    sidebarProjectSortDesc,
    activityVersion,
  ])

  // 需求 3：点击项目目录/名称不跳转（只展开/收起），只有点击会话才导航。
  // 保持签名兼容 FolderRecentList 的 onSelectProject 调用，但不再 setCurrentDirectory。
  const handleSelectFolderProject = useCallback((_project: ProjectItem) => {}, [])

  const getProjectDirectoriesToRemove = useCallback(
    (projectId: string) => {
      const project = allDisplayedProjects.find(item => isSameDirectory(item.id, projectId))
      return project?.memberDirectories?.length ? project.memberDirectories : [projectId]
    },
    [allDisplayedProjects],
  )

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
    setSelectedSessionIds(new Set())
    sessionSelectionAnchorIdRef.current = null
    setBatchDeleteSessionConfirm(false)
    setIsBatchDeleting(false)

    if (needSwitchSession) {
      onNewSession()
    }
  }, [selectedSessionIds, selectedSessionId, sessionLookup, currentDirectory, refresh, onNewSession])

  // ---- 批量移除项目 ----
  const handleBatchRemoveProjects = useCallback(() => {
    if (selectedProjectIds.size === 0) return
    for (const projectId of selectedProjectIds) {
      getProjectDirectoriesToRemove(projectId).forEach(directory => removeDirectory(directory))
    }
    setSelectedProjectIds(new Set())
    projectSelectionAnchorIdRef.current = null
    setBatchRemoveProjectConfirm(false)
  }, [getProjectDirectoriesToRemove, selectedProjectIds, removeDirectory])

  // 单个项目移除：二次点击防误触（按钮层），这里直接执行。
  // 语义唯一：从「已保存项目」列表移除，不动磁盘文件、不动会话；随时可重新添加。
  //
  // 派生项目（当前打开的目录 / 从会话推导的目录，未显式保存）直接跳过：
  // 它不在已保存列表里，removeDirectory 是空操作，却会因为清掉 URL 目录而
  // 表现为「点移除把当前项目关了」，属于误导性反馈。
  const handleRemoveProjectClick = useCallback(
    (project: FolderRecentProject) => {
      if (project.isDerived) return
      getProjectDirectoriesToRemove(project.id).forEach(directory => removeDirectory(directory))
    },
    [getProjectDirectoriesToRemove, removeDirectory],
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
            <a href="/" className="flex items-center whitespace-nowrap h-full">
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
                      setExpandedRecentProjectIds(allProjectsCollapsed ? allProjectIds : [])
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
            ref={recentsSelectionRootRef}
            key={activeServerId}
            className={`flex-1 overflow-hidden ${hostSlide || 'animate-in fade-in duration-150'} ${isEditMode ? 'select-none' : ''}`}
          >
            <FolderRecentList
              projects={sortedFolderProjects}
              {...commonFolderRecentListProps}
              onReorderProject={handleReorderProjectGroup}
              workspaceDirectoriesByProjectId={workspaceDirectoriesByProjectId}
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
