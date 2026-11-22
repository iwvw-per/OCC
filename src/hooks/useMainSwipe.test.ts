import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useMainSwipe } from './useMainSwipe'

function touch(x: number, y = 0) {
  return { touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] } as never
}

describe('useMainSwipe', () => {
  it('opens the sidebar after a horizontal swipe past the threshold', () => {
    let opened = 0
    const { result } = renderHook(() =>
      useMainSwipe({ enabled: true, sidebarExpanded: false, rightPanelOpen: false, onOpenSidebar: () => (opened += 1) }),
    )

    result.current.onTouchStart(touch(10))
    result.current.onTouchMove(touch(100))
    result.current.onTouchEnd(touch(100))

    expect(opened).toBe(1)
  })

  it('ignores short swipes and vertical gestures', () => {
    let opened = 0
    const { result } = renderHook(() =>
      useMainSwipe({ enabled: true, sidebarExpanded: false, rightPanelOpen: false, onOpenSidebar: () => (opened += 1) }),
    )

    // 位移不足
    result.current.onTouchStart(touch(10))
    result.current.onTouchEnd(touch(30))
    expect(opened).toBe(0)

    // 纵向滚动
    result.current.onTouchStart(touch(10, 10))
    result.current.onTouchMove(touch(20, 200))
    result.current.onTouchEnd(touch(20, 200))
    expect(opened).toBe(0)
  })

  it('does nothing when a drawer is already open', () => {
    let opened = 0
    const { result } = renderHook(() =>
      useMainSwipe({ enabled: true, sidebarExpanded: true, rightPanelOpen: false, onOpenSidebar: () => (opened += 1) }),
    )

    result.current.onTouchStart(touch(10))
    result.current.onTouchMove(touch(200))
    result.current.onTouchEnd(touch(200))

    expect(opened).toBe(0)
  })

  it('opens the right panel on a left swipe that starts at the right edge', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 })
    let sidebarOpened = 0
    let rightPanelOpened = 0
    const { result } = renderHook(() =>
      useMainSwipe({
        enabled: true,
        sidebarExpanded: false,
        rightPanelOpen: false,
        onOpenSidebar: () => (sidebarOpened += 1),
        onOpenRightPanel: () => (rightPanelOpened += 1),
      }),
    )

    result.current.onTouchStart(touch(1010))
    result.current.onTouchMove(touch(900))
    result.current.onTouchEnd(touch(900))

    expect(rightPanelOpened).toBe(1)
    expect(sidebarOpened).toBe(0)
  })

  it('ignores a left swipe that does not start at the right edge', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 })
    let rightPanelOpened = 0
    const { result } = renderHook(() =>
      useMainSwipe({
        enabled: true,
        sidebarExpanded: false,
        rightPanelOpen: false,
        onOpenSidebar: () => {},
        onOpenRightPanel: () => (rightPanelOpened += 1),
      }),
    )

    result.current.onTouchStart(touch(500))
    result.current.onTouchMove(touch(400))
    result.current.onTouchEnd(touch(400))

    expect(rightPanelOpened).toBe(0)
  })
})
