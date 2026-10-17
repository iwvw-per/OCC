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
