// ============================================
// useMainSwipe — 移动端主界面右滑开侧栏
//
// 只处理横向手势（纵向滚动对话放行），且仅在两个抽屉都未打开时生效
// （抽屉打开后由抽屉自身负责关闭手势）。左滑不接管：移动端对话区常有
// 横向可滚动内容，左滑开右栏容易误触。
//
// ⚠️ 起点落在**可横向滚动的元素**内时必须放弃接管。
//
// 实测问题：手指在展开的命令执行框 / shell 输出框里向右滑，整页被当成「右滑打开
// 侧栏」而弹出左侧边栏。那些框（尤其全屏态）自己就有横向滚动，用户的意图是翻看
// 长命令，不是打开导航。所以 touchstart 就要判断起点祖先里有没有横向可滚容器。
// ============================================

import { useCallback, useRef } from 'react'
import type React from 'react'
import { hapticTap } from '../utils/haptics'

const SWIPE_AXIS_PX = 12
const SWIPE_TRIGGER_PX = 60

/**
 * 从手势起点向上找，是否落在「可横向滚动」的容器里。
 *
 * 判定为可横向滚动需同时满足：
 *   - 计算样式 overflow-x 为 auto / scroll / overlay；
 *   - 内容实际宽度大于可视宽度（`scrollWidth > clientWidth`）。
 *
 * 只看 overflow 不够：很多容器写了 `overflow-x-auto` 但内容没溢出，
 * 那种情况下横向滑动不会滚动任何东西，应当仍然允许开侧栏。
 */
function isInsideHorizontalScroller(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  let node: Element | null = target
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node)
    const overflowX = style.overflowX
    const scrollableX = overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay'
    if (scrollableX && node.scrollWidth > node.clientWidth) return true
    node = node.parentElement
  }
  return false
}

export interface UseMainSwipeOptions {
  enabled: boolean
  sidebarExpanded: boolean
  rightPanelOpen: boolean
  onOpenSidebar: () => void
}

export interface MainSwipeHandlers {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchEnd: (e: React.TouchEvent) => void
  onTouchCancel: (e: React.TouchEvent) => void
}

export function useMainSwipe({
  enabled,
  sidebarExpanded,
  rightPanelOpen,
  onOpenSidebar,
}: UseMainSwipeOptions): MainSwipeHandlers {
  const gesture = useRef<{ startX: number; startY: number; axis: 'x' | 'y' | null } | null>(null)

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || sidebarExpanded || rightPanelOpen) {
        gesture.current = null
        return
      }
      const touch = e.touches[0]
      if (!touch) return
      // 起点在横向可滚动容器内 → 不接管，把手势让给容器自己
      if (isInsideHorizontalScroller(e.target)) {
        gesture.current = null
        return
      }
      gesture.current = { startX: touch.clientX, startY: touch.clientY, axis: null }
    },
    [enabled, rightPanelOpen, sidebarExpanded],
  )

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const swipe = gesture.current
    const touch = e.touches[0]
    if (!swipe || !touch) return
    if (swipe.axis === null) {
      const dx = touch.clientX - swipe.startX
      const dy = touch.clientY - swipe.startY
      if (Math.abs(dx) < SWIPE_AXIS_PX && Math.abs(dy) < SWIPE_AXIS_PX) return
      // 横向意图明显强于纵向才接管，避免与对话滚动打架
      swipe.axis = Math.abs(dx) > Math.abs(dy) * 1.25 ? 'x' : 'y'
    }
  }, [])

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const swipe = gesture.current
      gesture.current = null
      if (!swipe || swipe.axis !== 'x') return
      const touch = e.changedTouches[0]
      if (!touch) return
      if (touch.clientX - swipe.startX >= SWIPE_TRIGGER_PX) {
        hapticTap('medium')
        onOpenSidebar()
      }
    },
    [onOpenSidebar],
  )

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd }
}
