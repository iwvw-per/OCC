import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DesktopTitlebar } from './DesktopTitlebar'

const {
  useThemeMock,
  useUpdateStoreMock,
  hasUpdateAvailableMock,
  getDesktopPlatformMock,
  usesCustomDesktopTitlebarMock,
  getCurrentWindowMock,
} = vi.hoisted(() => ({
  useThemeMock: vi.fn(() => ({ mode: 'dark', resolvedTheme: 'dark' })),
  useUpdateStoreMock: vi.fn(() => ({})),
  hasUpdateAvailableMock: vi.fn(() => false),
  getDesktopPlatformMock: vi.fn(() => 'windows'),
  usesCustomDesktopTitlebarMock: vi.fn(() => true),
  getCurrentWindowMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => useThemeMock(),
}))

vi.mock('../store/updateStore', () => ({
  useUpdateStore: () => useUpdateStoreMock(),
  hasUpdateAvailable: () => hasUpdateAvailableMock(),
}))

vi.mock('../utils/tauri', () => ({
  isTauri: () => false,
  getDesktopPlatform: () => getDesktopPlatformMock(),
  usesCustomDesktopTitlebar: () => usesCustomDesktopTitlebarMock(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => getCurrentWindowMock(),
}))

function installWindowApiMock(
  overrides: Partial<Record<'minimize' | 'toggleMaximize' | 'close' | 'isMaximized' | 'onResized', unknown>> = {},
) {
  const win = {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
    ...overrides,
  }
  getCurrentWindowMock.mockReturnValue(win)
  return win
}

describe('DesktopTitlebar', () => {
  it('renders self-drawn Windows controls', () => {
    installWindowApiMock()
    render(<DesktopTitlebar />)

    expect(screen.getByRole('button', { name: 'desktopTitlebar.minimize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'desktopTitlebar.maximize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'desktopTitlebar.close' })).toBeInTheDocument()
  })

  it('vertically centers the titlebar nav controls (narrow Windows)', () => {
    installWindowApiMock()
    render(<DesktopTitlebar />)

    // 窄屏(<768)Windows 会把导航控件放回标题栏左侧。固定 size-8 的 IconButton
    // 必须居中:items-stretch 会把它顶到 44px 标题栏上方(实测上 0 / 下 12),
    // 与居中的标题、窗口控制按钮错位。
    const back = screen.getByRole('button', { name: 'desktopTitlebar.goBack' })
    const group = back.parentElement as HTMLElement
    expect(group.className).toContain('items-center')
    expect(group.className).not.toContain('items-stretch')
  })

  it('calls the Tauri window API from the controls', () => {
    const win = installWindowApiMock()
    render(<DesktopTitlebar />)

    fireEvent.click(screen.getByRole('button', { name: 'desktopTitlebar.minimize' }))
    fireEvent.click(screen.getByRole('button', { name: 'desktopTitlebar.maximize' }))
    fireEvent.click(screen.getByRole('button', { name: 'desktopTitlebar.close' }))

    expect(win.minimize).toHaveBeenCalledOnce()
    expect(win.toggleMaximize).toHaveBeenCalledOnce()
    expect(win.close).toHaveBeenCalledOnce()
  })

  it('uses restore label when the window is maximized', async () => {
    installWindowApiMock({ isMaximized: vi.fn(async () => true) })
    render(<DesktopTitlebar />)

    expect(await screen.findByRole('button', { name: 'desktopTitlebar.restore' })).toBeInTheDocument()
  })
})
