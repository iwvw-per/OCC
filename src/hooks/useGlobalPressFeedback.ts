// ============================================
// useGlobalPressFeedback — 移动端全局「按下」反馈
// ============================================
//
// 触摸没有 hover,`:active` 在不同浏览器/手势下又常常一闪而过甚至不触发,
// 于是「点一行没有任何反应」。这里用一处 document 级监听统一补上按下高亮:
//
//   pointerdown(touch) → 给最近的「可点祖先」打 data-pressed
//   pointerup / pointercancel / 移动超过阈值 / 滚动 → 移除
//
// 高亮样式在 index.css 的 `[data-pressed='true']`(inset box-shadow 叠底色,
// 不改布局、不与 Tailwind 的 bg-* 抢优先级)。与 useGlobalHaptics 同一套
// PRESSABLE_SELECTOR,保证「震动的范围」与「高亮的范围」一致。
//
// 仅在触摸优先设备挂载;鼠标 / 触控笔沿用各自原有的 hover + `:active`。

import { useEffect } from 'react'
import { resolvePressTarget } from '../utils/interaction'

const PRESSED_ATTR = 'data-pressed'

/** 手指移动超过这个距离视为「想滚动」,立即撤掉按下高亮 */
const MOVE_CANCEL_PX = 8

export function useGlobalPressFeedback(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return

    let pressed: HTMLElement | null = null
    let startX = 0
    let startY = 0

    const clear = () => {
      if (!pressed) return
      pressed.removeAttribute(PRESSED_ATTR)
      pressed = null
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = resolvePressTarget(event.target, event.pointerType)
      if (!target) return
      // 前一次未清干净(极端情况下 pointerup 丢失)时先撤掉,避免残留高亮。
      clear()
      startX = event.clientX
      startY = event.clientY
      pressed = target.element
      target.element.setAttribute(PRESSED_ATTR, 'true')
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!pressed) return
      if (Math.abs(event.clientX - startX) > MOVE_CANCEL_PX || Math.abs(event.clientY - startY) > MOVE_CANCEL_PX) {
        clear()
      }
    }

    const onPointerEnd = () => clear()

    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
    document.addEventListener('pointerup', onPointerEnd, true)
    document.addEventListener('pointercancel', onPointerEnd, true)
    // 触摸滚动不一定派发 pointercancel(也可能没经过 pointermove 阈值),
    // 滚动本身作为兜底信号,避免高亮粘在行上。
    window.addEventListener('scroll', onPointerEnd, true)

    return () => {
      clear()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerup', onPointerEnd, true)
      document.removeEventListener('pointercancel', onPointerEnd, true)
      window.removeEventListener('scroll', onPointerEnd, true)
    }
  }, [enabled])
}
