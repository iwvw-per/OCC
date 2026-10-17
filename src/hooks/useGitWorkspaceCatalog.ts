import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentProject, listWorktrees, probeDirectory, type ApiProject } from '../api'
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
      const projectResults = await Promise.allSettled(
        normalizedDirectories.map(async directory => ({
          directory,
          project: await getCurrentProjectCached(directory, serverId),
        })),
      )

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

      for (let index = 0; index < projectResults.length; index++) {
        const result = projectResults[index]
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
      const rootDirectoryList = Array.from(rootDirectories)
      const rootExistsResults = await Promise.allSettled(
        rootDirectoryList.map(async rootDirectory => ({
          rootDirectory,
          probe: await probeDirectory(rootDirectory, serverId),
        })),
      )
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

      const workspaceResults = await Promise.allSettled(
        rootDirectoryList.map(async rootDirectory => ({
          rootDirectory,
          worktrees: await listWorktreesCached(rootDirectory, serverId),
        })),
      )

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
