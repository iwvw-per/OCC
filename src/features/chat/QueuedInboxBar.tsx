import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ClockIcon, CloseIcon } from '../../components/Icons'
import type { QueuedInboxItem } from '../../store/messageStoreTypes'

interface QueuedInboxBarProps {
  items: QueuedInboxItem[]
  onCancel: (inboxId: string) => void
}

/**
 * 「排队中」消息条(v2 `session.inbox.enqueued` → `.delivered`)。
 *
 * 为什么需要:排队中的用户消息在消息流里和已发送的长得一样,用户不知道它其实
 * 还没被 runner 取走;此前唯一能中止它的办法是**中止整个会话**。
 *
 * 挂在输入框上方(`InputBox` 的 `topAccessory` 插槽,绝对定位在框体上方),
 * 不参与消息流虚拟列表 —— 避免给高频渲染路径增加负担。
 */
export const QueuedInboxBar = memo(function QueuedInboxBar({ items, onCancel }: QueuedInboxBarProps) {
  const { t } = useTranslation('chat')
  if (items.length === 0) return null
  return (
    <div
      className="pointer-events-auto w-[min(92vw,42rem)] rounded-xl border border-border-200/60 glass px-2 py-1.5 shadow-lg"
      data-queued-inbox
    >
      <div className="flex items-center gap-1.5 px-1 pb-1 text-ui-caption text-text-400">
        <ClockIcon size={12} />
        <span>{t('queuedInbox.title', { count: items.length })}</span>
      </div>
      <ul className="max-h-32 overflow-y-auto custom-scrollbar">
        {items.map(item => (
          <li key={item.id} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-bg-200/60">
            <span className="min-w-0 flex-1 truncate text-ui-base text-text-200" title={item.text}>
              {item.text || t('queuedInbox.attachmentOnly')}
            </span>
            <button
              type="button"
              onClick={() => onCancel(item.id)}
              className="shrink-0 rounded-md p-1 text-text-400 transition-colors hover:bg-bg-300 hover:text-text-100"
              title={t('queuedInbox.cancel')}
              aria-label={t('queuedInbox.cancel')}
            >
              <CloseIcon size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
})
