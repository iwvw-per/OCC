// ============================================
// useMainSwipe — 移动端主界面右滑开侧栏
//
// 只处理横向手势（纵向滚动对话放行），且仅在两个抽屉都未打开时生效
// （抽屉打开后由抽屉自身负责关闭手势）。左滑不接管：移动端对话区常有
// 横向可滚动内容，左滑开右栏容易误触。
// ============================================

import { useCallback, useRef } from 'react'
import type React from 'react'
import { hapticTap } from '../utils/haptics'

const SWIPE_AXIS_PX = 12
const SWIPE_TRIGGER_PX = 60

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
