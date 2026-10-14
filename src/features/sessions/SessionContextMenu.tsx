// ============================================
// SessionContextMenu — 会话行右键菜单
// ============================================
//
// 集中承载会话级操作：重命名、AI 重命名、复制 ID、置顶、分享、导出 Markdown、
// 归档、删除。桌面端由右键触发，移动端由长按触发（位置取触点坐标）。
//
// 各动作的执行细节：
// - 重命名：委托给上层进入行内编辑态（本组件不直接改标题，避免与行内编辑重复）。
// - AI 重命名：调用 generateSessionTitle，成功后回调上层刷新列表。
// - 复制 ID：复制原始 sessionId（非复合 key）。
// - 置顶：直接操作 pinnedSessionsStore。
// - 分享：调 shareSession 后复制链接到剪贴板。
// - 导出：exportSessionAsMarkdown。
// - 归档/删除：委托上层（保持二次确认与列表刷新逻辑集中）。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ContextMenu, ContextMenuItem } from '../../components/ui'
import {
  PencilIcon,
  ThinkingIcon,
  CopyIcon,
  PinIcon,
  ShareIcon,
  DownloadIcon,
  ArchiveIcon,
  TrashIcon,
} from '../../components/Icons'
import type { ApiSession } from '../../api'
import { shareSession } from '../../api/session'
import { pinnedSessionsStore } from '../../store/pinnedSessionsStore'
import { serverStore } from '../../store/serverStore'
import { copyTextToClipboard } from '../../utils/clipboard'
import { exportSessionAsMarkdown } from '../../utils/sessionExport'
import { generateSessionTitle, resolveAiRenameModel } from '../../utils/sessionRename'
import { getActiveModels } from '../../api/client'
import { sessionKeyToServerId } from '../../utils/sessionKey'
import { uiErrorHandler } from '../../utils/errorHandling'

export interface SessionContextMenuState {
  x: number
  y: number
  session: ApiSession
  /** 该会话所属的复合 key（多服务器模式），缺省用 session.id */
  activeSessionKey?: string
}

interface SessionContextMenuProps {
  state: SessionContextMenuState
  onClose: () => void
  /** 进入行内重命名编辑态 */
  onRequestRename: (session: ApiSession) => void
  onArchive?: (session: ApiSession) => void | Promise<void>
  onDelete: (session: ApiSession) => void
  /** 标题变更后刷新列表 */
  onChanged?: () => void
  isPinned: boolean
}

export function SessionContextMenu({
  state,
  onClose,
  onRequestRename,
  onArchive,
  onDelete,
  onChanged,
  isPinned,
}: SessionContextMenuProps) {
  const { t } = useTranslation(['commands', 'common'])
  const [busy, setBusy] = useState(false)
  const { session } = state
  const serverId = state.activeSessionKey ? sessionKeyToServerId(state.activeSessionKey) : serverStore.getActiveServerId()

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    onClose()
    try {
      await action()
    } catch (e) {
      uiErrorHandler('session context action', e)
    } finally {
      setBusy(false)
    }
  }

  const handleRename = () => {
    onClose()
    onRequestRename(session)
  }

  const handleAiRename = () =>
    run(async () => {
      const models = await getActiveModels(session.directory, serverId)
      const model = resolveAiRenameModel(models, serverId)
      if (!model) throw new Error('No model available')
      const title = await generateSessionTitle(session, { directory: session.directory, serverId, model })
      if (title) onChanged?.()
    })

  const handleCopyId = () => {
    onClose()
    void copyTextToClipboard(session.id).catch(() => {})
  }

  const handlePin = () => {
    onClose()
    if (isPinned) {
      pinnedSessionsStore.unpin(session.id)
    } else {
      pinnedSessionsStore.pin({
        sessionId: session.id,
        directory: session.directory || '',
        title: session.title || t('sessions.untitledChat', { defaultValue: 'Untitled' }),
      })
    }
  }

  const handleShare = () =>
    run(async () => {
      const shared = await shareSession(session.id, session.directory, serverId)
      if (shared.share?.url) {
        await copyTextToClipboard(shared.share.url)
      }
      onChanged?.()
    })

  const handleExport = () => run(() => exportSessionAsMarkdown(session, { directory: session.directory, serverId }))

  const handleArchive = () => {
    if (!onArchive) return
    onClose()
    void onArchive(session)
  }

  const handleDelete = () => {
    onClose()
    onDelete(session)
  }

  return (
    <ContextMenu position={{ x: state.x, y: state.y }} onClose={onClose} aria-label={t('common:more', { defaultValue: 'More' })}>
      <ContextMenuItem icon={<PencilIcon size={14} />} onClick={handleRename} disabled={busy}>
        {t('sessions.rename', { defaultValue: '重命名' })}
      </ContextMenuItem>
      <ContextMenuItem icon={<ThinkingIcon size={14} />} onClick={handleAiRename} disabled={busy}>
        {t('sessions.aiRename', { defaultValue: '使用 AI 重命名' })}
      </ContextMenuItem>
      <ContextMenuItem icon={<CopyIcon size={14} />} onClick={handleCopyId} disabled={busy}>
        {t('sessions.copyId', { defaultValue: '复制会话 ID' })}
      </ContextMenuItem>
      <ContextMenuItem icon={<PinIcon size={14} />} onClick={handlePin} disabled={busy}>
        {isPinned
          ? t('sessions.unpin', { defaultValue: '取消置顶' })
          : t('sessions.pin', { defaultValue: '置顶会话' })}
      </ContextMenuItem>
      <ContextMenuItem icon={<ShareIcon size={14} />} onClick={handleShare} disabled={busy}>
        {t('sessions.share', { defaultValue: '分享' })}
      </ContextMenuItem>
      <ContextMenuItem icon={<DownloadIcon size={14} />} onClick={handleExport} disabled={busy}>
        {t('sessions.exportMarkdown', { defaultValue: '导出 Markdown' })}
      </ContextMenuItem>
      {onArchive && (
        <ContextMenuItem icon={<ArchiveIcon size={14} />} onClick={handleArchive} disabled={busy}>
          {t('sessions.archive', { defaultValue: '归档' })}
        </ContextMenuItem>
      )}
      <ContextMenuItem icon={<TrashIcon size={14} />} tone="danger" onClick={handleDelete} disabled={busy}>
        {t('common:delete', { defaultValue: '删除' })}
      </ContextMenuItem>
    </ContextMenu>
  )
}
