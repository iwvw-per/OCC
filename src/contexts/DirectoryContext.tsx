// ============================================
// DirectoryContext - 管理当前工作目录
// ============================================

import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { getPath, type ApiPath } from '../api'
import { useRouter } from '../hooks/useRouter'
import {
  handleError,
  isAbsoluteDirectory,
  normalizeToForwardSlash,
  getDirectoryName,
  isSameDirectory,
} from '../utils'
import { layoutStore, useLayoutStore } from '../store/layoutStore'
import { serverStore } from '../store/serverStore'
import { multiServerStore, useMultiServerStore } from '../store/multiServerStore'
import { isTauri } from '../utils/tauri'
import { DirectoryContext, type DirectoryContextValue, type SavedDirectory } from './DirectoryContext.shared'
import {
  rebindAppData,
  recentProjectsStore,
  savedDirectoriesStore,
  touchRecentProject,
  unhideProject,
} from '../storage/appData'

export function DirectoryProvider({ children }: { children: ReactNode }) {
  // 从 URL 获取 directory（替代 localStorage）
  const { directory: urlDirectory, setDirectory: setUrlDirectory } = useRouter()

  // 从 layoutStore 获取 sidebarExpanded
  const { sidebarExpanded } = useLayoutStore()

  // 项目列表 / 最近使用记录：数据与桶绑定由 storage/appData 统一管理
  // （createStore 保证单写入口 + 显式 serverId，切换主机自动 rebind）。
  const savedDirectories = useSyncExternalStore(
    savedDirectoriesStore.subscribe,
    savedDirectoriesStore.get,
    savedDirectoriesStore.get,
  )
  const recentProjects = useSyncExternalStore(
    recentProjectsStore.subscribe,
    recentProjectsStore.get,
    recentProjectsStore.get,
  )

  const [pathInfo, setPathInfo] = useState<ApiPath | null>(null)

  // 路径信息跟随焦点服务器（焦点缺省 = 活动服务器）。
  // 不再有模式开关：始终按服务器区分路径信息。
  useMultiServerStore()
  const pathServerId = multiServerStore.getFocusedServerId()

  // 服务器 ID 切换时切换 per-server 目录；local runtime URL 变化时只刷新 path info。
  useEffect(() => {
    return serverStore.onServerChange((_, reason) => {
      if (reason === 'server-switch') {
        // 连同 serverId 一起换：写回时才知道这份列表属于哪台服务器。
        // 项目列表 / 最近使用记录跟着切到新主机的桶
        rebindAppData(serverStore.getActiveServerId())
        // 目录（URL 的 dir 参数）不在这里清：切换主机时由 App 的「每主机工作区快照」
        // 统一决定目标主机的会话与目录（见 hostWorkspaceStore）。这里再动 URL 会与
        // 快照恢复竞态，把刚恢复的目录清掉。
      }
      setPathInfo(null)
      getPath(multiServerStore.getFocusedServerId())
        .then(setPathInfo)
        .catch(handleError('get path info', 'api'))
    })
  }, [setUrlDirectory])

  // 加载路径信息（活动/焦点服务器变化时刷新）
  useEffect(() => {
    setPathInfo(null)
    getPath(pathServerId).then(setPathInfo).catch(handleError('get path info', 'api'))
  }, [pathServerId])

  // 设置当前目录（更新 URL + 记录最近使用）
  const setCurrentDirectory = useCallback(
    (directory: string | undefined) => {
      setUrlDirectory(directory)
      if (directory) touchRecentProject(directory)
    },
    [setUrlDirectory],
  )

  // 添加目录
  const addDirectory = useCallback(
    (path: string) => {
      let normalized = normalizeToForwardSlash(path)

      // normalizeToForwardSlash 会去掉尾斜杠，导致根路径 "/" → "" 和 "C:/" → "C:"
      // 需要修正：如果原始路径是根路径，恢复正确的值
      const trimmed = path.replace(/\\/g, '/').replace(/\/+$/, '/')
      if (!normalized && (trimmed === '/' || /^[a-zA-Z]:\/$/.test(trimmed))) {
        normalized = trimmed.slice(0, -1) || '/'
      }

      // 验证路径非空（只阻止空字符串和 "."）
      if (!normalized || normalized === '.') return false

      // 后端只接受绝对路径：相对路径（如 `../code/OCC`）会在列会话/文件时
      // 被拒绝（v2: Path is not absolute），且会被误判为「目录不存在」而隐藏。
      if (!isAbsoluteDirectory(normalized)) {
        return false
      }

      // 使用 isSameDirectory 检查是否已存在（处理大小写和斜杠差异）
      if (savedDirectories.some(d => isSameDirectory(d.path, normalized))) {
        // 重新添加已隐藏的目录时解除隐藏，否则「加了却看不见」
        unhideProject(normalized)
        setCurrentDirectory(normalized)
        return true
      }

      const newDir: SavedDirectory = {
        path: normalized,
        name: getDirectoryName(normalized) || normalized,
        addedAt: Date.now(),
      }

      // 用户显式添加：解除隐藏（可能是之前隐藏过、现在又要了）
      unhideProject(normalized)
      // 幂等：同一点击触发两次时，第二次在权威列表里已存在，直接跳过
      savedDirectoriesStore.commit(list =>
        list.some(d => isSameDirectory(d.path, newDir.path)) ? list : [...list, newDir],
      )
      setCurrentDirectory(normalized)
      return true
    },
    [savedDirectories, setCurrentDirectory],
  )

  // 移除目录
  const removeDirectory = useCallback(
    (path: string) => {
      const normalized = normalizeToForwardSlash(path)
      savedDirectoriesStore.commit(list => {
        const nextList = list.filter(d => !isSameDirectory(d.path, normalized))
        return nextList.length === list.length ? list : nextList
      })
      if (isSameDirectory(urlDirectory, normalized)) {
        setCurrentDirectory(undefined)
      }
      return true
    },
    [urlDirectory, setCurrentDirectory],
  )

  /**
   * 清理已落库的非法目录（非绝对路径）。
   *
   * 老版本会把 `../code/OCC` 这类相对路径存进项目列表，新建项目入口现在会
   * 拦截，但历史数据仍需一次清理：否则侧栏每次都会去请求并失败。
   * 只在确实有非法项时写回，避免无谓的存储写入与同步。
   */
  const pruneInvalidDirectories = useCallback(() => {
    savedDirectoriesStore.commit(list => {
      const valid = list.filter(directory => {
        const normalized = normalizeToForwardSlash(directory.path)
        return !!normalized && normalized !== '.' && isAbsoluteDirectory(normalized)
      })
      return valid.length === list.length ? list : valid
    })
  }, [])

  const reorderDirectories = useCallback((draggedPath: string, targetPath: string) => {
    const normalizedDragged = normalizeToForwardSlash(draggedPath)
    const normalizedTarget = normalizeToForwardSlash(targetPath)

    if (!normalizedDragged || !normalizedTarget || isSameDirectory(normalizedDragged, normalizedTarget)) {
      return
    }

    // 与新增/删除统一走 commit：拖拽重排同样要在 updater 外落盘，且写回当前
    // 活动服务器的桶，避免切主机后顺序写进过期快照的桶里。
    savedDirectoriesStore.commit(list => {
      const draggedIndex = list.findIndex(directory => isSameDirectory(directory.path, normalizedDragged))
      const targetIndex = list.findIndex(directory => isSameDirectory(directory.path, normalizedTarget))

      if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) {
        return list
      }

      const next = [...list]
      const [draggedDirectory] = next.splice(draggedIndex, 1)
      next.splice(targetIndex, 0, draggedDirectory)
      return next
    })
  }, [])

  // Tauri: 启动时获取 CLI 传入的目录 + 监听后续 open-directory 事件
  // 用 ref 持有最新的 addDirectory 避免 stale closure
  const addDirectoryRef = useRef(addDirectory)
  addDirectoryRef.current = addDirectory

  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | undefined

    // 拉取启动时的 CLI 目录（一次性）
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string | null>('get_cli_directory')
        .then(dir => {
          if (dir) addDirectoryRef.current(dir)
        })
        .catch(() => {})
    })

    // 监听后续的 open-directory 事件（single-instance / macOS RunEvent::Opened）
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('open-directory', event => {
        addDirectoryRef.current(event.payload)
      }).then(fn => {
        unlisten = fn
      })
    })

    return () => {
      unlisten?.()
    }
  }, [])

  // 设置侧边栏展开 - 委托给 layoutStore
  const setSidebarExpanded = useCallback((expanded: boolean) => {
    layoutStore.setSidebarExpanded(expanded)
  }, [])

  // 稳定化 Provider value，避免每次渲染创建新对象导致子组件不必要重渲染
  const value = useMemo<DirectoryContextValue>(
    () => ({
      currentDirectory: urlDirectory,
      setCurrentDirectory,
      savedDirectories,
      addDirectory,
      removeDirectory,
      reorderDirectories,
      pruneInvalidDirectories,
      pathInfo,
      sidebarExpanded,
      setSidebarExpanded,
      recentProjects,
    }),
    [
      urlDirectory,
      setCurrentDirectory,
      savedDirectories,
      addDirectory,
      removeDirectory,
      reorderDirectories,
      pruneInvalidDirectories,
      pathInfo,
      sidebarExpanded,
      setSidebarExpanded,
      recentProjects,
    ],
  )

  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>
}
