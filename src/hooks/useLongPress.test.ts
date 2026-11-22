import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLongPress } from './useLongPress'

function touch(x: number, y = 0) {
  return { touches: [{ clientX: x, clientY: y }] } as never
}

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires onLongPress with the touch point after the delay', () => {
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress({ enabled: true, onLongPress }))

    act(() => result.current.onTouchStart(touch(10, 20)))
    act(() => vi.advanceTimersByTime(500))

    expect(onLongPress).toHaveBeenCalledWith({ x: 10, y: 20 })
    expect(result.current.suppressClickRef.current).toBe(true)
  })

  it('cancels when the finger moves past the tolerance', () => {
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress({ enabled: true, onLongPress }))

    act(() => result.current.onTouchStart(touch(10, 10)))
    act(() => result.current.onTouchMove(touch(10, 40)))
    act(() => vi.advanceTimersByTime(500))

    expect(onLongPress).not.toHaveBeenCalled()
    expect(result.current.suppressClickRef.current).toBe(false)
  })

  it('does not fire when disabled', () => {
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress({ enabled: false, onLongPress }))

    act(() => result.current.onTouchStart(touch(10)))
    act(() => vi.advanceTimersByTime(500))

    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('runs onStart on touch start', () => {
    const onStart = vi.fn()
    const { result } = renderHook(() => useLongPress({ enabled: true, onLongPress: () => {}, onStart }))

    act(() => result.current.onTouchStart(touch(10)))

    expect(onStart).toHaveBeenCalledTimes(1)
  })
})
