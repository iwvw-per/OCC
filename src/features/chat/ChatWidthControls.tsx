// ============================================
// ChatWidthControls — 对话内容列宽拖拽手柄
//
// 在对话容器两侧渲染两条 col-resize 手柄，向外拖拽即可加宽内容列。宽度轴
// 收敛为一个 CSS 变量 --chat-content-width，发布在容器上，消息列、输入框与
// 对话框全部消费同一个变量，因此拖拽时无需任何 JS 同步。
//
// 交互沿用 ResizablePanel 的模型：pointer capture + rAF 节流 + 拖拽起点快照。
// 只有真实发生位移才提交存储，避免「在窗口钳制宽度上按下即松开」把已存的
// 更宽偏好覆盖掉。窗口缩小时显示值重新钳制，但存储偏好保留，窗口恢复后
// 宽度自动回来。
// ============================================

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { themeStore } from '../../store/themeStore'
import {
  CHAT_CONTENT_WIDTH_FALLBACK,
  CHAT_CONTENT_WIDTH_VAR,
  preferenceFromDrag,
  resolveChatContentWidth,
} from './contentWidth'
import { setChatWidthDragging } from './chatWidthDrag'
import { cn } from '../../utils/cn'

interface ChatWidthControlsProps {
  /** 用于测量可用列宽的容器；宽度变量也发布在该容器上 */
  container: HTMLElement | null
  /** 是否启用（分屏/紧凑视图下可关闭） */
  enabled?: boolean
}

interface WidthHandleProps {
  side: 'left' | 'right'
  onStart: () => number
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  onEnd: () => void
}

function WidthHandle({ side, onStart, onDrag, onCommit, onEnd }: WidthHandleProps) {
  const [dragging, setDragging] = useState(false)
  const base = useRef(0)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const callbacks = useRef({ onStart, onDrag, onCommit, onEnd })
  callbacks.current = { onStart, onDrag, onCommit, onEnd }

  const outwardWidth = useCallback(() => {
    const dx = latest.current - origin.current
    const outward = side === 'right' ? dx : -dx
    return base.current + outward * 2
  }, [side])

  const cancelFrame = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    origin.current = event.clientX
    latest.current = event.clientX
    base.current = callbacks.current.onStart()
    setDragging(true)
    // 关闭内容列的 max-width 过渡，让宽度实时跟手（见 index.css）
    document.documentElement.setAttribute('data-chat-width-dragging', '')
    // 通知虚拟列表降低 overscan，减少拖拽时每帧重排的行数
    setChatWidthDragging(true)
  }, [])

  // 光带跟随指针纵向位置：无论是否按下都更新，hover 时就能看到「拖动位置」。
  // 用 offsetY（相对命中条带自身，无布局读取）而非 getBoundingClientRect，
  // 避免 pointermove 每帧强制同步布局，拖拽时造成卡顿。
  const updatePointerY = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const strip = stripRef.current
    if (!strip) return
    strip.style.setProperty('--chat-width-handle-pointer-y', `${event.nativeEvent.offsetY}px`)
  }, [])

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      updatePointerY(event)
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      latest.current = event.clientX
      frame.current ??= requestAnimationFrame(() => {
        frame.current = null
        callbacks.current.onDrag(outwardWidth())
      })
    },
    [outwardWidth, updatePointerY],
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      event.currentTarget.releasePointerCapture(event.pointerId)
      cancelFrame()
      latest.current = event.clientX
      if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth())
      setDragging(false)
      document.documentElement.removeAttribute('data-chat-width-dragging')
      setChatWidthDragging(false)
      callbacks.current.onEnd()
    },
    [outwardWidth],
  )

  const handlePointerCancel = useCallback(() => {
    cancelFrame()
    setDragging(false)
    document.documentElement.removeAttribute('data-chat-width-dragging')
    setChatWidthDragging(false)
    callbacks.current.onEnd()
  }, [])

  // 命中条带：位于内容列外侧 24px 处，向外最多 24px；margin 不足时宽度收敛为 0。
  const widthExpr = `min(24px, calc((100% - var(${CHAT_CONTENT_WIDTH_VAR}, ${CHAT_CONTENT_WIDTH_FALLBACK})) / 2 - 8px))`
  const offsetExpr = `calc(50% + var(${CHAT_CONTENT_WIDTH_VAR}, ${CHAT_CONTENT_WIDTH_FALLBACK}) / 2 + 8px)`

  return (
    <div
      ref={stripRef}
      data-chat-width-handle={side}
      data-dragging={dragging || undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      className={cn('group/handle absolute top-0 bottom-0 cursor-col-resize', dragging ? 'z-[8]' : 'z-0')}
      style={side === 'left' ? { right: offsetExpr, width: widthExpr } : { left: offsetExpr, width: widthExpr }}
    >
      {/* 光带：一条短竖条跟随指针 Y（--chat-width-handle-pointer-y，默认居中），
          两端渐隐，hover 或拖拽时淡入。 */}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-0 bottom-0 w-0.5 rounded-full bg-accent-main-100',
          'transition-opacity duration-150',
          side === 'left' ? 'right-1' : 'left-1',
          dragging ? 'opacity-100' : 'opacity-0 group-hover/handle:opacity-100',
        )}
        style={{
          maskImage:
            'linear-gradient(to bottom, transparent calc(var(--chat-width-handle-pointer-y, 50%) - 36px), #000 calc(var(--chat-width-handle-pointer-y, 50%) - 8px), #000 calc(var(--chat-width-handle-pointer-y, 50%) + 8px), transparent calc(var(--chat-width-handle-pointer-y, 50%) + 36px))',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent calc(var(--chat-width-handle-pointer-y, 50%) - 36px), #000 calc(var(--chat-width-handle-pointer-y, 50%) - 8px), #000 calc(var(--chat-width-handle-pointer-y, 50%) + 8px), transparent calc(var(--chat-width-handle-pointer-y, 50%) + 36px))',
        }}
      />
    </div>
  )
}

export function ChatWidthControls({ container, enabled = true }: ChatWidthControlsProps) {
  // 容器自身宽度在整个拖拽过程中不变（宽度轴只影响其内部内容）。缓存列宽，
  // 避免拖拽每帧读 offsetWidth —— 写 CSS 变量后再读会强制同步布局，逐帧卡顿。
  const columnRef = useRef(0)
  // 拖拽起点：偏好（用于换算持久化宽度）与当时的显示宽度（用于计算位移）。
  const dragStartRef = useRef({ preference: 0, display: 0 })

  const publishWidths = useCallback((element: HTMLElement) => {
    columnRef.current = element.offsetWidth
    element.style.setProperty(
      CHAT_CONTENT_WIDTH_VAR,
      `${resolveChatContentWidth(columnRef.current, themeStore.chatContentWidth)}px`,
    )
  }, [])

  useLayoutEffect(() => {
    if (!container || !enabled) return
    const observer = new ResizeObserver(() => publishWidths(container))
    observer.observe(container)
    publishWidths(container)
    return () => observer.disconnect()
  }, [container, enabled, publishWidths])

  const handleStart = useCallback((): number => {
    if (!container) return 0
    columnRef.current = container.offsetWidth
    const preference = themeStore.chatContentWidth
    const display = resolveChatContentWidth(columnRef.current, preference)
    // 起点偏好：没有偏好时用当前自适应显示值作为基准，拖拽从眼前宽度接着走。
    dragStartRef.current = { preference: preference ?? display, display }
    return display
  }, [container])

  const handleDrag = useCallback(
    (width: number) => {
      if (!container) return
      container.style.setProperty(CHAT_CONTENT_WIDTH_VAR, `${resolveChatContentWidth(columnRef.current, width)}px`)
    },
    [container],
  )

  const handleCommit = useCallback(
    (width: number) => {
      if (!container) return
      const { preference, display } = dragStartRef.current
      themeStore.setChatContentWidth(preferenceFromDrag(columnRef.current, preference, display, width))
    },
    [container],
  )

  const handleEnd = useCallback(() => {
    if (container) publishWidths(container)
  }, [container, publishWidths])

  if (!container || !enabled) return null

  return (
    <>
      {(['left', 'right'] as const).map(side => (
        <WidthHandle
          key={side}
          side={side}
          onStart={handleStart}
          onDrag={handleDrag}
          onCommit={handleCommit}
          onEnd={handleEnd}
        />
      ))}
    </>
  )
}
