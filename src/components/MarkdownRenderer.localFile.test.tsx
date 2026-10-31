/**
 * 回归：移动端点「对话里的本地文件链接」时的行为。
 *
 * 背景（2026-11-01）：`openLocalFilePath` 在 Tauri 里调用
 * `@tauri-apps/plugin-opener` 的 `openPath()`，但该插件的 **Android 实现只注册了
 * `open` 命令、没有 `open_path`**（OpenerPlugin.kt 全文只有 `@Command fun open`），
 * 因此安卓上必然 reject；而且这些路径是**主机上**的文件，手机本地并不存在。
 * 原来用 `catch(() => {})` 吞掉失败 —— 用户点链接毫无反应，以为界面坏了。
 *
 * 现在移动端直接给出提示（文件在主机上），桌面端行为不变。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownRenderer } from './MarkdownRenderer'
import { FullscreenProvider } from '../contexts'
import { notificationStore } from '../store/notificationStore'

const tauriMock = vi.hoisted(() => ({ isTauri: true, isTauriMobile: false }))

vi.mock('../utils/tauri', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/tauri')>()
  return {
    ...actual,
    isTauri: () => tauriMock.isTauri,
    isTauriMobile: () => tauriMock.isTauriMobile,
  }
})

vi.mock('pele', () => ({
  render: vi.fn(() => ({ svg: '<svg></svg>' })),
  PeleError: class PeleError extends Error {},
}))

vi.mock('./ui', () => ({
  CopyButton: () => null,
}))

const FILE_PATH = 'C:/Users/test/project/file.ts'

function renderWithLocalLink() {
  return render(
    <FullscreenProvider>
      <MarkdownRenderer content={`<a href="${FILE_PATH}">file.ts</a>`} />
    </FullscreenProvider>,
  )
}

describe('本地文件链接的打开行为', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tauriMock.isTauri = true
    tauriMock.isTauriMobile = false
    toastSpy = vi.spyOn(notificationStore, 'toast').mockImplementation(() => {})
  })

  afterEach(() => {
    toastSpy.mockRestore()
  })

  it('移动端不尝试 openPath，而是提示「文件在主机上」', () => {
    tauriMock.isTauriMobile = true
    renderWithLocalLink()

    fireEvent.click(screen.getByRole('link', { name: 'file.ts' }))

    expect(toastSpy).toHaveBeenCalledTimes(1)
    // 断言行为而非文案：第一个参数是通知类型，第二个是提示文案
    expect(toastSpy.mock.calls[0][0]).toBe('completed')
    expect(String(toastSpy.mock.calls[0][1])).not.toHaveLength(0)
  })

  it('桌面端不弹这个提示（仍走系统打开）', () => {
    renderWithLocalLink()

    fireEvent.click(screen.getByRole('link', { name: 'file.ts' }))

    expect(toastSpy).not.toHaveBeenCalled()
  })
})
