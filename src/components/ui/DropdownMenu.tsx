import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDelayedRender } from '../../hooks/useDelayedRender'
import { LAYER_POPUP } from '../../constants/layers'

type DropdownPosition = 'top' | 'bottom'
type DropdownAlign = 'left' | 'right'

interface DropdownMenuProps {
  triggerRef: React.RefObject<HTMLElement | null>
  isOpen: boolean
  position?: DropdownPosition
  align?: DropdownAlign
  width?: number | string
  minWidth?: number | string
  maxWidth?: number | string
  /** 移动端（<640px）全宽展开，左右留 gap 间距 */
  mobileFullWidth?: boolean
  /** 约束菜单在此容器的边界内（宽度 ≤ 容器 65%，不溢出左右） */
  constrainToRef?: React.RefObject<HTMLElement | null>
  /** 按可用视口高度限制菜单最大高度,超出部分由内容自身滚动 */
  clampToViewport?: boolean
  /** z-index，默认 100；在 Dialog 等高 z-index 容器内使用时需要调高 */
  zIndex?: number
  className?: string
  /** 菜单容器的 ref（供调用方判断「点击是否落在菜单内」） */
  menuRef?: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
}

/**
 * Dropdown menu that renders via portal to avoid overflow clipping
 * Supports animation and auto-width
 */
/** 把 number | string 宽度归一化为 CSS 值 */
function toCssSize(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'number' ? `${value}px` : value
}

export function DropdownMenu({
  triggerRef,
  isOpen,
  position = 'bottom',
  align = 'left',
  width,
  minWidth,
  maxWidth,
  mobileFullWidth = false,
  constrainToRef,
  clampToViewport = false,
  zIndex = LAYER_POPUP,
  className = '',
  menuRef,
  children,
}: DropdownMenuProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [posStyle, setPosStyle] = useState<React.CSSProperties>({})
  const [sizeStyle, setSizeStyle] = useState<React.CSSProperties>({})
  const shouldRender = useDelayedRender(isOpen, 200)

  // 根据 trigger 位置计算 dropdown 定位
  const calcStyles = useCallback(() => {
    if (!triggerRef.current) return { pos: {}, size: {} }
    const rect = triggerRef.current.getBoundingClientRect()
    const gap = 8
    const pos: React.CSSProperties = {}
    const size: React.CSSProperties = {}

    // --- 垂直定位 ---
    if (position === 'top') {
      pos.bottom = window.innerHeight - rect.top + gap
    } else {
      pos.top = rect.bottom + gap
    }

    if (clampToViewport) {
      // 只看可用空间会让菜单在手机上几乎顶满整屏;这里再压一个舒适上限(约 60vh,240~460px)。
      const available = position === 'top' ? rect.top - gap - 8 : window.innerHeight - rect.bottom - gap - 8
      const preferred = Math.min(Math.max(window.innerHeight * 0.6, 240), 460)
      size.maxHeight = Math.max(160, Math.min(available, preferred))
    }

    // --- 水平定位 + 宽度 ---
    // constrainToRef 优先级最高
    if (constrainToRef?.current) {
      const cRect = constrainToRef.current.getBoundingClientRect()
      // 按钮中点相对容器位置，决定对齐方向
      const btnCenter = (rect.left + rect.right) / 2
      const containerCenter = (cRect.left + cRect.right) / 2
      let containerMax = 0

      if (btnCenter > containerCenter) {
        // 按钮偏右 → 右对齐，maxWidth = 按钮右边缘到容器左边缘
        pos.right = window.innerWidth - rect.right
        containerMax = rect.right - cRect.left
        size.transformOrigin = position === 'top' ? 'bottom right' : 'top right'
      } else {
        // 按钮偏左 → 左对齐，maxWidth = 容器右边缘到按钮左边缘
        pos.left = rect.left
        containerMax = cRect.right - rect.left
        size.transformOrigin = position === 'top' ? 'bottom left' : 'top left'
      }
      // 容器边界只是上限:同时尊重调用方的 width/minWidth/maxWidth,避免菜单被容器拉成满宽。
      size.maxWidth = maxWidth !== undefined ? `min(${containerMax}px, ${toCssSize(maxWidth)})` : `${containerMax}px`
      if (width !== undefined) size.width = toCssSize(width)
      if (minWidth !== undefined) size.minWidth = toCssSize(minWidth)
    } else if (mobileFullWidth && window.innerWidth < 640) {
      // 移动端全宽（无 constrainToRef 时的 fallback）
      pos.left = 12
      pos.right = 12
      size.transformOrigin = position === 'top' ? 'bottom' : 'top'
    } else {
      // 普通模式
      if (align === 'right') {
        pos.right = window.innerWidth - rect.right
      } else {
        pos.left = rect.left
      }
      size.width = width || 'auto'
      size.minWidth = minWidth ?? '200px'
      size.maxWidth = maxWidth ?? 'min(320px, 90vw)'
      size.transformOrigin = position === 'top' ? 'bottom' : 'top'
    }

    return { pos, size }
  }, [triggerRef, position, align, width, minWidth, maxWidth, mobileFullWidth, constrainToRef, clampToViewport])

  const updateStyles = useCallback(() => {
    const { pos, size } = calcStyles()
    setPosStyle(pos)
    setSizeStyle(size)
  }, [calcStyles])

  // Handle animation lifecycle
  useEffect(() => {
    let frameId: number | null = null
    let nestedFrameId: number | null = null

    if (shouldRender && isOpen) {
      frameId = requestAnimationFrame(() => {
        updateStyles()
        nestedFrameId = requestAnimationFrame(() => setIsVisible(true))
      })
    } else {
      frameId = requestAnimationFrame(() => {
        setIsVisible(false)
      })
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      if (nestedFrameId !== null) cancelAnimationFrame(nestedFrameId)
    }
  }, [isOpen, shouldRender, updateStyles])

  // 打开期间按需同步位置与宽度，避免常驻 rAF 轮询
  useEffect(() => {
    if (!shouldRender) return

    let rafId: number | null = null
    const scheduleUpdate = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        updateStyles()
      })
    }

    scheduleUpdate()
    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('scroll', scheduleUpdate, true)

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleUpdate()
      })
      if (triggerRef.current) resizeObserver.observe(triggerRef.current)
      if (constrainToRef?.current) resizeObserver.observe(constrainToRef.current)
    }

    return () => {
      window.removeEventListener('resize', scheduleUpdate)
      window.removeEventListener('scroll', scheduleUpdate, true)
      resizeObserver?.disconnect()
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
    }
  }, [shouldRender, updateStyles, triggerRef, constrainToRef])

  if (!shouldRender) return null

  return createPortal(
    <div
      ref={menuRef}
      aria-hidden={!isOpen}
      // 开合动效统一走 index.css 的 .overlay-surface（与 Popover/Select 同一套
      // 参数）。用 data-overlay-state 标记可见态：
      // - opening：已打开但定位尚未就绪（rAF 前），不播动画，避免先闪一次收起；
      // - open：定位就绪，播入场；
      // - closed：收起中，播退场（useDelayedRender 保留元素到动画结束）。
      data-overlay-state={isVisible ? 'open' : isOpen ? 'opening' : 'closed'}
      className={`
        fixed p-1 glass border border-border-200/60 rounded-xl shadow-lg overlay-surface
        ${className}
      `}
      style={{
        ...posStyle,
        ...sizeStyle,
        zIndex,
        // 用 shouldRender（延迟卸载标志）而非 isOpen 控制可见性：收起后元素会
        // 保留 200ms 播放退场动画，若按 isOpen 立刻 hidden 就看不到动画了。
        visibility: shouldRender ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
