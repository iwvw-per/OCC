import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InputBox } from './InputBox'
import { REQUEST_BODY_MAX_BYTES } from '../../constants/requestLimits'

/**
 * 发送前的请求体体积预检。
 *
 * 真实故障（2026-11-02）：网关对 prompt 请求体的硬上限是 8MiB，超出返回 413；
 * 而 OCC 在发送前没有任何体积检查，超限时乐观消息被移除、草稿回填，
 * 界面上没有任何提示 —— 用户只看到「点了没反应」。
 *
 * 这里锁定：超限时不调用 onSend、不清空输入框、并弹出可读提示。
 */

const pushMock = vi.hoisted(() => vi.fn())

vi.mock('../attachment', () => ({
  AttachmentPreview: () => null,
}))

vi.mock('./chatViewport', () => ({
  useChatViewport: () => ({
    presentation: { surfaceVariant: 'desktop', isCompact: false },
    interaction: {
      mode: 'pointer',
      touchCapable: false,
      sidebarBehavior: 'docked',
      rightPanelBehavior: 'docked',
      bottomPanelBehavior: 'docked',
      outlineInteraction: 'pointer',
      enableCollapsedInputDock: false,
    },
  }),
}))

vi.mock('../mention', () => ({
  MentionMenu: () => null,
  detectMentionTrigger: () => null,
  normalizePath: (value: string) => value,
  toFileUrl: (value: string) => value,
}))

vi.mock('../slash-command', () => ({
  SlashCommandMenu: () => null,
}))

vi.mock('./input/InputToolbar', () => ({
  InputToolbar: () => null,
}))

vi.mock('./input/InputFooter', () => ({
  InputFooter: () => null,
}))

vi.mock('./input/UndoStatus', () => ({
  UndoStatus: () => null,
}))

vi.mock('../../hooks', () => ({
  useIsMobile: () => false,
  usePresence: (show: boolean) => ({ shouldRender: show, ref: { current: null } }),
}))

vi.mock('../../store/messageStoreHooks', () => ({
  useMessages: () => [],
}))

vi.mock('../../store/keybindingStore', () => ({
  keybindingStore: {
    getKey: (action: string) => (action === 'sendMessage' ? 'Enter' : null),
  },
  matchesKeybinding: (event: KeyboardEvent, key: string) => key === 'Enter' && event.key === 'Enter',
}))

vi.mock('../../store/notificationStore', () => ({
  notificationStore: {
    push: pushMock,
  },
}))

function typeIntoComposer(value: string) {
  const textarea = document.querySelector('textarea') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value } })
  return textarea
}

describe('InputBox 发送体积预检', () => {
  beforeEach(() => {
    pushMock.mockClear()
  })

  it('refuses to send a body above the gateway limit and keeps the draft', async () => {
    const onSend = vi.fn(() => true)
    render(<InputBox paneId="pane-test" onSend={onSend} />)

    // 纯 ASCII 便于把体积精确压在阈值之上
    const textarea = typeIntoComposer('x'.repeat(REQUEST_BODY_MAX_BYTES + 1024))
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledTimes(1)
    const [type, title, body] = pushMock.mock.calls[0]
    expect(type).toBe('error')
    expect(String(title).length).toBeGreaterThan(0)
    expect(String(body)).toContain('8.0 MB')
    // 草稿必须保留：用户还能自己删减后重发
    await waitFor(() => {
      expect((document.querySelector('textarea') as HTMLTextAreaElement).value.length).toBeGreaterThan(
        REQUEST_BODY_MAX_BYTES,
      )
    })
  })

  it('still sends ordinary messages', async () => {
    const onSend = vi.fn(() => true)
    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = typeIntoComposer('你好')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('你好', [], expect.anything()))
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('shows a retry hint when the send itself fails', async () => {
    const onSend = vi.fn(() => {
      throw Object.assign(new Error('UnexpectedStatus: 413'), {
        reason: 'UnexpectedStatus',
        cause: { status: 413 },
      })
    })
    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = typeIntoComposer('继续')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // 失败路径由 uiErrorHandler 记录，草稿按失败回填（内容不丢）
    await waitFor(() => {
      expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('继续')
    })
  })
})
