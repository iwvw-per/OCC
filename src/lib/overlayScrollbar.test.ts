import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disposeOverlayScrollbars, initOverlayScrollbars } from './overlayScrollbar'

function makeScrollContainer(): { parent: HTMLDivElement; vp: HTMLDivElement } {
  const parent = document.createElement('div')
  const vp = document.createElement('div')
  // jsdom 的默认 overflow 计算值是空串，需要显式内联样式才能被 isScrollable 识别
  vp.style.overflowY = 'auto'
  parent.appendChild(vp)
  document.body.appendChild(parent)

  Object.defineProperty(vp, 'scrollHeight', { configurable: true, value: 400 })
  Object.defineProperty(vp, 'clientHeight', { configurable: true, value: 100 })
  Object.defineProperty(vp, 'scrollWidth', { configurable: true, value: 200 })
  Object.defineProperty(vp, 'clientWidth', { configurable: true, value: 200 })

  return { parent, vp }
}

describe('overlayScrollbar lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    disposeOverlayScrollbars()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('injects thumb DOM for scrollable containers', () => {
    const { parent } = makeScrollContainer()
    initOverlayScrollbars()

    expect(parent.querySelector('.os-thumb')).not.toBeNull()
  })

  it('is idempotent — a second init does not duplicate work', () => {
    const { parent } = makeScrollContainer()
    initOverlayScrollbars()
    initOverlayScrollbars()

    expect(parent.querySelectorAll('.os-thumb')).toHaveLength(1)
  })

  it('dispose removes every injected thumb and resumes cleanly', () => {
    const { parent, vp } = makeScrollContainer()
    initOverlayScrollbars()
    expect(parent.querySelectorAll('.os-thumb').length).toBeGreaterThan(0)

    disposeOverlayScrollbars()

    expect(parent.querySelectorAll('.os-thumb')).toHaveLength(0)
    expect(vp.hasAttribute('data-os')).toBe(false)

    // 可再次 init 并重新注入
    initOverlayScrollbars()
    expect(parent.querySelectorAll('.os-thumb').length).toBeGreaterThan(0)
  })

  it('dispose stops the mutation observer from scanning further', async () => {
    makeScrollContainer()
    initOverlayScrollbars()

    // 新的可滚动容器出现，初始化后会因 MutationObserver 被注入
    const { parent: lateParent } = makeScrollContainer()
    await vi.waitFor(() => {
      expect(lateParent.querySelector('.os-thumb')).not.toBeNull()
    })

    disposeOverlayScrollbars()

    // dispose 后再出现新容器，不应再被扫描注入
    const { parent: afterParent } = makeScrollContainer()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(afterParent.querySelector('.os-thumb')).toBeNull()
  })
  it('detaches a removed scroll container even while mutations keep streaming in', async () => {
    const { parent, vp } = makeScrollContainer()
    initOverlayScrollbars()
    await vi.waitFor(() => {
      expect(parent.querySelector('.os-thumb')).not.toBeNull()
    })

    // 模拟会话 remount：容器从 DOM 摘除
    parent.remove()
    expect(vp.hasAttribute('data-os')).toBe(true)

    // 持续注入无关 mutation（模拟流式渲染不断改写 DOM），期间仍应清理已摘除的 entry
    const noise = document.createElement('div')
    document.body.appendChild(noise)
    const streamTimer = setInterval(() => {
      noise.appendChild(document.createElement('span'))
    }, 20)

    try {
      await vi.waitFor(() => {
        expect(vp.hasAttribute('data-os')).toBe(false)
      })
    } finally {
      clearInterval(streamTimer)
    }
  })

  it('dispose removes the window resize listener', () => {
    initOverlayScrollbars()
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    disposeOverlayScrollbars()

    const removedResize = removeSpy.mock.calls.some(call => (call[0] as string) === 'resize')
    expect(removedResize).toBe(true)
  })

  it('dispose disconnects the ResizeObserver', () => {
    const disconnect = vi.fn()
    class TrackingResizeObserver {
      observe() {}
      unobserve() {}
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', TrackingResizeObserver)

    makeScrollContainer()
    initOverlayScrollbars()
    disposeOverlayScrollbars()

    expect(disconnect).toHaveBeenCalled()
  })

  it('a fresh init after dispose re-observes instead of reusing stale state', () => {
    const disconnect = vi.fn()
    class TrackingResizeObserver {
      observe() {}
      unobserve() {}
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', TrackingResizeObserver)

    makeScrollContainer()
    initOverlayScrollbars()
    disposeOverlayScrollbars()
    const firstDisconnects = disconnect.mock.calls.length

    // 再次 init 后 dispose 应再次断开新创建的 observer
    initOverlayScrollbars()
    disposeOverlayScrollbars()

    expect(disconnect.mock.calls.length).toBeGreaterThan(firstDisconnects)
  })
})

/**
 * 拖拽回归。
 *
 * 旧实现只在 thumb 自身监听 pointermove / pointerup，收到 pointercancel
 * 或指针捕获丢失时不会结束拖拽 —— `dragging` 永久为 true，滑块卡住。
 * 另外 `dragging` 是布尔快照（恒 false），导致拖拽中 thumb 被淡出。
 */
describe('overlayScrollbar thumb drag', () => {
  const VIEWPORT_H = 600
  const CONTENT_H = 6000
  const THUMB_H = 60

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    disposeOverlayScrollbars()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function setup() {
    const { parent, vp } = makeScrollContainer()
    Object.defineProperty(vp, 'scrollHeight', { configurable: true, value: CONTENT_H })
    Object.defineProperty(vp, 'clientHeight', { configurable: true, value: VIEWPORT_H })
    vp.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      bottom: VIEWPORT_H,
      right: 200,
      width: 200,
      height: VIEWPORT_H,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    parent.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      bottom: VIEWPORT_H,
      right: 200,
      width: 200,
      height: VIEWPORT_H,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    initOverlayScrollbars()
    const thumb = parent.querySelector<HTMLDivElement>('.os-thumb')!
    // jsdom 没有布局，offsetHeight 恒 0；固定成可控值让行程计算可断言
    Object.defineProperty(thumb, 'offsetHeight', { configurable: true, value: THUMB_H })
    thumb.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      bottom: THUMB_H,
      right: 12,
      width: 12,
      height: THUMB_H,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    return { parent, vp, thumb }
  }

  function pointer(type: string, init: PointerEventInit) {
    return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', ...init })
  }

  it('drags the viewport along with the pointer', () => {
    const { vp, thumb } = setup()
    const track = VIEWPORT_H - 8 * 2
    const travel = track - THUMB_H
    const maxScroll = CONTENT_H - VIEWPORT_H

    thumb.dispatchEvent(pointer('pointerdown', { clientY: 100, button: 0 }))
    expect(thumb.classList.contains('os-dragging')).toBe(true)

    // 偏移半个行程 → 应滚到一半
    document.dispatchEvent(pointer('pointermove', { clientY: 100 + travel / 2 }))
    expect(vp.scrollTop).toBeCloseTo(maxScroll / 2, 0)

    document.dispatchEvent(pointer('pointerup', {}))
    expect(thumb.classList.contains('os-dragging')).toBe(false)
  })

  it('ends the drag on pointercancel — a later move must not scroll', () => {
    const { vp, thumb } = setup()

    thumb.dispatchEvent(pointer('pointerdown', { clientY: 100, button: 0 }))
    document.dispatchEvent(pointer('pointermove', { clientY: 120 }))
    const afterMove = vp.scrollTop
    expect(afterMove).toBeGreaterThan(0)

    document.dispatchEvent(pointer('pointercancel', {}))
    expect(thumb.classList.contains('os-dragging')).toBe(false)

    document.dispatchEvent(pointer('pointermove', { clientY: 500 }))
    expect(vp.scrollTop).toBe(afterMove)
  })

  it('ends the drag when pointer capture is lost', () => {
    const { vp, thumb } = setup()

    thumb.dispatchEvent(pointer('pointerdown', { clientY: 100, button: 0 }))
    document.dispatchEvent(pointer('pointermove', { clientY: 130 }))
    const afterMove = vp.scrollTop

    thumb.dispatchEvent(pointer('lostpointercapture', {}))
    expect(thumb.classList.contains('os-dragging')).toBe(false)

    document.dispatchEvent(pointer('pointermove', { clientY: 600 }))
    expect(vp.scrollTop).toBe(afterMove)
  })

  it('keeps the thumb visible while dragging (fade must not win)', async () => {
    const { thumb } = setup()
    thumb.classList.add('os-visible')

    thumb.dispatchEvent(pointer('pointerdown', { clientY: 100, button: 0 }))
    // 触发一次 scroll → reveal/scheduleFade 会排一个 800ms 的淡出
    document.dispatchEvent(pointer('pointermove', { clientY: 150 }))
    await new Promise(resolve => setTimeout(resolve, 900))

    expect(thumb.classList.contains('os-visible')).toBe(true)
    document.dispatchEvent(pointer('pointerup', {}))
  })

  it('detaching mid-drag releases document listeners instead of leaking them', async () => {
    const { parent, vp, thumb } = setup()

    thumb.dispatchEvent(pointer('pointerdown', { clientY: 100, button: 0 }))
    const scrollAtDown = vp.scrollTop

    // 模拟容器被从 DOM 摘除：下一批 mutation（debounce 200ms）会 detach 并 destroy thumb
    parent.remove()
    await new Promise(resolve => setTimeout(resolve, 400))

    expect(thumb.isConnected).toBe(false)
    // destroy 已结束拖拽：之后移动指针不应再改动 vp
    document.dispatchEvent(pointer('pointermove', { clientY: 500 }))
    expect(vp.scrollTop).toBe(scrollAtDown)
  })
})
