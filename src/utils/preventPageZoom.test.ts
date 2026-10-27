import { beforeEach, describe, expect, it } from 'vitest'
import { preventPageZoom, resetPreventPageZoomForTest } from './preventPageZoom'

/**
 * 页面级双指缩放的拦截。
 *
 * 背景：viewport meta 的 `maximum-scale=1, user-scalable=no` 在 iOS Safari
 * 上被忽略（iOS 10 起为了可访问性），iPhone/iPad 上双指仍能放大整个页面，
 * 放大后聊天界面错位、输入框被推出视口。这里用事件拦截补上 iOS 的缺口。
 *
 * 关键约束：组件级的捏合手势（图片查看器、mermaid 图表）必须放行，
 * 否则那些功能会失效。
 */
describe('preventPageZoom', () => {
  beforeEach(() => {
    resetPreventPageZoomForTest()
    document.body.innerHTML = ''
  })

  function fireGesture(target: Element, type = 'gesturestart'): boolean {
    const event = new Event(type, { bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }

  function fireMultiTouchMove(target: Element, touchCount: number): boolean {
    const event = new Event('touchmove', { bubbles: true, cancelable: true })
    // 手工挂上 touches：jsdom 没有 Touch 构造，直接给个长度够用的数组
    Object.defineProperty(event, 'touches', {
      value: Array.from({ length: touchCount }, () => ({ clientX: 0, clientY: 0 })),
    })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('拦截页面上的 gesturestart / gesturechange', () => {
    preventPageZoom()
    const target = document.body

    expect(fireGesture(target, 'gesturestart')).toBe(true)
    expect(fireGesture(target, 'gesturechange')).toBe(true)
    expect(fireGesture(target, 'gestureend')).toBe(true)
  })

  it('拦截双指 touchmove', () => {
    preventPageZoom()
    expect(fireMultiTouchMove(document.body, 2)).toBe(true)
  })

  it('放行单指 touchmove（滚动不受影响）', () => {
    preventPageZoom()
    expect(fireMultiTouchMove(document.body, 1)).toBe(false)
  })

  it('放行 data-allow-pinch 子树内的捏合手势', () => {
    /**
     * 图片查看器 / mermaid 图表自己实现缩放，全局拦截必须让路，
     * 否则那两个功能直接失效。
     */
    const pinchable = document.createElement('div')
    pinchable.setAttribute('data-allow-pinch', '')
    const inner = document.createElement('div')
    pinchable.appendChild(inner)
    document.body.appendChild(pinchable)

    preventPageZoom()

    expect(fireGesture(inner)).toBe(false)
    expect(fireMultiTouchMove(inner, 2)).toBe(false)
  })

  it('幂等：重复调用不会叠加监听', () => {
    const teardown1 = preventPageZoom()
    const teardown2 = preventPageZoom()

    // 两者都能卸载（第二次返回的是同一个 teardown）
    teardown1()
    // 卸载后再触发不应被拦截
    expect(fireGesture(document.body)).toBe(false)
    void teardown2
  })

  it('卸载后恢复默认行为', () => {
    const teardown = preventPageZoom()
    expect(fireGesture(document.body)).toBe(true)

    teardown()
    expect(fireGesture(document.body)).toBe(false)
  })
})
