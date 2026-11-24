// ============================================
// ContextMenu — 基于坐标定位的通用右键菜单
// ============================================
//
// 与 DropdownMenu 的区别：DropdownMenu 锚定一个触发元素（按钮下方/上方），
// ContextMenu 锚定一个屏幕坐标（鼠标右键位置 / 长按位置），且需要在贴近
// 视口边缘时自动翻转，避免菜单被裁切到屏幕外。
//
// 定位在 layout effect 里直接写 DOM 样式（不经过 state），避免「effect 内
// setState 触发级联渲染」。首帧先隐藏，量出尺寸后再决定最终位置。

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LAYER_CONTEXT_MENU } from '../../constants/layers'

export interface ContextMenuPosition {
  x: number
  y: number
}

interface ContextMenuProps {
  position: ContextMenuPosition
  onClose: () => void
  /** 菜单最小宽度，默认 200px */
  minWidth?: number
  /** 菜单最大宽度，默认 min(320px, 90vw) */
  maxWidth?: number
  /** 距视口边缘的安全间距 */
  margin?: number
  zIndex?: number
  children: ReactNode
  /** 无障碍标签 */
  'aria-label'?: string
}

export function ContextMenu({
  position,
  onClose,
  minWidth = 200,
  maxWidth = 320,
  margin = 8,
  zIndex = LAYER_CONTEXT_MENU,
  children,
  'aria-label': ariaLabel,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = position.x
    let top = position.y
    if (left + rect.width > vw - margin) left = Math.max(margin, vw - margin - rect.width)
    if (top + rect.height > vh - margin) top = Math.max(margin, vh - margin - rect.height)
    left = Math.max(margin, left)

    const maxHeight = vh - margin * 2
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    // 以鼠标按下的位置为缩放原点:菜单从指针处展开,与 ZCode 的观感一致
    el.style.transformOrigin = `${Math.min(Math.max(position.x - left, 0), rect.width)}px ${Math.min(
      Math.max(position.y - top, 0),
      rect.height,
    )}px`
    if (rect.height > maxHeight) el.style.maxHeight = `${maxHeight}px`
    el.style.visibility = 'visible'
  }, [position, margin])

  useLayoutEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    const handleScroll = () => onClose()

    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('touchstart', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('touchstart', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className="fixed glass border border-border-200/60 rounded-xl shadow-lg p-1 overflow-y-auto overlay-context"
      style={{
        left: position.x,
        top: position.y,
        minWidth,
        maxWidth,
        zIndex,
        visibility: 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
