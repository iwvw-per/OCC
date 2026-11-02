import { createContext } from 'react'
import type { ApiPath } from '../api'

export interface SavedDirectory {
  path: string
  name: string
  addedAt: number
}

export interface DirectoryContextValue {
  currentDirectory: string | undefined
  setCurrentDirectory: (directory: string | undefined) => void
  savedDirectories: SavedDirectory[]
  /** 添加项目目录；非绝对路径会被拒绝并返回 false */
  addDirectory: (path: string) => boolean
  /**
   * 只把目录登记进侧栏项目列表（或解除隐藏），**不改变当前目录、不写 URL**。
   *
   * 与 `addDirectory` 的差别只在副作用：`addDirectory` 是「用户主动添加项目」，
   * 会把当前目录切过去（写 URL）；发送一条消息时我们只想让这个目录在侧栏
   * 里有个归属行，绝不能因为登记而把 URL 里正在看的 session 路由清掉
   * （见 useRouter.setDirectory：它 write 的是 sessionId=null 的 hash）。
   *
   * @returns 是否已存在（true 表示此前就在列表里）
   */
  registerDirectory: (path: string) => boolean
  removeDirectory: (path: string) => void
  reorderDirectories: (draggedPath: string, targetPath: string) => void
  /** 清理历史数据里存下的非法目录（非绝对路径），仅在确有非法项时写回 */
  pruneInvalidDirectories: () => void
  pathInfo: ApiPath | null
  sidebarExpanded: boolean
  setSidebarExpanded: (expanded: boolean) => void
  recentProjects: Record<string, number>
}

export const DirectoryContext = createContext<DirectoryContextValue | null>(null)
