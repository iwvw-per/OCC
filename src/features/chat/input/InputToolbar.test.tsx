import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InputToolbar } from './InputToolbar'

const useIsMobileMock = vi.fn()
const isTauriMock = vi.fn()
const isTauriMobileMock = vi.fn()
const openMock = vi.fn()
const readFileMock = vi.fn()

vi.mock('../../../hooks', () => ({
  useIsMobile: () => useIsMobileMock(),
}))

vi.mock('../chatViewport', () => ({
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

vi.mock('../../../utils/tauri', () => ({
  isTauri: () => isTauriMock(),
  isTauriMobile: () => isTauriMobileMock(),
  extToMime: (ext: string) => {
    if (ext === 'png') return 'image/png'
    return 'application/octet-stream'
  },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openMock(...args),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}))

vi.mock('../../../components/ui', () => ({
  DropdownMenu: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
  MenuItem: ({
    label,
    onClick,
    selectionRole,
    selected,
  }: {
    label: string
    onClick: () => void
    selectionRole?: 'menuitemradio' | 'option'
    selected?: boolean
  }) => {
    const selectionProps =
      selectionRole === 'menuitemradio'
        ? { role: selectionRole, 'aria-checked': selected, tabIndex: selected ? 0 : -1 }
        : selectionRole === 'option'
          ? { role: selectionRole, 'aria-selected': selected, tabIndex: selected ? 0 : -1 }
          : {}

    return (
      <button type="button" onClick={onClick} {...selectionProps}>
        {label}
      </button>
    )
  },
  IconButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AnimatedPresence: ({ show, children }: { show: boolean; children: React.ReactNode }) =>
    show ? <>{children}</> : null,
}))

vi.mock('../ModelSelector', () => ({
  ModelSelector: () => null,
}))

describe('InputToolbar file selection', () => {
  beforeEach(() => {
    useIsMobileMock.mockReturnValue(false)
    isTauriMock.mockReturnValue(false)
    isTauriMobileMock.mockReturnValue(false)
    openMock.mockReset()
    readFileMock.mockReset()
  })

  it('uses the browser file input on Tauri mobile', () => {
    useIsMobileMock.mockReturnValue(true)
    isTauriMock.mockReturnValue(true)
    isTauriMobileMock.mockReturnValue(true)

    const onFilesSelected = vi.fn()
    const inputClickSpy = vi.spyOn(HTMLInputElement.prototype, 'click')

    const { container } = render(
      <InputToolbar
        fileCapabilities={{ image: true, pdf: false, audio: false, video: false }}
        onFilesSelected={onFilesSelected}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    expect(inputClickSpy).toHaveBeenCalledTimes(1)

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(onFilesSelected).toHaveBeenCalledWith([file])
    inputClickSpy.mockRestore()
  })

  it('uses the Tauri native picker on desktop', async () => {
    isTauriMock.mockReturnValue(true)
    isTauriMobileMock.mockReturnValue(false)
    openMock.mockResolvedValue(['/tmp/photo.png'])
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]))

    const onFilesSelected = vi.fn()

    render(
      <InputToolbar
        fileCapabilities={{ image: true, pdf: false, audio: false, video: false }}
        onFilesSelected={onFilesSelected}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledTimes(1)
      expect(readFileMock).toHaveBeenCalledWith('/tmp/photo.png')
      expect(onFilesSelected).toHaveBeenCalledTimes(1)
    })

    const [files] = onFilesSelected.mock.calls[0] as [File[]]
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('photo.png')
    expect(files[0].type).toBe('image/png')
  })

  it('工具栏不再提供 Agent 模式选择（Build/Plan 已从输入框移除）', () => {
    // 回归：模式选择曾占据工具栏最左位，与模型选择器抢空间。
    // 现在只能通过快捷键 / 命令面板切换 Agent。
    const { container } = render(
      <InputToolbar
        variants={['low', 'high']}
        selectedVariant="low"
        onVariantChange={vi.fn()}
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
      />,
    )

    expect(screen.queryByRole('menuitemradio', { name: 'Build' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: 'Plan' })).not.toBeInTheDocument()
    // 工具栏里唯一的菜单触发器现在是模型变体选择
    const triggers = container.querySelectorAll('[aria-haspopup="menu"]')
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toHaveTextContent('Low')
  })

  it('moves focus into the opened variant menu and exposes menu semantics', async () => {
    render(
      <InputToolbar
        variants={['low', 'high']}
        selectedVariant="low"
        onVariantChange={vi.fn()}
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
      />,
    )

    const trigger = screen.getByTitle('Low')

    fireEvent.click(trigger)

    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('menuitemradio', { name: 'Low' })).toHaveFocus()
    })
  })

  it('closes the variant menu on Tab and moves focus to the next toolbar control', async () => {
    render(
      <InputToolbar
        variants={['low', 'high']}
        selectedVariant="low"
        onVariantChange={vi.fn()}
        fileCapabilities={{ image: true, pdf: false, audio: false, video: false }}
        onFilesSelected={vi.fn()}
      />,
    )

    const trigger = screen.getByTitle('Low')
    fireEvent.click(trigger)

    const selectedItem = await screen.findByRole('menuitemradio', { name: 'Low' })
    fireEvent.keyDown(selectedItem, { key: 'Tab' })

    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      // 发送按钮已迁到 ChatFab；Tab 从菜单移出后落到工具栏内的附件按钮
      expect(screen.getByRole('button', { name: 'Attach file' })).toHaveFocus()
    })
  })

  it('returns focus to the composer after selecting a variant', async () => {
    function ToolbarHarness() {
      const containerRef = useRef<HTMLDivElement>(null)

      return (
        <div ref={containerRef}>
          <textarea aria-label="Chat input" />
          <InputToolbar
            variants={['low', 'high']}
            selectedVariant="low"
            onVariantChange={vi.fn()}
            fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
            onFilesSelected={vi.fn()}
            inputContainerRef={containerRef}
          />
        </div>
      )
    }

    render(<ToolbarHarness />)

    fireEvent.click(screen.getByTitle('Low'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' }))

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat input' })).toHaveFocus())
  })
})
