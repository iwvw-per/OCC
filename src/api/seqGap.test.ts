import { describe, expect, it } from 'vitest'
import { SeqGapTracker, durableOf } from './seqGap'

describe('durableOf', () => {
  it('取出 durable 信封', () => {
    expect(durableOf({ type: 'x', durable: { aggregateID: 'ses_1', seq: 42, version: 1 } })).toEqual({
      aggregateID: 'ses_1',
      seq: 42,
    })
  })

  it('ephemeral 事件（无 durable）返回 null', () => {
    // delta / status / usage.updated 都不带 seq，不参与缺口检测
    expect(durableOf({ type: 'session.text.delta', data: {} })).toBeNull()
    expect(durableOf({ type: 'server.connected', data: {} })).toBeNull()
  })

  it('字段缺失或类型不对时返回 null', () => {
    expect(durableOf(null)).toBeNull()
    expect(durableOf({ durable: {} })).toBeNull()
    expect(durableOf({ durable: { aggregateID: 'ses_1' } })).toBeNull()
    expect(durableOf({ durable: { seq: 1 } })).toBeNull()
    expect(durableOf({ durable: { aggregateID: '', seq: 1 } })).toBeNull()
    expect(durableOf({ durable: { aggregateID: 'ses_1', seq: Number.NaN } })).toBeNull()
  })
})

describe('SeqGapTracker', () => {
  it('首次见到的 aggregate 直接应用', () => {
    const t = new SeqGapTracker()
    // 老会话的 seq 可能从任意值开始（实测 29364），首次必须放行
    expect(t.accept('local', 'ses_old', 29364)).toEqual({ kind: 'apply' })
  })

  it('连续序号正常应用并推进水位', () => {
    const t = new SeqGapTracker()
    t.accept('local', 'ses_1', 10)
    expect(t.accept('local', 'ses_1', 11)).toEqual({ kind: 'apply' })
    expect(t.accept('local', 'ses_1', 12)).toEqual({ kind: 'apply' })
    expect(t.getLastSeq('local', 'ses_1')).toBe(12)
  })

  it('重复序号判为 duplicate 且不推进水位', () => {
    const t = new SeqGapTracker()
    t.accept('local', 'ses_1', 10)
    t.accept('local', 'ses_1', 11)
    expect(t.accept('local', 'ses_1', 11)).toEqual({ kind: 'duplicate' })
    // 乱序旧事件不能把水位拉回去
    expect(t.accept('local', 'ses_1', 5)).toEqual({ kind: 'duplicate' })
    expect(t.getLastSeq('local', 'ses_1')).toBe(11)
  })

  it('跳号判为 gap，并报告期望值与实际值，但水位仍然推进', () => {
    const t = new SeqGapTracker()
    t.accept('local', 'ses_1', 10)
    expect(t.accept('local', 'ses_1', 15)).toEqual({ kind: 'gap', expected: 11, received: 15 })
    /**
     * 关键：跳号必须推进水位。
     *
     * 实测服务端会给内部不广播的事件分配 seq（生成标题的 usage.recorded），
     * 若跳号不推进，之后每一条事件都会被连环判为跳号并丢弃 —— 表现为标题不
     * 更新、完成后仍显示进行中，只有刷新才好。见 seqGap.ts 文件头实测记录。
     */
    expect(t.getLastSeq('local', 'ses_1')).toBe(15)
    // 紧接着的连续事件应正常应用，而不是继续判 gap
    expect(t.accept('local', 'ses_1', 16)).toEqual({ kind: 'apply' })
  })

  it('seq 是 per-aggregate 的：不同会话互不干扰', () => {
    /**
     * 实测证据：新会话 seq 8–15，老会话 seq 29364–29365 同时出现在同一条流里。
     * 若用全局单值，每个事件都会被误判成 gap。
     */
    const t = new SeqGapTracker()
    t.accept('local', 'ses_new', 8)
    t.accept('local', 'ses_old', 29364)
    expect(t.accept('local', 'ses_new', 9)).toEqual({ kind: 'apply' })
    expect(t.accept('local', 'ses_old', 29365)).toEqual({ kind: 'apply' })
  })

  it('不同服务器的同名 aggregate 互不干扰', () => {
    const t = new SeqGapTracker()
    t.accept('local', 'ses_1', 10)
    // 另一台服务器的同名会话 seq 从头开始，不应被判成 duplicate/gap
    expect(t.accept('aiagent:inst_1', 'ses_1', 1)).toEqual({ kind: 'apply' })
    expect(t.getLastSeq('local', 'ses_1')).toBe(10)
    expect(t.getLastSeq('aiagent:inst_1', 'ses_1')).toBe(1)
  })

  it('seed 可以预设基线水位，防止后续跳号事件逃逸', () => {
    const t = new SeqGapTracker()
    // 从快照获知该会话目前在 100
    t.seed('local', 'ses_seeded', 100)
    expect(t.getLastSeq('local', 'ses_seeded')).toBe(100)

    // 连续序号 101：正常 apply
    expect(t.accept('local', 'ses_seeded', 101)).toEqual({ kind: 'apply' })
    // 跳号 105：正确识别出 gap
    expect(t.accept('local', 'ses_seeded', 105)).toEqual({ kind: 'gap', expected: 102, received: 105 })

    // seed 更小的值不会把水位拉低
    t.seed('local', 'ses_seeded', 50)
    expect(t.getLastSeq('local', 'ses_seeded')).toBe(105)
  })

  it('reset 之后重新从「首次见到」开始', () => {
    // 缺口修复（快照重拉）完成后必须 reset，否则会一直卡在 gap 上反复重拉
    const t = new SeqGapTracker()
    t.accept('local', 'ses_1', 10)
    t.accept('local', 'ses_1', 20) // gap
    t.reset('local', 'ses_1')
    expect(t.accept('local', 'ses_1', 25)).toEqual({ kind: 'apply' })
  })

  it('aggregate 数量有上限，超出时淘汰最久未用的', () => {
    const t = new SeqGapTracker({ maxAggregates: 2 })
    t.accept('local', 'ses_a', 1)
    t.accept('local', 'ses_b', 1)
    expect(t.size()).toBe(2)
    t.accept('local', 'ses_c', 1)
    expect(t.size()).toBe(2)
    // ses_a 被淘汰：再次见到它时按「首次」处理
    expect(t.getLastSeq('local', 'ses_a')).toBeUndefined()
    expect(t.accept('local', 'ses_a', 99)).toEqual({ kind: 'apply' })
  })

  it('非法的 aggregateID / seq 直接放行，不污染水位', () => {
    const t = new SeqGapTracker()
    expect(t.accept('local', '', 1)).toEqual({ kind: 'apply' })
    expect(t.accept('local', 'ses_1', Number.NaN)).toEqual({ kind: 'apply' })
    expect(t.size()).toBe(0)
  })

  it('clear 清空所有跟踪', () => {
    const t = new SeqGapTracker()
    t.accept('local', 'ses_1', 1)
    t.clear()
    expect(t.size()).toBe(0)
  })
})
