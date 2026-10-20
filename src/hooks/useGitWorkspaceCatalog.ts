import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentProject, getProjects, listWorktrees, probeDirectory, type ApiProject } from '../api'
import { subscribeToEvents } from '../api/events'
import { serverStore } from '../store/serverStore'
import { normalizeToForwardSlash } from '../utils'
import { ttlCacheGet, ttlCacheSet, ttlCacheInvalidate } from '../utils/ttlCache'

/** 单目录的 getCurrentProject / listWorktrees 按 serverId+目录缓存：切换主机回来不重拉 */
const CACHE_TTL_MS = 60_000

async function getCurrentProjectCached(directory: string, serverId?: string): Promise<ApiProject> {
  const key = `git-cat-project:${serverId ?? ''}:${directory}`
  const cached = ttlCacheGet<ApiProject>(key, CACHE_TTL_MS)
  if (cached) return cached
  const project = await getCurrentProject(directory, serverId)
  ttlCacheSet(key, project, CACHE_TTL_MS)
  return project
}

async function listWorktreesCached(rootDirectory: string, serverId?: string) {
  const key = `git-cat-worktrees:${serverId ?? ''}:${rootDirectory}`
  const cached = ttlCacheGet<string[]>(key, CACHE_TTL_MS)
  if (cached) return cached
  const worktrees = await listWorktrees(rootDirectory, serverId)
  ttlCacheSet(key, worktrees, CACHE_TTL_MS)
  return worktrees
}

export interface GitWorkspaceMeta {
  isGit: boolean
  rootDirectory: string
  // root workspace 放第一位，后面才是 sandbox worktree
  workspaces: string[]
  /**
   * 根目录本身是否在本机真实存在。
   *
   * 仓库整体搬家（/opt/a → /opt/b）后，opencode 仍按 git 仓库身份返回
   * `worktree=旧路径`，旧路径只存在于历史记录里、磁盘上已不存在；
   * 此时新目录会出现在 `sandboxes` 里。侧栏据此决定是否还可聚合到旧根，
   * 否则新目录会被挂进旧项目行，新建对话也会沿用旧目录。
   */
  rootExists?: boolean
}

export type GitWorkspaceCatalog = Map<string, GitWorkspaceMeta>

type RefreshListener = () => void

const refreshListeners = new Set<RefreshListener>()

export function requestGitWorkspaceCatalogRefresh() {
  refreshListeners.forEach(listener => listener())
}

export function useGitWorkspaceCatalog(directories: string[], serverId?: string) {
  const [catalog, setCatalog] = useState<GitWorkspaceCatalog>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  const mountedRef = useRef(true)
  const versionRef = useRef(0)
  const catalogRef = useRef<GitWorkspaceCatalog>(new Map())

  const setCatalogState = useCallback((nextCatalog: GitWorkspaceCatalog) => {
    catalogRef.current = nextCatalog
    setCatalog(nextCatalog)
  }, [])

  const refresh = useCallback(async () => {
    const version = ++versionRef.current
    const normalizedDirectorySet = new Set(
      directories.filter(Boolean).map(directory => normalizeToForwardSlash(directory)),
    )
    const normalizedDirectories = Array.from(normalizedDirectorySet)

    if (normalizedDirectories.length === 0) {
      setIsLoading(false)
      setCatalogState(new Map())
      return
    }

    setIsLoading(true)
    const previousCatalog = catalogRef.current

    try {
      /**
       * 第一步：确认每个目录属于哪个 git 根。
       *
       * 原实现是 `normalizedDirectories.map(d => getCurrentProjectCached(d))` ——
       * 每个目录一个请求。生产日志显示网关单次往返平均 274ms，15 个项目就是
       * 15 个请求，即使并行也要占满浏览器同源连接额度，把更关键的会话消息请求
       * 挤到队列后面。
       *
       * 改为优先一次拉全量项目列表（`getProjects`，1 个请求），在本地按
       * directory 建索引；只有全量失败或某目录查不到时才回退到逐个查。
       */
      const projectByDirectory = new Map<string, ApiProject>()
      let bulkLoaded = false
      try {
        const projects = await getProjects(undefined, serverId)
        for (const project of projects) {
          const dir = normalizeToForwardSlash(project.worktree ?? '')
          if (dir) projectByDirectory.set(dir, project)
        }
        bulkLoaded = projects.length > 0
      } catch {
        bulkLoaded = false
      }

      if (!mountedRef.current || version !== versionRef.current) return

      // 全量里缺失的目录才逐个补查（通常是尚未初始化/不在项目表里的目录）
      const missingDirectories = bulkLoaded
        ? normalizedDirectories.filter(directory => !projectByDirectory.has(directory))
        : normalizedDirectories

      const projectResults: Array<PromiseSettledResult<{ directory: string; project: ApiProject }>> =
        missingDirectories.length > 0
          ? await Promise.allSettled(
              missingDirectories.map(async directory => ({
                directory,
                project: await getCurrentProjectCached(directory, serverId),
              })),
            )
          : []

      // 把「全量命中」与「逐个补查」合并成统一的目录顺序结果
      const resolvedByDirectory = new Map<string, ApiProject>()
      for (const [dir, project] of projectByDirectory) resolvedByDirectory.set(dir, project)
      projectResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          resolvedByDirectory.set(missingDirectories[index], result.value.project)
        }
      })
      const mergedResults: Array<PromiseSettledResult<{ directory: string; project: ApiProject }>> =
        normalizedDirectories.map(directory => {
          const project = resolvedByDirectory.get(directory)
          return project
            ? ({ status: 'fulfilled', value: { directory, project } } as PromiseFulfilledResult<{
                directory: string
                project: ApiProject
              }>)
            : ({ status: 'rejected', reason: new Error('project not found') } as PromiseRejectedResult)
        })

      if (!mountedRef.current || version !== versionRef.current) return

      const rootDirectories = new Set<string>()
      const directoryToRoot = new Map<string, string>()
      const nextCatalog: GitWorkspaceCatalog = new Map()
      const previousWorkspacesByRoot = new Map<string, string[]>()

      for (const [directory, meta] of previousCatalog) {
        if (meta.isGit) {
          previousWorkspacesByRoot.set(meta.rootDirectory, meta.workspaces)
        }

        if (normalizedDirectorySet.has(directory)) {
          nextCatalog.set(directory, meta)
        }
      }

      for (let index = 0; index < mergedResults.length; index++) {
        const result = mergedResults[index]
        const directory = normalizedDirectories[index]

        if (result.status !== 'fulfilled') {
          const previousMeta = previousCatalog.get(directory)
          if (previousMeta?.isGit) {
            rootDirectories.add(previousMeta.rootDirectory)
            directoryToRoot.set(directory, previousMeta.rootDirectory)
          }
          continue
        }

        const { project } = result.value

        if (project.vcs === 'git' && project.worktree) {
          const rootDirectory = normalizeToForwardSlash(project.worktree)
          rootDirectories.add(rootDirectory)
          directoryToRoot.set(directory, rootDirectory)
        } else {
          nextCatalog.set(directory, {
            isGit: false,
            rootDirectory: directory,
            workspaces: [directory],
          })
        }
      }

      // 根目录存在性：git 仓库整体搬家后，服务端仍返回旧 worktree，
      // 旧路径在磁盘上已不存在。这里并发探一次，供侧栏判断能否继续聚合到旧根。
      // 只有「确认不存在」才标记 rootExists=false：探测失败（unknown）不能用来拆组。
      //
      // 存在性探测与 worktree 列表**互不依赖**，必须并行：原实现先等完
      // rootExistsResults 全部落地，才开始拉 workspaceResults —— 两轮串行，
      // 在网关隧道下（单次往返 274ms）等于白白多付一整轮。
      const rootDirectoryList = Array.from(rootDirectories)
      const [rootExistsResults, workspaceResults] = await Promise.all([
        Promise.allSettled(
          rootDirectoryList.map(async rootDirectory => ({
            rootDirectory,
            probe: await probeDirectory(rootDirectory, serverId),
          })),
        ),
        Promise.allSettled(
          rootDirectoryList.map(async rootDirectory => ({
            rootDirectory,
            worktrees: await listWorktreesCached(rootDirectory, serverId),
          })),
        ),
      ])
      const rootExistsMap = new Map<string, boolean>()
      for (let index = 0; index < rootExistsResults.length; index++) {
        const result = rootExistsResults[index]
        if (result.status === 'fulfilled') {
          rootExistsMap.set(result.value.rootDirectory, result.value.probe !== 'missing')
        } else {
          // 探测失败：保守视为存在，避免网络抖动时把项目拆散
          rootExistsMap.set(rootDirectoryList[index], true)
        }
      }

      if (!mountedRef.current || version !== versionRef.current) return

      const rootToWorkspaces = new Map<string, string[]>()

      for (let index = 0; index < workspaceResults.length; index++) {
        const result = workspaceResults[index]
        const rootDirectory = rootDirectoryList[index]

        if (result.status !== 'fulfilled') {
          rootToWorkspaces.set(rootDirectory, previousWorkspacesByRoot.get(rootDirectory) ?? [rootDirectory])
          continue
        }

        const { worktrees } = result.value
        const normalizedWorktrees = Array.from(new Set(worktrees.map(worktree => normalizeToForwardSlash(worktree))))
        const sandboxes = normalizedWorktrees.filter(worktree => worktree.toLowerCase() !== rootDirectory.toLowerCase())
        rootToWorkspaces.set(rootDirectory, [rootDirectory, ...sandboxes])
      }

      for (const [directory, rootDirectory] of directoryToRoot) {
        nextCatalog.set(directory, {
          isGit: true,
          rootDirectory,
          workspaces: rootToWorkspaces.get(rootDirectory) ?? [rootDirectory],
          rootExists: rootExistsMap.get(rootDirectory) ?? true,
        })
      }

      setCatalogState(nextCatalog)
    } finally {
      if (mountedRef.current && version === versionRef.current) {
        setIsLoading(false)
      }
    }
  }, [directories, serverId, setCatalogState])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  useEffect(() => {
    // worktree 就绪/失败意味着服务器侧目录结构变化：失效缓存后重拉，保证拿到新数据
    return subscribeToEvents({
      onWorktreeReady: () => {
        ttlCacheInvalidate('git-cat-')
        void refresh()
      },
      onWorktreeFailed: () => {
        ttlCacheInvalidate('git-cat-')
        void refresh()
      },
      onReconnected: reason => {
        if (reason !== 'server-switch') {
          ttlCacheInvalidate('git-cat-')
          void refresh()
        }
      },
    })
  }, [refresh])

  useEffect(() => {
    const listener = () => {
      ttlCacheInvalidate('git-cat-')
      void refresh()
    }
    refreshListeners.add(listener)
    return () => {
      refreshListeners.delete(listener)
    }
  }, [refresh])

  useEffect(() => {
    return serverStore.onServerChange(() => void refresh())
  }, [refresh])

  return {
    catalog,
    isLoading,
    refresh,
  }
}
