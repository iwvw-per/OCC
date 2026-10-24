import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { updateSession, type ApiSession } from '../../../api'
import {
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GlobeIcon,
  PinIcon,
  ChevronDownIcon,
  PlusIcon,
  TrashIcon,
  CheckIcon,
  ExternalLinkIcon,
} from '../../../components/Icons'
import { ExpandableSection, Spinner } from '../../../components/ui'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { useDelayedRender, useSessions, useVcsInfo } from '../../../hooks'
import { useInputCapabilities } from '../../../hooks/useInputCapabilities'
import { useInView } from '../../../hooks/useInView'
import { useDirectory } from '../../../contexts/useDirectory'
import { getDirectoryName, normalizeToForwardSlash } from '../../../utils'
import { formatRelativeDay } from '../../../utils/dateUtils'
import { layoutStore, useLayoutStore } from '../../../store'
import { canOpenDirectoryNatively } from '../../../utils/nativeFileIntegration'
import { isTauri, isTauriMobile } from '../../../utils/tauri'
import { uiErrorHandler } from '../../../utils'
import { useBusySessions, activeSessionStore } from '../../../store/activeSessionStore'
import { makeSessionKey, splitSessionKey } from '../../../utils/sessionKey'
import { notificationStore, useNotifications } from '../../../store/notificationStore'
import { pinnedSessionsStore, type PinnedSessionEntry } from '../../../store/pinnedSessionsStore'
import { serverStore } from '../../../store/serverStore'
import { sessionListIndexStore } from '../../../store/sessionListIndexStore'
import { SessionListItem } from '../../sessions'
import { getSelectionRoundClass } from '../../sessions/selectionRound'
import { SessionChildrenSlot } from './SessionChildrenSlot'
import { ProjectContextMenu } from './ProjectContextMenu'
import { buildFolderStatus, type FolderStatus } from './folderStatus'
import { cn } from '../../../utils/cn'
import {
  reconcileExpandedProjectIds,
  toggleProjectId,
  useCollapseExpandedIdsOnDrag,
  useReorderableList,
} from './useFolderList'
import { interactive } from '../../../utils/interaction'
import { hapticTap } from '../../../utils/haptics'

const DIRECTORY_PAGE_SIZE = 5

/** 长项目名：溢出时右侧渐隐（替代生硬的 ellipsis 截断），不 hover 也生效 */
function ProjectNameTitle({ text, className = '' }: { text: string; className?: string }) {
  const spanRef = useRef<HTMLSpanElement>(null)
  const [overflows, setOverflows] = useState(false)

  useEffect(() => {
    const el = spanRef.current
    if (!el) return
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  return (
    <span
      ref={spanRef}
      className={`min-w-0 flex-1 whitespace-nowrap text-[length:var(--fs-sm)] font-semibold optical-center ${
        overflows ? 'name-fade-right overflow-hidden' : 'truncate'
      } ${className}`}
    >
      {text}
    </span>
  )
}

export interface FolderRecentProject {
  id: string
  name: string
  worktree: string
  canReorder?: boolean
  memberDirectories?: string[]
  sectionKind?: 'project' | 'workspace'
  /** 推导项目（无已保存工作区时自动生成）：隐藏移除按钮，避免对未存储目录执行无效移除 */
  isDerived?: boolean
}

interface FolderRecentListProps {
  projects: FolderRecentProject[]
  /** 数据服务器（多服务器模式；缺省用活动服务器） */
  serverId?: string
  /** 嵌套模式（多服务器服务器节点下）：外层负责滚动，本组件不设滚动容器/内边距 */
  embedded?: boolean
  currentDirectory?: string
  selectedSessionId: string | null
  expandedProjectIds: string[]
  onExpandedProjectIdsChange: React.Dispatch<React.SetStateAction<string[]>>
  onSelectProject: (project: FolderRecentProject) => void
  onSelectSession: (session: ApiSession) => void
  onRenameSession: (session: ApiSession, newTitle: string) => Promise<void>
  onDeleteSession: (session: ApiSession) => Promise<void>
  /** 会话标题等元数据在右键菜单中被外部修改后触发刷新 */
  onSessionChanged?: () => void
  onReorderProject: (draggedPath: string, targetPath: string) => void
  /** 项目行 hover 的 + 按钮：在该项目目录下新建会话（无目录的项目（全局）不显示） */
  onNewSessionInDirectory?: (directory: string) => void
  /** 移除项目（从侧栏列表移除，不删文件） */
  onRemoveProject?: (project: FolderRecentProject) => void
  /** worktree → 最后使用时间戳（服务端会话数据 + 本地记录合并）；缺省退回 useDirectory 的 recentProjects */
  projectLastUsedAt?: Record<string, number>
  expandedChildSessionIds?: Set<string>
  inlineChildSessions?: Map<string, ApiSession[]>
  onSelectChildSession?: (session: ApiSession) => void
  workspaceDirectoriesByProjectId?: Map<string, string[]>
  pinnedSessions?: ApiSession[]
  unavailablePinnedEntries?: PinnedSessionEntry[]
  /** 就地筛选：匹配项目名或会话标题/目录；无匹配的项目隐藏 */
  search?: string
  // ---- 编辑模式 ----
  isEditMode?: boolean
  selectedSessionIds?: Set<string>
  selectedProjectIds?: Set<string>
  onToggleSessionSelection?: (sessionId: string, options?: { shiftKey?: boolean }) => void
  onToggleProjectSelection?: (projectId: string, options?: { shiftKey?: boolean }) => void
}

interface PendingDeleteSession {
  session: ApiSession
  removeLocal: () => void
}

export function FolderRecentList({
  projects,
  serverId,
  embedded = false,
  currentDirectory,
  selectedSessionId,
  expandedProjectIds,
  onExpandedProjectIdsChange,
  onSelectProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onSessionChanged,
  onReorderProject,
  onNewSessionInDirectory,
  onRemoveProject,
  projectLastUsedAt,
  expandedChildSessionIds,
  inlineChildSessions,
  onSelectChildSession,
  workspaceDirectoriesByProjectId,
  pinnedSessions = [],
  unavailablePinnedEntries = [],
  isEditMode = false,
  selectedSessionIds,
  selectedProjectIds,
  onToggleSessionSelection,
  onToggleProjectSelection,
  search = '',
}: FolderRecentListProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { preferTouchUi } = useInputCapabilities()
  const { sidebarFolderRecentsShowDiff } = useLayoutStore()
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteSession | null>(null)
  const [isDeletingSession, setIsDeletingSession] = useState(false)
  const allBusySessions = useBusySessions()
  const allNotifications = useNotifications()
  // 项目行状态按服务器收窄：缺省用活动服务器（多服务器模式由 SidePanel 显式传入）
  const statusServerId = serverId ?? serverStore.getActiveServerId()
  const projectById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects])
  const { handleDragActivated, handleDragFinished } = useCollapseExpandedIdsOnDrag(
    expandedProjectIds,
    onExpandedProjectIdsChange,
  )

  // 当 projects 列表变化时，过滤掉已不存在的展开项。
  //
  // 不再「确保当前目录对应项目展开」：展开状态是跨端同步的，强制展开当前项目
  // 会把它写回存储，污染其它设备的展开状态（表现为「收起后又被自动展开」、
  // 「同步来的状态被本地覆盖」）。当前项目的展开交给用户操作或存储里的值决定。
  useEffect(() => {
    onExpandedProjectIdsChange(prev => reconcileExpandedProjectIds(prev, projects))
  }, [projects, currentDirectory, onExpandedProjectIdsChange])

  const handleToggleProject = useCallback(
    (projectId: string) => onExpandedProjectIdsChange(prev => toggleProjectId(prev, projectId)),
    [onExpandedProjectIdsChange],
  )

  const {
    dragState,
    handlePointerDown,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    registerRef,
  } = useReorderableList({
    ids: projects.map(project => project.id),
    // 项目列表始终按最后对话时间自动排序，不再支持拖拽重排
    canDrag: () => false,
    onCommit: (draggedId, targetId) => {
      const draggedProject = projectById.get(draggedId)
      const targetProject = projectById.get(targetId)
      if (!draggedProject?.canReorder || !targetProject?.canReorder) return
      onReorderProject(draggedProject.id, targetProject.id)
    },
    onDragActivated: handleDragActivated,
    onDragFinished: handleDragFinished,
  })
  const draggedId = dragState?.draggedId ?? null
  const isDragging = dragState !== null
  const displayOrder = dragState?.currentOrder ?? projects.map(project => project.id)

  const handleSelectDirectory = useCallback(
    (directory: string, sectionKind: FolderRecentProject['sectionKind'] = 'project') => {
      onSelectProject({ id: directory, worktree: directory, name: getDirectoryName(directory) || directory, sectionKind })
    },
    [onSelectProject],
  )

  const folderStatusByProjectId = useMemo(() => {
    const map = new Map<string, FolderStatus>()

    for (const project of projects) {
      const isProjectExpanded = !isDragging && expandedProjectIds.includes(project.id)
      if (isProjectExpanded) continue

      const statusDirectories = workspaceDirectoriesByProjectId?.get(project.id) ?? [project.worktree]
      const status = buildFolderStatus({
        serverId: statusServerId,
        directories: statusDirectories,
        busySessions: allBusySessions,
        notifications: allNotifications,
        t,
      })
      if (status) map.set(project.id, status)
    }

    return map
  }, [
    projects,
    expandedProjectIds,
    isDragging,
    allBusySessions,
    allNotifications,
    t,
    workspaceDirectoriesByProjectId,
    statusServerId,
  ])

  /**
   * 用户展开某个项目时，把该项目（该服务器）下的未读通知一次性清掉。
   *
   * 为什么需要：未读点按 directory 汇总，但清理只能靠点击会话行；会话一旦
   * 不在可见范围（分页只加载前几条、已归档、被别的客户端删除、子会话不在列表）
   * 就没有入口可点，项目行会永久亮着，展开也找不到是哪个会话。展开即视为
   * 用户已看过这个项目的更新。
   *
   * 只在「用户主动展开」时清，且搜索态强制展开不算（否则一打字就清空所有未读）。
   * 用前一次展开集合做差，只处理新展开的 id，避免每次列表重渲染重复清理。
   */
  const prevExpandedIdsRef = useRef<string[] | null>(null)
  useEffect(() => {
    const prev = prevExpandedIdsRef.current
    prevExpandedIdsRef.current = expandedProjectIds
    // 首次建立基线、拖拽中临时清空、搜索态强制展开都不做清理
    if (!prev || isDragging || search) return

    for (const project of projects) {
      if (!expandedProjectIds.includes(project.id) || prev.includes(project.id)) continue
      const directories = workspaceDirectoriesByProjectId?.get(project.id) ?? [project.worktree]
      notificationStore.markDirectoryNotificationsRead(statusServerId, directories, 'completed')
    }
  }, [expandedProjectIds, projects, workspaceDirectoriesByProjectId, statusServerId, isDragging, search])

  return (
    <>
      <div
        className={`custom-scrollbar select-none ${embedded ? '' : 'h-full overflow-y-auto px-1.5 py-1'}`}
      >
        {projects.length === 0 && pinnedSessions.length === 0 && unavailablePinnedEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-text-400 opacity-70">
            <p className="text-[length:var(--fs-sm)] font-medium text-text-300">{t('sidebar.noProjectFoldersYet')}</p>
            <p className="mt-1 text-[length:var(--fs-xs)] text-text-400/70">{t('sidebar.addProjectDesc')}</p>
          </div>
        ) : (
          <div onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
            {(pinnedSessions.length > 0 || unavailablePinnedEntries.length > 0) && (
              <PinnedFolderSection
                sessions={pinnedSessions}
                unavailableEntries={unavailablePinnedEntries}
                selectedSessionId={selectedSessionId}
                preferTouchUi={preferTouchUi}
                showSessionDiffStats={sidebarFolderRecentsShowDiff}
                onSelectSession={onSelectSession}
                onRenameSession={onRenameSession}
                onRequestDeleteSession={setPendingDelete}
                onSessionChanged={onSessionChanged}
                expandedChildSessionIds={expandedChildSessionIds}
                inlineChildSessions={inlineChildSessions}
                onSelectChildSession={onSelectChildSession}
                isEditMode={isEditMode}
                selectedSessionIds={selectedSessionIds}
                onToggleSessionSelection={onToggleSessionSelection}
              />
            )}
            {displayOrder.map((projectId, index) => {
              const project = projectById.get(projectId)
              if (!project) return null
              const isExpanded = !isDragging && expandedProjectIds.includes(project.id)
              const isProjectChecked = selectedProjectIds?.has(project.id) ?? false
              const prevId = index > 0 ? displayOrder[index - 1] : null
              const nextId = index < displayOrder.length - 1 ? displayOrder[index + 1] : null
              const nextProjectChecked = !!nextId && (selectedProjectIds?.has(nextId) ?? false)
              // 折叠时：和相邻文件夹拼接；展开时：和首条 session 的拼接在 section 内部处理
              const prevExpanded =
                !!prevId && !isDragging && expandedProjectIds.includes(prevId)
              const projectCheckedPrev =
                isEditMode &&
                isProjectChecked &&
                !!prevId &&
                !prevExpanded &&
                (selectedProjectIds?.has(prevId) ?? false)
              const projectCheckedNext =
                isEditMode &&
                isProjectChecked &&
                !!nextId &&
                !isExpanded &&
                nextProjectChecked
              return (
                <FolderRecentSection
                  key={project.id}
                  project={project}
                  serverId={serverId}
                  isExpanded={isExpanded}
                  search={search}
                  folderStatus={folderStatusByProjectId.get(project.id) ?? null}
                  preferTouchUi={preferTouchUi}
                  showSessionDiffStats={sidebarFolderRecentsShowDiff}
                  selectedSessionId={selectedSessionId}
                  onSelectProject={() => handleSelectDirectory(project.worktree, project.sectionKind)}
                  onNewSessionInDirectory={onNewSessionInDirectory}
                  onRemoveProject={onRemoveProject}
                  projectLastUsedAt={projectLastUsedAt}
                  onToggle={() => handleToggleProject(project.id)}
                  onSelectSession={onSelectSession}
                  onRenameSession={onRenameSession}
                  onRequestDeleteSession={setPendingDelete}
                  expandedChildSessionIds={expandedChildSessionIds}
                  inlineChildSessions={inlineChildSessions}
                  onSelectChildSession={onSelectChildSession}
                  workspaceDirectories={workspaceDirectoriesByProjectId?.get(project.id)}
                  sectionKind={project.sectionKind ?? 'project'}
                  // 拖拽
                  canDrag={!!project.canReorder && !isEditMode}
                  isDragged={draggedId === project.id}
                  onDragStart={e => handlePointerDown(project.id, e)}
                  onTouchDragStart={e => handleTouchStart(project.id, e)}
                  registerRef={el => registerRef(project.id, el)}
                  // 编辑模式
                  isEditMode={isEditMode}
                  isProjectChecked={isProjectChecked}
                  projectCheckedPrev={projectCheckedPrev}
                  projectCheckedNext={projectCheckedNext}
                  nextProjectChecked={isEditMode && nextProjectChecked}
                  onToggleProjectCheck={
                    onToggleProjectSelection ? options => onToggleProjectSelection(project.id, options) : undefined
                  }
                  selectedSessionIds={selectedSessionIds}
                  onToggleSessionSelection={onToggleSessionSelection}
                />
              )
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!pendingDelete}
        onClose={() => {
          if (isDeletingSession) return
          setPendingDelete(null)
        }}
        onConfirm={async () => {
          if (pendingDelete) {
            setIsDeletingSession(true)
            try {
              await onDeleteSession(pendingDelete.session)
              pendingDelete.removeLocal()
            } finally {
              setIsDeletingSession(false)
            }
          }
          setPendingDelete(null)
        }}
        title={t('sidebar.deleteChat')}
        description={t('sidebar.deleteChatConfirm')}
        confirmText={t('common:delete')}
        variant="danger"
        isLoading={isDeletingSession}
      />
    </>
  )
}

// ============================================
// Folder Section
// ============================================

interface PinnedFolderSectionProps {
  sessions: ApiSession[]
  unavailableEntries: PinnedSessionEntry[]
  selectedSessionId: string | null
  preferTouchUi: boolean
  showSessionDiffStats: boolean
  onSelectSession: (session: ApiSession) => void
  onRenameSession: (session: ApiSession, newTitle: string) => Promise<void>
  onRequestDeleteSession: (pending: PendingDeleteSession) => void
  onSessionChanged?: () => void
  expandedChildSessionIds?: Set<string>
  inlineChildSessions?: Map<string, ApiSession[]>
  onSelectChildSession?: (session: ApiSession) => void
  isEditMode?: boolean
  selectedSessionIds?: Set<string>
  onToggleSessionSelection?: (sessionId: string, options?: { shiftKey?: boolean }) => void
}

function PinnedFolderSection({
  sessions,
  unavailableEntries,
  selectedSessionId,
  preferTouchUi,
  showSessionDiffStats,
  onSelectSession,
  onRenameSession,
  onRequestDeleteSession,
  onSessionChanged,
  expandedChildSessionIds,
  inlineChildSessions,
  onSelectChildSession,
  isEditMode,
  selectedSessionIds,
  onToggleSessionSelection,
}: PinnedFolderSectionProps) {
  const { t } = useTranslation(['commands', 'chat'])
  const [isExpanded, setIsExpanded] = useState(true)

  return (
    <div className="relative transition-all duration-150 group/folder mb-1.5 border-b border-border-200/40 pb-1.5">
      <div className={cn('relative flex w-full items-center rounded-md select-none', interactive.row)}>
        <button
          onClick={() => setIsExpanded(value => !value)}
          className="flex flex-1 min-w-0 items-center gap-2 pl-2 pr-2 py-1.5 text-left cursor-default select-none"
          title={t('sessions.pinned')}
        >
          <span className="size-5 shrink-0 flex items-center justify-center">
            <PinIcon size={15} className="text-accent-main-100" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)] font-medium text-text-300">
            {t('sessions.pinned')}
          </span>
        </button>
      </div>

      <ExpandableSection show={isExpanded}>
        <div onTouchStart={e => e.stopPropagation()} className="flex flex-col gap-0.5 pt-1">
          {sessions.map((session, index) => {
            const isChecked = selectedSessionIds?.has(session.id) ?? false
            const prevChecked =
              isEditMode && index > 0 && (selectedSessionIds?.has(sessions[index - 1].id) ?? false)
            const nextChecked =
              isEditMode &&
              index < sessions.length - 1 &&
              (selectedSessionIds?.has(sessions[index + 1].id) ?? false)
            return (
            <div key={session.id}>
              <SessionListItem
                session={session}
                isSelected={!!selectedSessionId && session.id === splitSessionKey(selectedSessionId).sessionId}
                onSelect={() => onSelectSession(session)}
                onRename={newTitle => onRenameSession(session, newTitle)}
                onDelete={() => onRequestDeleteSession({ session, removeLocal: () => {} })}
                onChanged={onSessionChanged}
                preferTouchUi={preferTouchUi}
                density="minimal"
                showStats={showSessionDiffStats}
                showDirectory={false}
                isEditMode={isEditMode}
                isChecked={isChecked}
                checkedPrev={prevChecked}
                checkedNext={nextChecked}
                onToggleCheck={
                  onToggleSessionSelection ? options => onToggleSessionSelection(session.id, options) : undefined
                }
              />
              {onSelectChildSession &&
                (expandedChildSessionIds?.has(session.id) || inlineChildSessions?.has(session.id)) && (
                  <SessionChildrenSlot
                    parentSession={session}
                    selectedSessionId={selectedSessionId}
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
          {unavailableEntries.map(entry => (
            <UnavailablePinnedSessionItem key={entry.sessionId} entry={entry} />
          ))}
        </div>
      </ExpandableSection>
    </div>
  )
}

function UnavailablePinnedSessionItem({ entry }: { entry: PinnedSessionEntry }) {
  const { t } = useTranslation(['commands'])
  const title = entry.title || entry.sessionId.slice(0, 12) + '...'
  // 对齐 minimal SessionListItem：单行布局，只把文字改灰
  return (
    <div className="group relative flex items-center gap-2 px-2 py-1.5 select-none text-text-500">
      <span className="relative shrink-0 flex items-center justify-center size-5" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-0 group-hover:pr-8 transition-[padding] duration-200">
        <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)] text-text-500 optical-center" title={title}>
          {title}
        </span>
        <span className="shrink-0 text-[length:var(--fs-xxs)] text-text-500 group-hover:hidden">
          {t('sessions.unavailable')}
        </span>
      </div>
      <button
        type="button"
        onClick={() => pinnedSessionsStore.unpin(entry.sessionId)}
        className={cn(
          'absolute right-2 z-10 p-1 rounded text-accent-main-100 hover:text-accent-main-200',
          'opacity-0 group-hover:opacity-100 transition-opacity',
          interactive.subtle,
        )}
        title={t('sessions.unpin')}
        aria-label={t('sessions.unpin')}
      >
        <PinIcon className="w-3 h-3" />
      </button>
    </div>
  )
}

interface FolderRecentSectionProps {
  project: FolderRecentProject
  /** 数据服务器（多服务器模式；缺省用活动服务器） */
  serverId?: string
  isExpanded: boolean
  /** 就地筛选：匹配项目名或会话标题/目录；无匹配的项目隐藏 */
  search?: string
  folderStatus: FolderStatus | null
  preferTouchUi: boolean
  showSessionDiffStats: boolean
  selectedSessionId: string | null
  onSelectProject: () => void
  onNewSessionInDirectory?: (directory: string) => void
  /** 移除项目（从侧栏列表移除，不删文件）；无目录的项目（全局）不显示按钮 */
  onRemoveProject?: (project: FolderRecentProject) => void
  /** worktree → 最后使用时间戳；缺省退回本机 recentProjects 记录 */
  projectLastUsedAt?: Record<string, number>
  onToggle: () => void
  onSelectSession: (session: ApiSession) => void
  onRenameSession: (session: ApiSession, newTitle: string) => Promise<void>
  onRequestDeleteSession: (pending: PendingDeleteSession) => void
  expandedChildSessionIds?: Set<string>
  inlineChildSessions?: Map<string, ApiSession[]>
  onSelectChildSession?: (session: ApiSession) => void
  workspaceDirectories?: string[]
  sectionKind?: 'project' | 'workspace'
  // 拖拽
  canDrag: boolean
  isDragged: boolean
  onDragStart: (e: React.PointerEvent) => void
  onTouchDragStart: (e: React.TouchEvent) => void
  registerRef: (el: HTMLDivElement | null) => void
  // ---- 编辑模式 ----
  isEditMode?: boolean
  isProjectChecked?: boolean
  /** 上一项也选中时，去掉上圆角 */
  projectCheckedPrev?: boolean
  /** 下一项也选中时，去掉下圆角（折叠时连下一个文件夹） */
  projectCheckedNext?: boolean
  /** 下一个文件夹已选中：展开时最后一条 session 可与其拼接 */
  nextProjectChecked?: boolean
  onToggleProjectCheck?: (options?: { shiftKey?: boolean }) => void
  selectedSessionIds?: Set<string>
  onToggleSessionSelection?: (sessionId: string, options?: { shiftKey?: boolean }) => void
}

function FolderRecentSection({
  project,
  serverId,
  isExpanded,
  search = '',
  folderStatus,
  preferTouchUi,
  showSessionDiffStats,
  selectedSessionId,
  onSelectProject,
  onNewSessionInDirectory,
  onRemoveProject,
  projectLastUsedAt,
  onToggle,
  onSelectSession,
  onRenameSession,
  onRequestDeleteSession,
  expandedChildSessionIds,
  inlineChildSessions,
  onSelectChildSession,
  workspaceDirectories = [],
  sectionKind = 'project',
  canDrag,
  isDragged,
  onDragStart,
  onTouchDragStart,
  registerRef,
  isEditMode = false,
  isProjectChecked = false,
  projectCheckedPrev = false,
  projectCheckedNext = false,
  nextProjectChecked = false,
  onToggleProjectCheck,
  selectedSessionIds,
  onToggleSessionSelection,
}: FolderRecentSectionProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { ref: inViewRef, inView } = useInView({ rootMargin: '200px 0px', triggerOnce: true })
  const [hasActivated, setHasActivated] = useState(false)
  const shouldRenderBody = useDelayedRender(isExpanded)
  const hasWorkspaceTree = workspaceDirectories.length > 0
  const workspaceFallbackName = getDirectoryName(project.worktree) || project.worktree
  const isRemoteServer = !!serverId && serverId !== 'local'
  const { vcsInfo, isLoading: isBranchLoading } = useVcsInfo(
    isRemoteServer ? undefined : sectionKind === 'workspace' ? project.worktree : undefined,
  )
  const { recentProjects } = useDirectory()
  const normalizedWorktree = normalizeToForwardSlash(project.worktree || '')
  const lastUsedAt = projectLastUsedAt?.[normalizedWorktree] ?? recentProjects[normalizedWorktree]
  // 移除按钮二次点击防误触：第一次点击进入确认态，3 秒内再点才真正移除
  const [removeArmed, setRemoveArmed] = useState(false)
  const removeTimerRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
    }
  }, [])
  const handleRemoveClick = useCallback(() => {
    if (removeArmed) {
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
      removeTimerRef.current = null
      setRemoveArmed(false)
      onRemoveProject?.(project)
      return
    }
    setRemoveArmed(true)
    if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
    removeTimerRef.current = window.setTimeout(() => setRemoveArmed(false), 3000)
  }, [removeArmed, onRemoveProject, project])
  const disarmRemove = useCallback(() => {
    if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
    removeTimerRef.current = null
    setRemoveArmed(false)
  }, [])

  // 项目行右键 / 长按菜单：桌面右键、移动端长按（位置取触点坐标）。
  // 触摸端没有 hover，行内 hover 才出现的 + / 打开 / 移除按钮都够不到，
  // 长按菜单是这些操作的唯一入口。
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchMovedRef = useRef(false)
  // 长按弹出菜单后，抬手会补一个 click 命中行内按钮，需吞掉这一次点击，
  // 否则菜单打开的同时项目被展开/收起。
  const suppressClickRef = useRef(false)

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isEditMode || !project.worktree) return
      e.preventDefault()
      e.stopPropagation()
      setContextMenu({ x: e.clientX, y: e.clientY })
    },
    [isEditMode, project.worktree],
  )

  const handleProjectTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!preferTouchUi || isEditMode || !project.worktree) return
      const touch = e.touches[0]
      const x = touch?.clientX ?? 0
      const y = touch?.clientY ?? 0
      touchMovedRef.current = false
      suppressClickRef.current = false
      longPressTimer.current = setTimeout(() => {
        if (touchMovedRef.current) return
        suppressClickRef.current = true
        hapticTap('medium')
        setContextMenu({ x, y })
      }, 500)
    },
    [preferTouchUi, isEditMode, project.worktree],
  )

  const handleProjectTouchMove = useCallback(() => {
    touchMovedRef.current = true
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleProjectTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current)
    }
  }, [])

  const canOpenDirectory = isTauri() && !isTauriMobile() && !!project.worktree
  const handleOpenDirectory = useCallback(async () => {
    const directory = project.worktree
    if (!directory) return
    if (!(await canOpenDirectoryNatively(serverId, directory))) {
      layoutStore.openRightPanel('files')
      return
    }
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener')
      await openPath(directory)
    } catch (e) {
      uiErrorHandler('open project directory', e)
    }
  }, [project.worktree, serverId])

  const contextMenuNode = contextMenu ? (
    <ProjectContextMenu
      position={contextMenu}
      onClose={() => setContextMenu(null)}
      directory={project.worktree}
      onNewSession={
        onNewSessionInDirectory && project.worktree
          ? () => onNewSessionInDirectory(project.worktree)
          : undefined
      }
      onOpenDirectory={canOpenDirectory ? () => void handleOpenDirectory() : undefined}
      onRemove={
        onRemoveProject && project.worktree
          ? () => {
              disarmRemove()
              onRemoveProject(project)
            }
          : undefined
      }
    />
  ) : null

  useEffect(() => {
    if (isExpanded && inView) {
      setHasActivated(true)
    }
  }, [isExpanded, inView])

  const {
    sessions,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    loadMore,
    collapse,
    refresh,
    patchLocalSession,
    removeLocalSession,
  } =
  useSessions({
    // 有 workspace（git worktree）时聚合所有目录的会话，不区分分支层级；
    // 否则退回单目录。
    directories: hasWorkspaceTree ? workspaceDirectories : undefined,
    directory: project.worktree,
    pageSize: DIRECTORY_PAGE_SIZE,
    enabled: hasActivated,
    serverId,
  })
  const pinnedEntries = useSyncExternalStore(
    pinnedSessionsStore.subscribe,
    pinnedSessionsStore.getSnapshot,
    pinnedSessionsStore.getSnapshot,
  )
  const visibleSessions = useMemo(() => {
    const pinnedSet = new Set(pinnedEntries.map(entry => entry.sessionId))
    return sessions.filter(session => !pinnedSet.has(session.id))
  }, [pinnedEntries, sessions])

  const handleRename = useCallback(
    async (sessionId: string, newTitle: string) => {
      const session = sessions.find(item => item.id === sessionId)
      if (!session) return
      await onRenameSession(session, newTitle)
      patchLocalSession(sessionId, { title: newTitle })
    },
    [sessions, onRenameSession, patchLocalSession],
  )

  const handleDelete = useCallback(
    (sessionId: string) => {
      const session = sessions.find(item => item.id === sessionId)
      if (!session) return
      onRequestDeleteSession({
        session,
        removeLocal: () => removeLocalSession(sessionId),
      })
    },
    [sessions, onRequestDeleteSession, removeLocalSession],
  )

  // 归档：updateSession({ time: { archived: now } })，成功后本地移除并重新拉取
  const handleArchive = useCallback(
    async (sessionId: string) => {
      const session = sessions.find(item => item.id === sessionId)
      if (!session) return
      try {
        await updateSession(session.id, { time: { archived: Date.now() } }, session.directory, serverId)
        // 归档后会话不再出现在列表，通知也要清掉，否则项目行残留未读点
        notificationStore.removeSessionNotifications(sessionId)
        // 清活跃状态：否则「归档前正在跑」的会话会永久留在 busy 集合，
        // 项目行/会话行一直显示运行中。
        activeSessionStore.removeSession(makeSessionKey(serverId ?? serverStore.getActiveServerId(), sessionId))
        removeLocalSession(sessionId)
        // 让归档视图过期：否则「已归档」面板会继续显示归档前的快照，
        // 用户必须刷新页面才看得到刚归档的会话。
        sessionListIndexStore.invalidateArchivedView(serverId ?? serverStore.getActiveServerId())
        // 本地移除不会收敛分页上限：归档掉最后一条「多取的探针行」后，
        // hasMore 会停在 true，导致只剩 5 条也显示加载更多。重新拉取校准。
        await refresh()
      } catch {
        // 归档失败静默（由列表刷新兜底）
      }
    },
    [sessions, serverId, removeLocalSession, refresh],
  )

  const projectName =
    sectionKind === 'workspace'
      ? (vcsInfo?.branch ?? (isBranchLoading ? '...' : workspaceFallbackName))
      : project.name || workspaceFallbackName
  const FolderDisplayIcon =
    project.id === 'global'
      ? GlobeIcon
      : sectionKind === 'workspace'
        ? GitBranchIcon
        : isExpanded
          ? FolderOpenIcon
          : FolderIcon

  // 当前打开的会话是否属于这个项目：是则文件夹图标上主题色（描边 + 填充），
  // 用于在长列表里快速定位"正在看的是哪个项目"。
  // selectedSessionId 形如 `${serverId}::${sessionId}`（多服务器模式），
  // 与 sessions 里的裸 id 比对前要先剥掉前缀。
  const activeSessionRawId = selectedSessionId ? splitSessionKey(selectedSessionId).sessionId : null
  const isProjectActive = !!activeSessionRawId && sessions.some(session => session.id === activeSessionRawId)

  // 展开时：文件夹与首条 session 可拼成连续选中块
  const firstVisibleSessionChecked =
    isEditMode &&
    isExpanded &&
    !hasWorkspaceTree &&
    visibleSessions.length > 0 &&
    (selectedSessionIds?.has(visibleSessions[0].id) ?? false)
  const folderCheckedNext = projectCheckedNext || firstVisibleSessionChecked

  // 就地筛选：匹配项目名或已加载会话的标题/目录；无匹配的项目整体隐藏
  const searchTerms = useMemo(
    () => search.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [search],
  )
  const filteredSessions = useMemo(() => {
    if (searchTerms.length === 0) return visibleSessions
    return visibleSessions.filter(session =>
      searchTerms.some(term => {
        const title = (session.title || '').toLowerCase()
        const dir = (session.directory || '').toLowerCase()
        return title.includes(term) || dir.includes(term)
      }),
    )
  }, [visibleSessions, searchTerms])
  const projectMatchesSearch =
    searchTerms.length === 0 ||
    searchTerms.some(term => {
      const name = projectName.toLowerCase()
      const worktree = (project.worktree || '').toLowerCase()
      return name.includes(term) || worktree.includes(term)
    })
  if (searchTerms.length > 0 && !projectMatchesSearch && filteredSessions.length === 0) return null

  return (
    <div ref={inViewRef}>
      <div
        ref={registerRef}
        onTouchStart={canDrag ? onTouchDragStart : undefined}
        className={`relative transition-all duration-150 ${
          isDragged
            ? 'z-10 shadow-lg shadow-black/20 ring-1 ring-inset ring-accent-main-100/30 rounded-md bg-bg-100'
            : ''
        }`}
      >
        {/* 文件夹行 — 选中用圆角底，连续选中拼成一条；整行可直接拖拽重排（点击仍是展开/收起） */}
        <div
          onPointerDown={canDrag ? onDragStart : undefined}
          onContextMenu={handleContextMenu}
          onTouchStart={handleProjectTouchStart}
          onTouchMove={handleProjectTouchMove}
          onTouchEnd={handleProjectTouchEnd}
          onTouchCancel={handleProjectTouchEnd}
          className={cn(
            'group/folder relative flex w-full items-center transition-colors duration-150 select-none',
            getSelectionRoundClass(isEditMode && isProjectChecked, projectCheckedPrev, folderCheckedNext, 'md'),
            interactive.row,
            isEditMode && isProjectChecked && interactive.rowSelected,
          )}
          {...(isEditMode
            ? {
                'data-selection-kind': 'project' as const,
                'data-selection-id': project.id,
                'aria-selected': isProjectChecked,
              }
            : {})}
        >
          <button
            type="button"
            onMouseDown={e => {
              if (!isEditMode) return
              e.preventDefault()
              window.getSelection()?.removeAllRanges()
            }}
            onClick={e => {
              // 长按已弹出菜单：吞掉抬手补发的这次 click，避免菜单打开的同时展开/收起
              if (suppressClickRef.current) {
                suppressClickRef.current = false
                e.preventDefault()
                return
              }
              if (isEditMode) {
                // 管理模式：点文件夹 = 选中；Shift 点可范围选
                onToggleProjectCheck?.({ shiftKey: e.shiftKey })
                return
              }
              onSelectProject()
              onToggle()
            }}
            className={cn(
              // 触摸端加大上下内边距，行高从约 32px 提到约 44px，满足手指触控热区；
              // 桌面保持 py-1.5 的紧凑排布。
              'flex flex-1 min-w-0 items-center gap-1 pl-2 pr-2 text-left cursor-default select-none rounded-md',
              preferTouchUi ? 'py-3' : 'py-1.5',
              // 点击/展开反馈走 transition-colors，与 interactive 词汇表一致；
              // 再叠一个 150ms 的箭头旋转（见下方 ChevronDownIcon），
              // 让"点了一下"有明确反馈而不是瞬变。
              'transition-colors duration-150 active:bg-bg-200/60 active:duration-75',
            )}
            title={project.worktree}
          >
            {/* hover 时图标淡出、展开/收起箭头淡入（两者叠放做交叉淡入淡出）。
                箭头常态不可见但仍占位，避免 hover 瞬间撑开会引起文字位移。
                图标类型（地球/分支/文件夹）不丢失，鼠标移开即恢复。 */}
            <span className="relative size-5 shrink-0 flex items-center justify-center">
              <FolderDisplayIcon
                size={17}
                className={`transition-opacity duration-150 group-hover/folder:opacity-0 ${
                  isProjectActive ? 'text-accent-main-100' : 'text-text-400'
                }`}
                // 激活项目：主色描边 + 主色填充（fill 跟随 currentColor），
                // 与列内其他线性图标区分开；非激活保持原来的灰线框。
                {...(isProjectActive ? { fill: 'currentColor', fillOpacity: 0.22 } : {})}
              />
              <ChevronDownIcon
                size={13}
                className={`absolute text-text-300 opacity-0 transition-[opacity,transform] duration-150 group-hover/folder:opacity-100 ${
                  isExpanded ? '' : '-rotate-90'
                }`}
              />
            </span>
            <ProjectNameTitle
              text={projectName}
              // 颜色承担层级：项目名用最强文字色，比下属会话（text-300）明显更亮。
              // 字重上 medium 与 semibold 都解析到 600（字体只有 400/600 两档），
              // 无法再靠加粗区分，所以层级只能由颜色表达。
              className="text-text-100"
            />
          </button>
          {/* 项目行 hover 的 + 按钮：在该项目目录下新建会话（全局/无目录项目不显示）；hover 才显示，与移除按钮一致。
              hover 揭示按钮不参与 flex 布局动画：固定 24px 占位、绝对定位到行尾右侧，只做 opacity 淡入。
              这样展开时不会挤压 title / 推动右侧状态点与时间，避免"划过一行时文字轻微位移"。 */}
          {!isEditMode && onNewSessionInDirectory && project.worktree && (
            <button
              type="button"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation()
                onNewSessionInDirectory(project.worktree)
              }}
              className={cn(
                'absolute right-[34px] z-10 flex items-center justify-center size-6 rounded-full overflow-hidden text-accent-main-100 hover:text-accent-main-200',
                'opacity-0 transition-opacity duration-150 group-hover/folder:opacity-100 pointer-events-none group-hover/folder:pointer-events-auto',
                interactive.accent,
              )}
              title={t('sidebar.newTaskInDirectory', { defaultValue: 'New conversation here' })}
              aria-label={t('sidebar.newTaskInDirectory', { defaultValue: 'New conversation here' })}
            >
              <PlusIcon size={13} />
            </button>
          )}
          {/* 打开项目目录：仅桌面端显示；hover 才显示，与 + / 移除按钮同一套几何 */}
          {!isEditMode && canOpenDirectory && (
            <button
              type="button"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation()
                void handleOpenDirectory()
              }}
              className={cn(
                'absolute right-[62px] z-10 flex items-center justify-center size-6 rounded-full overflow-hidden text-text-400 hover:text-text-100',
                'opacity-0 transition-opacity duration-150 group-hover/folder:opacity-100 pointer-events-none group-hover/folder:pointer-events-auto',
                interactive.subtle,
              )}
              title={t('header.openProjectDirectory')}
              aria-label={t('header.openProjectDirectory')}
            >
              <ExternalLinkIcon size={13} />
            </button>
          )}
          {/* 移除项目：hover 显示；二次点击防误触（已保存=移除，服务器发现=隐藏；全局项不显示）。
              与 + 按钮同一套几何：固定占位 + opacity 淡入，不改变布局。 */}
          {!isEditMode && onRemoveProject && project.worktree && (
            <button
              type="button"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation()
                handleRemoveClick()
              }}
              onMouseLeave={disarmRemove}
              className={cn(
                'absolute right-1.5 z-10 flex items-center justify-center size-6 rounded-full overflow-hidden',
                removeArmed
                  ? 'bg-danger-100/15 text-danger-100 opacity-100 pointer-events-auto'
                  : 'text-text-400 opacity-0 transition-opacity duration-150 group-hover/folder:opacity-100 pointer-events-none group-hover/folder:pointer-events-auto hover:text-danger-100',
                !removeArmed && interactive.danger,
              )}
              title={removeArmed ? t('sidebar.removeProjectConfirmClick', { defaultValue: '再次点击确认移除' }) : t('sidebar.removeProject')}
              aria-label={removeArmed ? t('sidebar.removeProjectConfirmClick', { defaultValue: '再次点击确认移除' }) : t('sidebar.removeProject')}
            >
              {removeArmed ? <CheckIcon size={12} /> : <TrashIcon size={12} />}
            </button>
          )}
          {/* 管理模式下保留展开/收起，否则选不了内部会话 */}
          {isEditMode && (
            <button
              type="button"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation()
                onToggle()
              }}
              className={cn(
                'shrink-0 flex items-center justify-center w-6 h-6 mr-1 rounded-md text-text-500 hover:text-text-200',
                interactive.subtle,
              )}
              title={isExpanded ? t('common:collapse', { defaultValue: 'Collapse' }) : t('common:expand', { defaultValue: 'Expand' })}
              aria-expanded={isExpanded}
            >
              <ChevronDownIcon
                size={12}
                className={`transition-transform duration-150 ${isExpanded ? '' : '-rotate-90'}`}
              />
            </button>
          )}
          {/* 状态指示：紧挨时间，hover 时隐藏给操作按钮让位。
              状态分档与项目内会话行（minimal SessionListItem）保持一致：
              - working：旋转 spinner（不是点），表示有会话正在跑
              - permission / question / retry：彩色点
              - unread：主色未读点
              旋转图标比点更大，容器用 w-3.5 并在右侧留 0.5 间距，避免贴住时间。 */}
          {folderStatus && (
            <span
              className="relative shrink-0 flex items-center justify-center w-4 h-4 group-hover/folder:hidden"
              title={folderStatus.count ? `${folderStatus.label} (${folderStatus.count})` : folderStatus.label}
            >
              {folderStatus.kind === 'working' ? (
                <Spinner size="xs" tone="accent" variant="grid-orbit" />
              ) : (
                <span className={`absolute w-1.5 h-1.5 rounded-full ${folderStatus.dot}`} />
              )}
            </span>
          )}
          {/* 最后使用时间放行尾；hover 时隐藏，给 + / 移除按钮让位 */}
          {lastUsedAt ? (
            <span
              className="shrink-0 pl-1 pr-1.5 text-[length:var(--fs-xxs)] text-text-500 group-hover/folder:hidden"
              title={new Date(lastUsedAt).toLocaleString()}
            >
              {formatRelativeDay(lastUsedAt)}
            </span>
          ) : null}
        </div>
        {contextMenuNode}

        {/* Session 列表 — mt-1 与项目行拉开：项目行自身 py-1.5(6px) + 这里 4px，
            合计约 10px，比会话之间的 4px 明显，层级更清楚。
            mb-2 让最后一条会话到下一个项目之间留 8px（外层项目间距只有 4px，
            与会话间距相同就分不出项目边界）。折叠时被 !m-0 清零 */}
        <ExpandableSection show={isExpanded} className="mt-1 mb-2">
          {shouldRenderBody && (
            <div onTouchStart={e => e.stopPropagation()}>
              {!hasActivated || isLoading ? (
                // 与 minimal SessionListItem 对齐：状态点占位 + 像素格子 spinner + 扫光文案
                <div className="flex items-center gap-2 px-2 py-1" aria-busy="true">
                  <span className="size-5 shrink-0" aria-hidden="true" />
                  <Spinner size="xs" tone="accent" variant="pixel" />
                  <span className="reasoning-shimmer-text text-[length:var(--fs-xs)]">
                    {t('sidebar.loadingChats')}
                  </span>
                </div>
              ) : error && filteredSessions.length === 0 ? (
                <div className="flex items-center gap-2 px-2 py-1" role="alert">
                  <span className="size-5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--fs-xs)] text-danger-100">
                    {t('sidebar.loadingChatsFailed')}
                  </span>
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-200"
                  >
                    {t('common:retry', { defaultValue: 'Retry' })}
                  </button>
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="px-2 py-1 text-[length:var(--fs-xs)] text-text-400/50">
                  {searchTerms.length > 0
                    ? t('sidebar.searchNoMatches', { defaultValue: 'No matching chats' })
                    : t('sidebar.noChatsInFolder')}
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {filteredSessions.map((session, index) => {
                    const isChecked = selectedSessionIds?.has(session.id) ?? false
                    // 上：前一条 session，或（首条时）父文件夹已选中
                    const prevChecked =
                      isEditMode &&
                      (index > 0
                        ? (selectedSessionIds?.has(filteredSessions[index - 1].id) ?? false)
                        : isProjectChecked)
                    // 下：下一条 session，或（末条时）下一个文件夹已选中
                    const nextChecked =
                      isEditMode &&
                      (index < filteredSessions.length - 1
                        ? (selectedSessionIds?.has(filteredSessions[index + 1].id) ?? false)
                        : nextProjectChecked)
                    return (
                    <div key={session.id}>
                      <SessionListItem
                        session={session}
                        activeSessionKey={serverId ? `${serverId}::${session.id}` : undefined}
                        isSelected={!!selectedSessionId && session.id === splitSessionKey(selectedSessionId).sessionId}
                        onSelect={() => onSelectSession(session)}
                        onRename={newTitle => handleRename(session.id, newTitle)}
                        onDelete={() => handleDelete(session.id)}
                        onArchive={() => handleArchive(session.id)}
                        preferTouchUi={preferTouchUi}
                        density="minimal"
                        showStats={showSessionDiffStats}
                        showDirectory={false}
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
                            selectedSessionId={selectedSessionId}
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

                  {(hasMore || visibleSessions.length > DIRECTORY_PAGE_SIZE) && (
                    <div className="flex items-center gap-1.5">
                      {hasMore && (
                        <button
                          onClick={() => void loadMore()}
                          disabled={isLoadingMore}
                          aria-busy={isLoadingMore}
                          aria-label={isLoadingMore ? t('common:loadingMore') : t('sidebar.showMoreChats')}
                          className={cn(
                            'group inline-flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-[length:var(--fs-xs)] font-medium text-accent-main-100',
                            visibleSessions.length > DIRECTORY_PAGE_SIZE
                              ? 'flex-1 justify-center pl-2'
                              : 'flex-1 justify-start pl-[30px]',
                            interactive.subtle,
                            'disabled:cursor-default disabled:opacity-70',
                          )}
                        >
                          <span>{t('sidebar.showMoreChats')}</span>
                          {isLoadingMore ? (
                            <Spinner size="xs" tone="accent" variant="pixel" />
                          ) : (
                            <ChevronDownIcon
                              size={12}
                              className="text-accent-main-100 transition-colors"
                            />
                          )}
                        </button>
                      )}

                      {visibleSessions.length > DIRECTORY_PAGE_SIZE && (
                        <button
                          onClick={() => void collapse()}
                          disabled={isLoadingMore}
                          aria-busy={isLoadingMore}
                          aria-label={t('sidebar.showFewerChats')}
                          title={t('sidebar.showFewerChats')}
                          className={cn(
                            'group inline-flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-[length:var(--fs-xs)] font-medium text-accent-main-100',
                            hasMore ? 'flex-1 justify-center pl-2' : 'flex-1 justify-start pl-[30px]',
                            interactive.subtle,
                            'disabled:cursor-default disabled:opacity-70',
                          )}
                        >
                          <span>{t('sidebar.showFewerChats')}</span>
                          <ChevronDownIcon
                            size={12}
                            className="rotate-180 text-accent-main-100 transition-colors"
                          />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </ExpandableSection>
      </div>
    </div>
  )
}

