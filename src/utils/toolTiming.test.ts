import { describe, expect, it } from 'vitest'
import { MAX_TOOL_DURATION_MS, toolDurationMs, toolTimeWindow } from './toolTiming'

describe('toolDurationMs', () => {
  it('returns the elapsed time for a normal window', () => {
    expect(toolDurationMs({ start: 1000, end: 4500 })).toBe(3500)
  })

  /**
   * 回归：v2 历史消息缺时间字段时，适配层曾把 start 补成 0。
   * 落定逻辑用 `end - start` 算出 `now - 0` ≈ 当前 epoch 毫秒，
   * 累计后统计面板显示「工具调用用时 20763d 2h 53m」。
   * 0 必须视为「未知」，而不是一个可用的起点。
   */
  it('rejects a zero start (the historical bad-value shape)', () => {
    const now = 1_793_934_084_499
    expect(toolDurationMs({ start: 0, end: now })).toBeUndefined()
  })

  it('rejects negative or non-finite timestamps', () => {
    expect(toolDurationMs({ start: -1, end: 1000 })).toBeUndefined()
    expect(toolDurationMs({ start: Number.NaN, end: 1000 })).toBeUndefined()
    expect(toolDurationMs({ start: 1000, end: Number.POSITIVE_INFINITY })).toBeUndefined()
  })

  it('rejects missing or reversed windows', () => {
    expect(toolDurationMs(undefined)).toBeUndefined()
    expect(toolDurationMs({})).toBeUndefined()
    expect(toolDurationMs({ start: 1000 })).toBeUndefined()
    expect(toolDurationMs({ start: 1000, end: 1000 })).toBeUndefined()
    expect(toolDurationMs({ start: 2000, end: 1000 })).toBeUndefined()
  })

  it('rejects durations beyond the 30-day sanity ceiling', () => {
    expect(toolDurationMs({ start: 1, end: 1 + MAX_TOOL_DURATION_MS })).toBe(MAX_TOOL_DURATION_MS)
    expect(toolDurationMs({ start: 1, end: 2 + MAX_TOOL_DURATION_MS })).toBeUndefined()
  })
})

describe('toolTimeWindow', () => {
  it('returns the normalized window for later interval merging', () => {
    expect(toolTimeWindow({ start: 1000, end: 4500 })).toEqual({ start: 1000, end: 4500 })
  })

  it('returns undefined for rejected values', () => {
    expect(toolTimeWindow({ start: 0, end: 1000 })).toBeUndefined()
    expect(toolTimeWindow(undefined)).toBeUndefined()
  })
})
