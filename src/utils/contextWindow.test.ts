import { describe, expect, it } from 'vitest'
import { autoCompactCeiling, compactRatio, COMPACTION_RESERVE_MIN, effectiveContextWindow } from './contextWindow'

/**
 * 这几条契约对齐服务端 `SessionCompaction.calculateCeiling`：
 *
 *   const window = limit.input || limit.context
 *   window - max(floor(window * 0.1), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
 *
 * 圆环的分母与上色都必须用同一口径，否则会出现「格式上没满但服务端已压缩」，
 * 或者「圆环停在很小的百分比、看起来不涨」——后者正是用户报的现象。
 */

describe('effectiveContextWindow', () => {
  it('优先用 limit.input（与服务端 window 取值一致）', () => {
    // 实测站点：vercel/openai/gpt-5-pro 是 context=400000 / input=128000
    expect(effectiveContextWindow({ contextLimit: 400_000, inputLimit: 128_000 })).toBe(128_000)
  })

  it('input 缺失时退回 context', () => {
    expect(effectiveContextWindow({ contextLimit: 200_000, inputLimit: 0 })).toBe(200_000)
    expect(effectiveContextWindow({ contextLimit: 200_000 })).toBe(200_000)
  })

  it('两者都未知时返回 0（未知，不是猜一个默认值）', () => {
    expect(effectiveContextWindow(null)).toBe(0)
    expect(effectiveContextWindow(undefined)).toBe(0)
    expect(effectiveContextWindow({})).toBe(0)
    expect(effectiveContextWindow({ contextLimit: 0, inputLimit: 0 })).toBe(0)
    // 负数/NaN 也按未知处理，避免把分母变成负值
    expect(effectiveContextWindow({ contextLimit: -1 })).toBe(0)
    expect(effectiveContextWindow({ contextLimit: Number.NaN })).toBe(0)
  })

  it('input 比 context 大时仍取 input（服务端就是这个优先级）', () => {
    expect(effectiveContextWindow({ contextLimit: 100_000, inputLimit: 200_000 })).toBe(200_000)
  })
})

describe('autoCompactCeiling', () => {
  it('大窗口：保留 max(10%, 16000) 的空闲', () => {
    // 1,000,000 的 10% = 100,000，大于 RESERVE_MIN
    expect(autoCompactCeiling(1_000_000)).toBe(900_000)
    // 200,000 的 10% = 20,000
    expect(autoCompactCeiling(200_000)).toBe(180_000)
  })

  it('恰好 32000 时按 16000 预留（>= 2 * RESERVE_MIN）', () => {
    expect(autoCompactCeiling(2 * COMPACTION_RESERVE_MIN)).toBe(16_000)
    // 10% 是 3200，取较大的 16000
    expect(autoCompactCeiling(32_000)).toBe(32_000 - COMPACTION_RESERVE_MIN)
  })

  it('小窗口：只留 10%，不套用 16000 下限', () => {
    // 20,000 < 32,000 → 预留 2,000，而不是 16,000（否则会把窗口吃成负数）
    expect(autoCompactCeiling(20_000)).toBe(18_000)
    expect(autoCompactCeiling(10_000)).toBe(9_000)
  })

  it('窗口未知返回 0（服务端此时永不自动压缩）', () => {
    expect(autoCompactCeiling(0)).toBe(0)
    expect(autoCompactCeiling(-1)).toBe(0)
    expect(autoCompactCeiling(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('compactRatio', () => {
  it('给出相对触发线的比例', () => {
    expect(compactRatio(450_000, 1_000_000)).toBeCloseTo(0.5, 5)
    expect(compactRatio(900_000, 1_000_000)).toBeCloseTo(1, 5)
    expect(compactRatio(990_000, 1_000_000)).toBeCloseTo(1.1, 5)
  })

  it('窗口未知时返回 null（不能当成 0 上色）', () => {
    expect(compactRatio(1000, 0)).toBeNull()
    expect(compactRatio(1000, -1)).toBeNull()
    expect(compactRatio(Number.NaN, 1_000_000)).toBeNull()
  })

  it('复现「显示 60% 其实已到触发线」的口径错位场景', () => {
    // 站点真实情形：context=1,000,000 但 input=262,144。
    // 旧口径（只用 context）下 262,144 只显示 26%，看起来「完全不涨」；
    // 新口径下窗口就是 262,144，占用 262,144 已经是 100%。
    const wrongWindow = 1_000_000
    const realWindow = effectiveContextWindow({ contextLimit: 1_000_000, inputLimit: 262_144 })
    expect(realWindow).toBe(262_144)
    expect((262_144 / wrongWindow) * 100).toBeLessThan(30)
    expect(compactRatio(262_144, realWindow)).toBeGreaterThan(1)
  })
})
