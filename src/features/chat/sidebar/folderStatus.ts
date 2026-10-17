// ============================================
// 项目行状态汇总（纯函数，便于单测）
// ============================================
//
// 约束：
// 1. 必须同时按 serverId 收窄 —— 项目列表只展示活动服务器的会话，而 busy/通知
//    数据是全服务器的并集。仅按 directory 匹配会让另一台服务器上同名路径的
//    会话状态（含未读点）挂到本服务器项目行上，而那一行对应的会话并不在列表里，
//    点不到也清不掉。
// 2. 状态分档必须与会话行（minimal SessionListItem）一致：
//    permission > question > retry > working > unread。

import { isSameDirectory } from '../../../utils/directoryUtils'
import { notificationServerId } from '../../../store/notificationStore'
import { sessionKeyToServerId } from '../../../utils/sessionKey'
import type { NotificationEntry } from '../../../store/notificationStore'
import type { ActiveSessionEntry } from '../../../store/activeSessionStore'

export type FolderStatusKind = 'working' | 'permission' | 'question' | 'retry' | 'unread'

export interface FolderStatus {
  kind: FolderStatusKind
  dot: string
  label: string
  count?: number
}

/**
 * 项目行可用的活跃条目。`source` 缺省视为服务端状态（mock/旧数据），
 * 只有显式标成 'pending' 的才被当作「服务端已 idle、仅剩未回复请求」，
 * 不计入运行中（否则折叠的目录会一直转圈）。
 */
export type FolderStatusSession = Pick<ActiveSessionEntry, 'sessionId' | 'directory'> & {
  status: ActiveSessionEntry['status']
  pendingAction?: ActiveSessionEntry['pendingAction']
  source?: ActiveSessionEntry['source']
}

export interface FolderStatusInput {
  serverId: string
  directories: string[]
  busySessions: FolderStatusSession[]
  notifications: NotificationEntry[]
  t: (key: string) => string
}

function matchesAnyDirectory(directory: string | undefined, candidates: string[]) {
  if (!directory) return false
  return candidates.some(candidate => isSameDirectory(candidate, directory))
}

export function buildFolderStatus({
  serverId,
  directories,
  busySessions,
  notifications,
  t,
}: FolderStatusInput): FolderStatus | null {
  if (directories.length === 0) return null

  const dirSessions = busySessions.filter(
    entry => sessionKeyToServerId(entry.sessionId) === serverId && matchesAnyDirectory(entry.directory, directories),
  )

  if (dirSessions.length > 0) {
    let hasPermission = false
    let hasQuestion = false
    let hasRetry = false
    let hasRunning = false

    for (const session of dirSessions) {
      // 「等用户回复」优先于「在跑」：一条从未点开的权限请求不应该表现成运行中。
      if (session.pendingAction?.type === 'permission') hasPermission = true
      else if (session.pendingAction?.type === 'question') hasQuestion = true
      else if (session.status.type === 'retry') hasRetry = true
      // source === 'pending' 表示服务端已 idle、只是请求还悬着：不进 running，
      // 否则折叠的目录会因为一个没人看的权限请求一直转圈。
      else if (session.source !== 'pending') hasRunning = true
    }

    const count = dirSessions.length
    if (hasPermission) {
      return {
        kind: 'permission',
        dot: 'bg-warning-100',
        label: t('chat:activeSession.awaitingPermission'),
        count,
      }
    }
    if (hasQuestion) {
      return {
        kind: 'question',
        dot: 'bg-info-100',
        label: t('chat:activeSession.awaitingAnswer'),
        count,
      }
    }
    if (hasRetry) {
      return {
        kind: 'retry',
        dot: 'bg-warning-100',
        label: t('chat:activeSession.retrying'),
        count,
      }
    }

    if (!hasRunning) return null

    return {
      kind: 'working',
      dot: 'bg-success-100',
      label: t('chat:activeSession.working'),
      count,
    }
  }

  const hasUnreadCompleted = notifications.some(
    notification =>
      notification.type === 'completed' &&
      !notification.read &&
      notificationServerId(notification) === serverId &&
      matchesAnyDirectory(notification.directory, directories),
  )

  if (hasUnreadCompleted) {
    return {
      kind: 'unread',
      dot: 'bg-accent-main-100',
      label: t('chat:notification.completed'),
    }
  }

  return null
}
