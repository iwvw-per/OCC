import { createContext } from 'react'
import type { ApiSession } from '../api'

export interface SessionContextValue {
  sessions: ApiSession[]
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  search: string
  setSearch: (term: string) => void
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  /**
   * 新建会话。
   *
   * serverId 必须由调用方（pane）传入：默认用「活动服务器」会让「pane 绑着 A 主机、
   * 活动服务器已切到 B」的场景把会话建到 B 上，消息也随之发错主机。
   */
  createSession: (title?: string, directory?: string, serverId?: string) => Promise<ApiSession>
  deleteSession: (id: string) => Promise<void>
}

export const SessionContext = createContext<SessionContextValue | null>(null)
