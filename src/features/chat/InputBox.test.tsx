import { forwardRef, useImperativeHandle, type ForwardedRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InputBox } from './InputBox'
import type { Command } from '../../api/command'
import type { Message } from '../../types/message'

let slashCommands: Command[] = []
let messagesMock: Message[] = []

function createHistoryMessage(text: string): Message {
  return {
    info: { role: 'user' },
    content: [{ type: 'text', text, synthetic: false }],
  } as unknown as Message
}

vi.mock('../attachment', () => ({
  AttachmentPreview: () => null,
}))

const viewportState = vi.hoisted(() => ({ enableCollapsedInputDock: false }))

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
      enableCollapsedInputDock: viewportState.enableCollapsedInputDock,
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
  SlashCommandMenu: forwardRef(
    (
      { isOpen, onSelect }: { isOpen: boolean; onSelect: (command: Command) => void },
      ref: ForwardedRef<{ moveUp: () => void; moveDown: () => void; selectCurrent: () => void }>,
    ) => {
      useImperativeHandle(
        ref,
        () => ({
          moveUp: () => {},
          moveDown: () => {},
          selectCurrent: () => {
            const command = slashCommands[0]
            if (command) onSelect(command)
          },
        }),
        [onSelect],
      )

      return isOpen ? (
        <div>
          {slashCommands.map(command => (
            <button key={command.name} type="button" onClick={() => onSelect(command)}>
              {command.name}
            </button>
          ))}
        </div>
      ) : null
    },
  ),
}))

// 发送/停止已迁到右下角的 ChatFab；工具栏 mock 只保留结构占位。
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
  useMessages: () => messagesMock,
}))

vi.mock('../../store/keybindingStore', () => ({
  keybindingStore: {
    getKey: (action: string) => (action === 'sendMessage' ? 'Enter' : null),
  },
  matchesKeybinding: (event: KeyboardEvent, key: string) => key === 'Enter' && event.key === 'Enter',
}))

describe('InputBox 收起动画', () => {
  beforeEach(() => {
    viewportState.enableCollapsedInputDock = false
  })

  it('展开态：输入区可见、无 data-collapsed、无胶囊内容层', () => {
    render(<InputBox paneId="pane-test" onSend={vi.fn()} />)

    const inputBox = document.querySelector('[data-input-box]') as HTMLElement
    expect(inputBox).not.toBeNull()
    // 收起态由容器自身的 data-collapsed + CSS 几何变形表达，展开态不应带该属性
    expect(inputBox.hasAttribute('data-collapsed')).toBe(false)
    // 独立胶囊组件已移除，收起文案改为容器内的绝对定位层
    expect(document.querySelector('.animate-composer-capsule-in')).toBeNull()
  })

  it('启用收起且离底时：同一个输入框容器带上 data-collapsed（单元素形变）', () => {
    viewportState.enableCollapsedInputDock = true
    render(<InputBox paneId="pane-test" onSend={vi.fn()} isAtBottom={false} />)

    const inputBox = document.querySelector('[data-input-box]') as HTMLElement
    expect(inputBox).not.toBeNull()
    expect(inputBox.hasAttribute('data-collapsed')).toBe(true)
    // 仍然是同一个容器，没有被替换成独立的胶囊元素
    expect(document.querySelector('.animate-composer-capsule-in')).toBeNull()
  })

  it('收起翻转时：挂上 data-morphing 打开 CSS 几何过渡，并把高度写成药丸像素值', () => {
    viewportState.enableCollapsedInputDock = true
    const { rerender } = render(<InputBox paneId="pane-test" onSend={vi.fn()} isAtBottom />)

    const inputBox = document.querySelector('[data-input-box]') as HTMLElement
    expect(inputBox.hasAttribute('data-morphing')).toBe(false)

    rerender(<InputBox paneId="pane-test" onSend={vi.fn()} isAtBottom={false} />)

    // 几何动画交给 CSS：翻转那一帧挂 data-morphing，收起态再叠加 data-collapsed。
    expect(inputBox.hasAttribute('data-morphing')).toBe(true)
    expect(inputBox.hasAttribute('data-collapsed')).toBe(true)
    // 高度两端都是确定像素值，CSS 才能插值（展开态由 syncBoxHeight 写自然高度）。
    // 收起态药丸高度与 ChatFab 收起态等高（--chat-fab-collapsed-size = 36px），
    // 两者并排时视觉上是一组；见 InputBox.tsx 的 COLLAPSED_BOX_HEIGHT。
    expect(inputBox.style.height).toBe('36px')
    // 宽度/圆角与 data-morphing 同帧写入内联样式（不能放 CSS 属性选择器，
    // 否则宽度会在过渡 armed 前被定型 → 横向瞬跳）。见 COLLAPSED_BOX_WIDTH。
    expect(inputBox.style.width).toBe('132px')
    expect(inputBox.style.borderRadius).toBe('24px')
  })

  it('FAB 在收起态是「回到底部」，展开态是「发送」，且是锚点的子节点', () => {
    viewportState.enableCollapsedInputDock = false
    const { rerender } = render(<InputBox paneId="pane-test" onSend={vi.fn()} />)

    const anchor = document.querySelector('.chat-fab-anchor') as HTMLElement
    expect(anchor).not.toBeNull()
    // FAB 必须挂在锚点内部，right 才会相对输入框右缘解析
    const fab = anchor.querySelector('.chat-fab') as HTMLButtonElement
    expect(fab).not.toBeNull()
    expect(fab.dataset.collapsed).toBe('false')
    expect(fab.dataset.mode).toBe('send')

    // 离底 + 启用收起 → 收起态，FAB 变回底
    viewportState.enableCollapsedInputDock = true
    rerender(<InputBox paneId="pane-test" onSend={vi.fn()} isAtBottom={false} />)
    expect(fab.dataset.collapsed).toBe('true')
    expect(fab.dataset.mode).toBe('scroll')
  })

  it('收起过渡已结束、收尾 rAF 未执行时立刻展开：旧世代的收尾不得摘掉新动画的 data-morphing', async () => {
    viewportState.enableCollapsedInputDock = true
    const { rerender } = render(<InputBox paneId="pane-test" onSend={vi.fn()} isAtBottom />)

    const inputBox = document.querySelector('[data-input-box]') as HTMLElement

    rerender(<InputBox paneId="pane-test" onSend={vi.fn()} isAtBottom={false} />)
    expect(inputBox.hasAttribute('data-morphing')).toBe(true)

    // 收起过渡结束：收尾被合并进 rAF，此刻还没执行
    fireEvent.transitionEnd(inputBox, { propertyName: 'width', elapsedTime: 0.52 })

    // rAF 落地之前用户又展开 → 进入新世代
    rerender(<InputBox paneId="pane-test" onSend={vi.fn()} isAtBottom />)
    expect(inputBox.hasAttribute('data-morphing')).toBe(true)
    // 展开态清掉内联几何，回到 CSS 的 width:100%
    expect(inputBox.style.width).toBe('')
    expect(inputBox.style.borderRadius).toBe('')

    // 等旧世代的 rAF 执行完：它必须被世代号丢弃，新动画不能被它打断
    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })
    expect(inputBox.hasAttribute('data-morphing')).toBe(true)
  })

  it('运行中发送请求未返回（isSubmitting 仍为 true）时，FAB 是停止态且不禁用', async () => {
    viewportState.enableCollapsedInputDock = false
    let resolveSend: ((value: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveSend = resolve
        }),
    )
    const onAbort = vi.fn()

    const { rerender } = render(
      <InputBox paneId="pane-test" onSend={onSend} onAbort={onAbort} isStreaming />,
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'running' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    // 输入框已被乐观清空，但 prompt 请求尚未返回 → isSubmitting 仍为 true。
    // 此刻必须进入停止态且可点击，而不是回退到 disabled 的发送态。
    await waitFor(() => {
      expect(textarea.value).toBe('')
    })
    const fab = document.querySelector('.chat-fab') as HTMLButtonElement
    expect(fab.dataset.mode).toBe('stop')
    expect(fab.disabled).toBe(false)

    fireEvent.click(fab)
    expect(onAbort).toHaveBeenCalled()

    // 保持 isStreaming，请求返回后仍是停止态
    rerender(<InputBox paneId="pane-test" onSend={onSend} onAbort={onAbort} isStreaming />)
    await act(async () => {
      resolveSend?.(true)
    })
    expect((document.querySelector('.chat-fab') as HTMLButtonElement).dataset.mode).toBe('stop')
  })
})

describe('InputBox slash command selection', () => {
  beforeEach(() => {
    slashCommands = []
    messagesMock = []
  })

  it('executes frontend commands immediately on selection', async () => {
    slashCommands = [{ name: 'compact', description: 'Compact session', source: 'frontend' }]
    const onCommand = vi.fn()

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'compact' }))

    await waitFor(() => {
      expect(onCommand).toHaveBeenCalledWith('/compact')
      expect(textarea.value).toBe('')
    })
  })

  it('keeps api commands on attachment insertion path', async () => {
    slashCommands = [{ name: 'review', description: 'Run review', source: 'api' }]
    const onCommand = vi.fn()

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'review' }))

    await waitFor(() => {
      expect(onCommand).not.toHaveBeenCalled()
      expect(textarea.value).toBe('/review ')
    })
  })

  it('keeps the draft when sending fails', async () => {
    const onSend = vi.fn().mockResolvedValue(false)

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello world' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('hello world', [], { agent: undefined, variant: undefined })
    })

    expect(textarea.value).toBe('hello world')
  })

  it('clears the draft optimistically and keeps it cleared after send succeeds', async () => {
    let resolveSend: ((value: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveSend = resolve
        }),
    )

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'pending send' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(textarea.value).toBe('')

    await act(async () => {
      resolveSend?.(true)
    })

    await waitFor(() => {
      expect(textarea.value).toBe('')
    })
  })

  it('restores the draft when the send fails and the user has not typed again', async () => {
    let resolveSend: ((value: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveSend = resolve
        }),
    )

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'will fail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(textarea.value).toBe('')

    await act(async () => {
      resolveSend?.(false)
    })

    await waitFor(() => {
      expect(textarea.value).toBe('will fail')
    })
  })

  it('does not clobber text typed while the send was in flight', async () => {
    let resolveSend: ((value: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveSend = resolve
        }),
    )

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(textarea.value).toBe('')

    fireEvent.change(textarea, { target: { value: 'second' } })

    await act(async () => {
      resolveSend?.(false)
    })

    await waitFor(() => {
      expect(textarea.value).toBe('second')
    })
  })

  it('clears api slash command drafts immediately after keyboard submission', async () => {
    slashCommands = [{ name: 'review', description: 'Run review', source: 'api' }]
    let resolveCommand: ((value: boolean) => void) | null = null
    const onCommand = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveCommand = resolve
        }),
    )

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(onCommand).toHaveBeenCalledWith('/review')
    expect(textarea.value).toBe('')
    expect(textarea).not.toBeDisabled()

    fireEvent.change(textarea, { target: { value: 'next prompt' } })
    expect(textarea.value).toBe('next prompt')

    await act(async () => {
      resolveCommand?.(true)
    })
  })

  it('restores api slash command drafts when command submission fails', async () => {
    slashCommands = [{ name: 'review', description: 'Run review', source: 'api' }]
    let resolveCommand: ((value: boolean) => void) | null = null
    const onCommand = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveCommand = resolve
        }),
    )

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'review' }))

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(textarea.value).toBe('')

    await act(async () => {
      resolveCommand?.(false)
    })

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })
  })

  it('restores api slash command drafts when command submission fails synchronously', async () => {
    slashCommands = [{ name: 'review', description: 'Run review', source: 'api' }]
    const onCommand = vi.fn().mockReturnValue(false)

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'review' }))

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })
  })

  it('does not send when Enter confirms IME composition', async () => {
    const onSend = vi.fn()

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '这是一个 test' } })

    fireEvent.compositionStart(textarea)
    fireEvent.compositionEnd(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('这是一个 test', [], { agent: undefined, variant: undefined })
    })
  })

  it('does not send keydown events marked as IME composition', () => {
    const onSend = vi.fn()

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '正在输入' } })
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps navigating multiline history entries with ArrowUp', async () => {
    messagesMock = [createHistoryMessage('first line\nsecond line'), createHistoryMessage('third line\nfourth line')]

    render(<InputBox paneId="pane-test" onSend={vi.fn()} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    await waitFor(() => {
      expect(textarea.value).toBe('third line\nfourth line')
      expect(textarea.selectionStart).toBe(0)
      expect(textarea.selectionEnd).toBe(0)
    })

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    await waitFor(() => {
      expect(textarea.value).toBe('first line\nsecond line')
      expect(textarea.selectionStart).toBe(0)
      expect(textarea.selectionEnd).toBe(0)
    })
  })

  it('moves the caret to the end when navigating forward with ArrowDown', async () => {
    messagesMock = [createHistoryMessage('older line\nentry'), createHistoryMessage('newer line\nentry')]

    render(<InputBox paneId="pane-test" onSend={vi.fn()} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(textarea.value).toBe('newer line\nentry')
    })

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(textarea.value).toBe('older line\nentry')
      expect(textarea.selectionStart).toBe(0)
    })

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })

    await waitFor(() => {
      expect(textarea.value).toBe('newer line\nentry')
      expect(textarea.selectionStart).toBe('newer line\nentry'.length)
      expect(textarea.selectionEnd).toBe('newer line\nentry'.length)
    })
  })
})
