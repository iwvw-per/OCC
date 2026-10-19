// ============================================
// useProjectGroups — 侧栏项目分组、排序与展开状态
//
// 从 SidePanel 抽出：已保存目录 → 项目组 → 排序后的可见项目列表，
// 以及「展开哪几个项目」的跨端对齐状态（按项目名存储，不用含盘符的路径 id）。
// ============================================

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useDirectory, useGitWorkspaceCatalog, useMissingDirectories } from '../../../hooks'
import { layoutStore, useLayoutStore } from '../../../store'
import { sessionActivityStore } from '../../../store/sessionActivityStore'
import {
  hideProject as persistHideProject,
  hiddenProjectsStore,
  unhideProject as persistUnhideProject,
} from '../../../storage/appData'
import { getDirectoryName, isSameDirectory, normalizeToForwardSlash } from '../../../utils'
import { getProjectGroupIdentity, sortProjects, mergeProjectLastUsed } from './projectGrouping'
import { mergeExpandedProjectNames } from './expandedProjects'
import { useProjectLastUsedAt } from '../../../hooks/useProjectLastUsedAt'

export interface ProjectItem {
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

/**
 * 项目展开状态在存储里的 key。
 *
 * 用项目名而非 id：id 通常是 worktree 绝对路径（含盘符），跨设备不可比，
 * 用名字才能让「哪几个项目展开」在多端对齐。名字缺失时退回 worktree。
 */
export function projectExpandKey(project: ProjectItem): string {
  return project.name || project.worktree || project.id
}

/**
 * 某项目条目在「已保存项目」里对应的目录。
 *
 * 派生项目（isDerived）没有 memberDirectories，但它的 worktree 可能恰好是一个
 * 已保存目录——用户视角看它就是那个项目，移除时必须命中真实的已保存路径，
 * 否则会出现「按钮点了没反应」。
 */
export function resolveSavedProjectPaths(
  project: Pick<ProjectItem, 'id' | 'worktree' | 'memberDirectories' | 'workspaceDirectories'>,
  savedPaths: readonly string[],
): string[] {
  const candidates = new Set<string>([
    ...(project.memberDirectories ?? []),
    project.worktree,
    project.id,
    ...(project.workspaceDirectories ?? []),
  ])
  const matched = savedPaths.filter(path => [...candidates].some(candidate => isSameDirectory(candidate, path)))
  return Array.from(new Set(matched))
}

export function findProjectGroupForDirectory(projects: ProjectItem[], directory: string) {
  return projects.find(project => {
    if (isSameDirectory(project.id, directory) || isSameDirectory(project.worktree, directory)) return true
    if (project.workspaceDirectories?.some(workspace => isSameDirectory(workspace, directory))) return true
    if (project.memberDirectories?.some(member => isSameDirectory(member, directory))) return true
    return false
  })
}

export interface UseProjectGroupsOptions {
  activeServerId: string
  currentDirectory?: string
}

export interface UseProjectGroupsResult {
  folderProjects: ProjectItem[]
  /** 只在「已保存项目」里的目录；不存在的派生项目可据此判断能否移除 */
  savedDirectoryPaths: string[]
  /** 用户主动隐藏的派生项目目录（服务器当前 worktree 那类） */
  hiddenProjectPaths: string[]
  /** 隐藏一个项目目录（持久化；刷新后不再出现） */
  hideProjectDirectory: (directory: string) => void
  /** 取消隐藏（重新添加该项目时调用） */
  unhideProjectDirectory: (directory: string) => void
  sortedFolderProjects: ProjectItem[]
  currentProject: ProjectItem
  expandedProjectIds: string[]
  setExpandedProjectIds: (updater: string[] | ((prev: string[]) => string[])) => void
  /** 展开状态可作用的项目 id（与 allProjectsCollapsed 判定同源） */
  expandableProjectIds: string[]
  allProjectsCollapsed: boolean
  workspaceDirectoriesByProjectId: Map<string, string[]>
  projectLastUsedAt: Record<string, number>
}

export function useProjectGroups({
  activeServerId,
  currentDirectory,
}: UseProjectGroupsOptions): UseProjectGroupsResult {
  const { t } = useTranslation(['chat', 'common'])
  const { savedDirectories, pathInfo, recentProjects } = useDirectory()
  // 用户主动隐藏的派生项目（服务器当前 worktree 自动置顶的那类）。
  // get() 返回 store 内部引用，只有 commit 时才变，满足 useSyncExternalStore 的稳定性要求。
  const hiddenProjectPaths = useSyncExternalStore(
    hiddenProjectsStore.subscribe,
    () => hiddenProjectsStore.get(),
    () => hiddenProjectsStore.get(),
  )
  const hiddenProjectSet = useMemo(
    () => new Set(hiddenProjectPaths.map(path => normalizeToForwardSlash(path))),
    [hiddenProjectPaths],
  )
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
  const { catalog: gitWorkspaceCatalog } = useGitWorkspaceCatalog(catalogDirectories, activeServerId)

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
  const normalizedCurrentDirectory = useMemo(
    () => (currentDirectory ? normalizeToForwardSlash(currentDirectory) : undefined),
    [currentDirectory],
  )

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

  const folderProjectGroups = useMemo(() => buildProjectGroups(visibleSavedDirectories), [
    buildProjectGroups,
    visibleSavedDirectories,
  ])

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
  // 根 worktree（global 项目）不展示 —— 用户明确不要「全局」文件夹。
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
    const nonRootGroups = folderProjectGroups.filter(project => normalizeToForwardSlash(project.worktree || '') !== '')
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
    // 也不展示用户主动隐藏的目录（服务器当前 worktree 那类删不掉的派生项目）。
    return list.filter(project => {
      const worktree = normalizeToForwardSlash(project.worktree || '')
      const id = normalizeToForwardSlash(project.id || '')
      return !hiddenProjectSet.has(worktree) && !hiddenProjectSet.has(id)
    })
  }, [serverCurrentProject, folderProjectGroups, currentDirectory, currentProject, hiddenProjectSet])

  const hideProjectDirectory = useCallback((directory: string) => {
    persistHideProject(directory)
  }, [])

  const unhideProjectDirectory = useCallback((directory: string) => {
    persistUnhideProject(directory)
  }, [])

  // ---- 展开状态 ----
  // 状态存在 layoutStore 里，键是「项目名」而非 id：id 通常是 worktree 绝对路径
  // （含盘符），跨设备不可比；项目名两端一致，才能让展开状态在多端对齐。
  const expandedProjectNames = useLayoutStore().sidebarExpandedProjects
  const expandedProjectIds = useMemo(
    () => folderProjects.filter(p => expandedProjectNames.includes(projectExpandKey(p))).map(p => p.id),
    [folderProjects, expandedProjectNames],
  )
  /**
   * 「全部展开/收起」的作用范围：与 allProjectsCollapsed 的判定范围一致。
   *
   * 之前判定只看非派生项目、操作却用 folderProjects（含派生项目），
   * 点「全部收起」后派生项目仍是展开的，按钮图标与列表状态对不上。
   */
  const expandableProjectIds = useMemo(() => folderProjects.map(p => p.id), [folderProjects])
  const allProjectsCollapsed = useMemo(
    () =>
      expandableProjectIds.length > 0 && expandableProjectIds.every(id => !expandedProjectIds.includes(id)),
    [expandableProjectIds, expandedProjectIds],
  )

  const setExpandedProjectIds = useCallback(
    (updater: string[] | ((prev: string[]) => string[])) => {
      const currentIds = folderProjects.filter(p => expandedProjectNames.includes(projectExpandKey(p))).map(p => p.id)
      const nextIds = typeof updater === 'function' ? updater(currentIds) : updater
      // 项目列表尚未加载时一律不写回：此刻映射必然为空，会把存储里真实的展开状态
      // 清空；随后同步拉取又用服务端值覆盖，用户看到的展开状态就随机变化。
      if (folderProjects.length === 0) return
      const nextNames = nextIds
        .map(id => folderProjects.find(p => p.id === id))
        .filter((p): p is ProjectItem => !!p)
        .map(projectExpandKey)
      // 只替换「属于当前服务器」的那部分名字，保留其它服务器的展开项。
      // 存储是全局单键、项目列表按服务器分区：整体覆盖会清掉别的服务器的展开
      // 状态，切回去就变成「全部收起」。
      const currentNames = folderProjects.map(projectExpandKey)
      layoutStore.setSidebarExpandedProjects(mergeExpandedProjectNames(expandedProjectNames, currentNames, nextNames))
    },
    [folderProjects, expandedProjectNames],
  )

  // 新添加/新保存的项目自动展开。
  // 首次见到某台服务器的新项目时自动展开（只展开「本服务器内新增」的，
  // 不对全部项目无条件展开）。
  const prevIdsRef = useRef<{ serverId: string; ids: string[] } | null>(null)
  useEffect(() => {
    const ids = folderProjects.filter(project => !project.isDerived).map(project => project.id)
    const prev = prevIdsRef.current
    prevIdsRef.current = { serverId: activeServerId, ids }
    if (!prev || prev.serverId !== activeServerId) return
    const added = ids.filter(id => !prev.ids.includes(id))
    if (added.length > 0) {
      setExpandedProjectIds(current => {
        const missing = added.filter(id => !current.includes(id))
        return missing.length > 0 ? [...current, ...missing] : current
      })
    }
  }, [folderProjects, setExpandedProjectIds, activeServerId])

  const workspaceDirectoriesByProjectId = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const project of folderProjects) {
      if (project.workspaceDirectories && project.workspaceDirectories.length > 1) {
        map.set(project.id, project.workspaceDirectories)
      }
    }
    return map
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
  const projectWorktrees = useMemo(
    () => folderProjects.map(project => normalizeToForwardSlash(project.worktree || '')).filter(Boolean),
    [folderProjects],
  )
  const fetchedProjectLastUsed = useProjectLastUsedAt(activeServerId, projectWorktrees, true)

  const projectLastUsedAt = useMemo<Record<string, number>>(
    () =>
      mergeProjectLastUsed(projectWorktrees, recentProjects, fetchedProjectLastUsed, worktree =>
        sessionActivityStore.getDirectoryAnchor(activeServerId, worktree),
      ),
    // activityVersion 参与：锚点变化时重算时间
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recentProjects, fetchedProjectLastUsed, projectWorktrees, activeServerId, activityVersion],
  )

  const { sidebarProjectSortField, sidebarProjectSortDesc } = useLayoutStore()

  /**
   * 项目（文件夹）的最终显示顺序：始终自动排序，不保留手动拖拽顺序。
   *
   * created：按项目保存时间（稳定值）；updated：按最后一次对话时间（默认）。
   * 时间缺失的项目排到末尾（created 下派生项目无 addedAt，自然沉底）。
   */
  const sortedFolderProjects = useMemo(
    () => sortProjects(folderProjects, sidebarProjectSortField, projectLastUsedAt, sidebarProjectSortDesc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folderProjects, projectLastUsedAt, sidebarProjectSortField, sidebarProjectSortDesc, activityVersion],
  )

  return {
    folderProjects,
    savedDirectoryPaths: visibleSavedDirectories.map(directory => directory.path),
    hiddenProjectPaths,
    hideProjectDirectory,
    unhideProjectDirectory,
    sortedFolderProjects,
    currentProject,
    expandedProjectIds,
    setExpandedProjectIds,
    expandableProjectIds,
    allProjectsCollapsed,
    workspaceDirectoriesByProjectId,
    projectLastUsedAt,
  }
}
