import { afterEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { CHAT_SURFACE_MIN_WIDTH, useChatViewportController } from './chatViewport'
import { DESKTOP_SIDEBAR_MIN_WIDTH } from '../../constants/desktopWindow'

/**
 * 侧栏宽度必须是「常量」，不随视口 / 设备类型变化。
 *
 * 用户报的是：网页端侧栏比桌面端窄。根因是默认宽度按视口比例算
 * （窄屏 30%~34%，触摸设备 34%~46%），同一个浏览器窗口在不同设备上宽度不同。
 */

const SIDEBAR_DEFAULT = 288
const SIDEBAR_MAX = 480

function stubDevice({ touch }: { touch: boolean }) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: touch ? /coarse|touch/.test(query) : /hover/.test(query) && !/coarse|touch/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

function renderAt(width: number, options: { touch?: boolean } = {}) {
  stubDevice({ touch: options.touch ?? false })
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width })
  return renderHook(() =>
    useChatViewportController({
      sidebarExpanded: true,
      rightPanelOpen: false,
      requestedRightPanelWidth: 450,
      // App 现在对网页端与桌面端传同一组常量
      sidebarRailWidth: 48,
      sidebarHardMinWidth: DESKTOP_SIDEBAR_MIN_WIDTH,
    }),
  )
}

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 })
})

describe('sidebar default width', () => {
  it.each([900, 1024, 1099, 1100, 1440, 2560])('is 288px at a %ipx viewport', width => {
    // 以前 1100 以下按比例收缩；现在所有宽度一致
    expect(renderAt(width).result.current.value.layout.sidebar.requestedWidth).toBe(SIDEBAR_DEFAULT)
  })

  it('is the same on touch devices', () => {
    // 以前触摸设备用 0.34 而不是 0.30，手机/平板与桌面不一致
    expect(renderAt(1024, { touch: true }).result.current.value.layout.sidebar.requestedWidth).toBe(SIDEBAR_DEFAULT)
  })

  it('is unaffected by re-rendering at a different viewport', () => {
    const { result, rerender } = renderAt(1440)
    expect(result.current.value.layout.sidebar.requestedWidth).toBe(SIDEBAR_DEFAULT)

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 960 })
    rerender()
    expect(result.current.value.layout.sidebar.requestedWidth).toBe(SIDEBAR_DEFAULT)
  })
})

describe('sidebar maximum width', () => {
  it('does not scale with the viewport', () => {
    // 以前窄屏上限是 viewportWidth × 40%（960 → 384），现在恒为 480
    expect(renderAt(960).result.current.value.layout.sidebar.maxWidth).toBe(SIDEBAR_MAX)
    expect(renderAt(2560).result.current.value.layout.sidebar.maxWidth).toBe(SIDEBAR_MAX)
  })

  it('uses the same lower bound as the desktop toolbar needs', () => {
    // 两端顶栏是同一排 6 个按钮：下限必须容纳它们，否则网页端能拖到 160
    // 而桌面端是 228，同样的按钮在一端被挤压。
    const { result } = renderAt(1440)
    expect(result.current.value.layout.sidebar.hardMinWidth).toBe(DESKTOP_SIDEBAR_MIN_WIDTH)
    expect(result.current.value.layout.sidebar.hardMinWidth).toBe(228)
  })
})

describe('narrow windows', () => {
  it('keeps the chat surface at least its minimum width', () => {
    // 侧栏不再按比例让位；只有聊天区不足 380 时才收缩侧栏
    const { result } = renderAt(600)
    expect(result.current.value.layout.sidebar.openWidth).toBeGreaterThanOrEqual(288)
    expect(result.current.value.layout.surfaceWidth).toBeGreaterThanOrEqual(CHAT_SURFACE_MIN_WIDTH)
  })

  it('keeps the default width when there is enough room', () => {
    const { result } = renderAt(1200)
    expect(result.current.value.layout.sidebar.openWidth).toBe(SIDEBAR_DEFAULT)
  })
})
