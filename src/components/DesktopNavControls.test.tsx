import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'

/**
 * 顶栏最后那个按钮在不同宿主下的语义：
 *   - 桌面端（Tauri）→ 新建原生窗口
 *   - 网页端 → 新建浏览器标签页
 *
 * 以前网页端点了毫无反应（函数内直接 return），看起来像坏按钮。
 */

const isTauriMock = vi.hoisted(() => ({ value: false }))

vi.mock('../utils/tauri', () => ({
  isTauri: () => isTauriMock.value,
  isTauriMobile: () => false,
  getDesktopPlatform: () => (isTauriMock.value ? 'windows' : 'other'),
}))

const { DesktopNavControls } = await import('./DesktopNavControls')

describe('DesktopNavControls new-window button', () => {
  const openSpy = vi.fn()

  beforeEach(() => {
    isTauriMock.value = false
    openSpy.mockReset()
    vi.stubGlobal('open', openSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens a new browser tab on the web, labeled New Tab', () => {
    render(<DesktopNavControls />)

    const button = screen.getByRole('button', { name: 'New Tab' })
    fireEvent.click(button)

    expect(openSpy).toHaveBeenCalledTimes(1)
    // 新标签页落在地会话首页；noopener 防止新页面反向操纵本窗口
    const [url, target, features] = openSpy.mock.calls[0]
    expect(String(url)).toContain('#/')
    expect(target).toBe('_blank')
    expect(String(features)).toContain('noopener')
  })

  it('keeps the New Window label and does not open a tab when running in Tauri', () => {
    isTauriMock.value = true
    render(<DesktopNavControls />)

    const button = screen.getByRole('button', { name: 'New Window' })
    fireEvent.click(button)

    expect(openSpy).not.toHaveBeenCalled()
  })
})
