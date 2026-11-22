import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type React from 'react'

export interface LongPressPoint {
  x: number
  y: number
}

interface UseLongPressOptions {
  enabled: boolean
  onLongPress: (point: LongPressPoint) => void
  onStart?: () => void
  delay?: number
  moveTolerance?: number
}

export interface LongPressHandlers {
  onTouchStart: (event: React.TouchEvent) => void
  onTouchMove: (event: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchCancel: () => void
  suppressClickRef: RefObject<boolean>
}

export function useLongPress({
  enabled,
  onLongPress,
  onStart,
  delay = 500,
  moveTolerance = 10,
}: UseLongPressOptions): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRef = useRef<LongPressPoint>({ x: 0, y: 0 })
  const suppressClickRef = useRef(false)
  const onLongPressRef = useRef(onLongPress)
  const onStartRef = useRef(onStart)

  useEffect(() => {
    onLongPressRef.current = onLongPress
  }, [onLongPress])

  useEffect(() => {
    onStartRef.current = onStart
  }, [onStart])

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => clear, [clear])

  const onTouchStart = useCallback(
    (event: React.TouchEvent) => {
      if (!enabled) return
      const touch = event.touches[0]
      if (!touch) return
      startRef.current = { x: touch.clientX, y: touch.clientY }
      suppressClickRef.current = false
      clear()
      onStartRef.current?.()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        suppressClickRef.current = true
        onLongPressRef.current(startRef.current)
      }, delay)
    },
    [enabled, delay, clear],
  )

  const onTouchMove = useCallback(
    (event: React.TouchEvent) => {
      if (!enabled || timerRef.current === null) return
      const touch = event.touches[0]
      if (!touch) return
      const dx = touch.clientX - startRef.current.x
      const dy = touch.clientY - startRef.current.y
      if (Math.hypot(dx, dy) > moveTolerance) clear()
    },
    [enabled, moveTolerance, clear],
  )

  const onTouchEnd = useCallback(() => {
    clear()
  }, [clear])

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd, suppressClickRef }
}
