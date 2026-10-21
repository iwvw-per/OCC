// ============================================
// 使用统计适配（v2 session.stats）
// ============================================
//
// 服务端返回的聚合数据覆盖整台服务器的所有会话，前端算不出来。
// 这里锁住适配逻辑：字段缺失补 0、mode 归一、P50 可选。

import { describe, expect, it } from 'vitest'
import { adaptSessionStats } from './stats'

const RAW = {
  range: { from: 100, to: 200 },
  sessions: 65,
  subagents: 7,
  prompts: 510,
  steps: 14439,
  tokens: { input: 120, output: 3, reasoning: 3, cache: { read: 3814, write: 0 } },
  cost: 1.25,
  activeDays: 8,
  streak: 6,
  activity: [
    { date: '2026-10-13', steps: 180 },
    { date: '2026-10-14', steps: 839 },
  ],
  models: [
    {
      model: { id: 'm1', providerID: 'p1', variant: 'default' },
      steps: 100,
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } },
      cost: 0.5,
    },
  ],
  tools: {
    mode: 'detail',
    totals: { calls: 100, succeeded: 95, failed: 4, unfinished: 1 },
    usage: [{ name: 'shell', calls: 50, succeeded: 48, failed: 2, unfinished: 0, durationP50: 52 }],
  },
}

describe('adaptSessionStats', () => {
  it('映射顶层汇总字段', () => {
    const s = adaptSessionStats(RAW)
    expect(s.sessions).toBe(65)
    expect(s.prompts).toBe(510)
    expect(s.steps).toBe(14439)
    expect(s.activeDays).toBe(8)
    expect(s.streak).toBe(6)
    expect(s.cost).toBe(1.25)
  })

  it('映射 tokens 四组（含 cache）', () => {
    const s = adaptSessionStats(RAW)
    expect(s.tokens).toEqual({ input: 120, output: 3, reasoning: 3, cache: { read: 3814, write: 0 } })
  })

  it('映射活动日历与模型分布', () => {
    const s = adaptSessionStats(RAW)
    expect(s.activity).toEqual([
      { date: '2026-10-13', steps: 180 },
      { date: '2026-10-14', steps: 839 },
    ])
    expect(s.models[0].model.id).toBe('m1')
    expect(s.models[0].cost).toBe(0.5)
  })

  it('映射工具明细，保留 P50', () => {
    const s = adaptSessionStats(RAW)
    expect(s.tools.mode).toBe('detail')
    expect(s.tools.totals).toEqual({ calls: 100, succeeded: 95, failed: 4, unfinished: 1 })
    expect(s.tools.usage?.[0]).toEqual({
      name: 'shell',
      calls: 50,
      succeeded: 48,
      failed: 2,
      unfinished: 0,
      durationP50: 52,
    })
  })

  it('缺少 P50 时不产出该字段（而不是 0）', () => {
    const s = adaptSessionStats({
      tools: { mode: 'summary', usage: [{ name: 'x', calls: 1 }] },
    })
    expect(s.tools.usage?.[0]).not.toHaveProperty('durationP50')
  })

  it('未知 mode 归一为 none', () => {
    expect(adaptSessionStats({ tools: { mode: 'weird' } }).tools.mode).toBe('none')
    expect(adaptSessionStats({}).tools.mode).toBe('none')
  })

  it('空响应不抛错，全部补 0', () => {
    const s = adaptSessionStats({})
    expect(s.sessions).toBe(0)
    expect(s.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(s.activity).toEqual([])
    expect(s.models).toEqual([])
  })

  it('非数组字段按空数组处理', () => {
    const s = adaptSessionStats({ activity: null, models: 'bad', tools: { usage: 42 } })
    expect(s.activity).toEqual([])
    expect(s.models).toEqual([])
    expect(s.tools.usage).toBeUndefined()
  })
})
