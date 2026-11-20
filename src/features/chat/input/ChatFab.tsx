import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownIcon, SendIcon, StopIcon } from '../../../components/Icons'
import { Spinner } from '../../../components/ui/Spinner'

// ============================================
// ChatFab — 收起态「回到底部」/ 展开态「发送 / 停止」三合一按钮
//
// 几何与图标动画全部由 CSS 驱动（见 index.css 的 .chat-fab）：
// 收起时是药丸右侧的圆按钮，展开时滑到输入框右下角并保持圆形，
// 图标在 ↓ / 发送 / 停止 之间交叉淡入。时长与缓动与输入框变形共用，
// 因此三者逐帧同步。
//
// 定位由外层 .chat-fab-anchor 提供（宽度跟随输入框），本组件只负责外观与交互。
// ============================================

export type ChatFabMode = 'scroll' | 'send' | 'stop'

interface ChatFabProps {
  /** 收起态（药丸）还是展开态（完整输入框） */
  collapsed: boolean
  mode: ChatFabMode
  /** 发送中：发送图标位置显示 spinner */
  sending?: boolean
  disabled?: boolean
  onClick?: () => void
}

export const ChatFab = memo(function ChatFab({ collapsed, mode, sending, disabled, onClick }: ChatFabProps) {
  const { t } = useTranslation(['chat', 'common'])

  const label =
    mode === 'scroll'
      ? t('inputActions.scrollToBottom')
      : mode === 'stop'
        ? t('inputToolbar.stopGeneration')
        : sending
          ? t('inputToolbar.sendingMessage')
          : t('inputToolbar.sendMessage')

  return (
    <button
      type="button"
      data-collapsed={collapsed}
      data-mode={mode}
      data-haptic={mode === 'send' ? 'medium' : mode === 'stop' ? 'strong' : 'light'}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="chat-fab"
    >
      <span className="chat-fab-icon icon-scroll">
        <ArrowDownIcon size={16} />
      </span>
      <span className="chat-fab-icon icon-send">
        {sending ? <Spinner size="xs" tone="current" variant="ring" /> : <SendIcon size={15} />}
      </span>
      <span className="chat-fab-icon icon-stop">
        <StopIcon size={13} />
      </span>
    </button>
  )
})
