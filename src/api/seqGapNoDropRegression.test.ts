// 回归测试：seq 跳号不得丢弃事件。
//
// 真实故障（2026-11-11 用户报障）：新对话完成后标题不更新、界面一直显示
// 「进行中」，刷新才正常。
//
// 实测根因（本机 127.0.0.1:4096，opencode 2.2.0，连抓三份真实事件流）：
//   会话 seq 序列 1,2,3,4,[5 缺失],6,…,14 —— 缺 5，`session.renamed` 在 6
//   会话 seq 序列 0,…,12,[13 缺失],14     —— 缺 13，`session.renamed` 在 14
// 缺失的 seq 是「分配了序号但不向 SSE 广播」的内部事件（生成标题的用量记录）。
//
// 旧实现把跳号当丢事件：丢弃当前事件且**不推进水位**，于是该会话此后所有事件
// 全部连环被判为跳号并丢弃 → renamed / execution.succeeded 永久丢失 →
// 标题不更新 + 永远转圈，直到整页刷新（走 HTTP 快照）。
//
// 这里锁住两条契约：
//   1. 跳号后水位必须推进，否则会连环误判；
//   2. 跳号事件本身必须被应用（checkSeqGap 恒返回 false）。

import { describe, expect, it } from 'vitest'
import { SeqGapTracker } from './seqGap'

describe('seq 跳号不得导致事件被丢弃（真实故障回归）', () => {
  it('真实序列 1,2,3,4,6,7…：只有 6 报一次跳号，且水位推进到 6', () => {
    const t = new SeqGapTracker()
    const seqs = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    const verdicts = seqs.map(s => t.accept('srv', 'ses_x', s).kind)

    // 只有缺 5 的那一次报跳号，其后的 7…14 必须都是 apply
    expect(verdicts).toEqual([
      'apply',
      'apply',
      'apply',
      'apply',
      'gap',
      'apply',
      'apply',
      'apply',
      'apply',
      'apply',
      'apply',
      'apply',
      'apply',
    ])
    expect(t.getLastSeq('srv', 'ses_x')).toBe(14)
  })

  it('连续多次跳号也不会让水位卡死', () => {
    const t = new SeqGapTracker()
    t.accept('srv', 'ses_y', 1)
    expect(t.accept('srv', 'ses_y', 5).kind).toBe('gap')
    expect(t.accept('srv', 'ses_y', 9).kind).toBe('gap')
    // 关键：每次跳号都推进，不会停在旧水位反复误判
    expect(t.getLastSeq('srv', 'ses_y')).toBe(9)
    expect(t.accept('srv', 'ses_y', 10).kind).toBe('apply')
  })

  it('跳号后仍能正确处理重复与乱序', () => {
    const t = new SeqGapTracker()
    t.accept('srv', 'ses_z', 1)
    t.accept('srv', 'ses_z', 6) // gap → 水位 6
    expect(t.accept('srv', 'ses_z', 6).kind).toBe('duplicate')
    expect(t.accept('srv', 'ses_z', 3).kind).toBe('duplicate')
    expect(t.getLastSeq('srv', 'ses_z')).toBe(6)
  })

  it('跳号后不 reset 水位，否则重复旧事件会被二次应用', () => {
    /**
     * 回归：旧实现跳号时不推进水位，靠上层 ack→reset 才能解卡。现在跳号已推进
     * 水位，若上层仍 ack（reset），水位被清空，随后到达的重复/乱序旧事件会被
     * 当成「首次见到」而二次应用 —— 表现为重复消息、重复通知。
     *
     * 这条用例锁住「跳号后水位保持」这个前提，防止有人再把 ack 加回去。
     */
    const t = new SeqGapTracker()
    t.accept('srv', 'ses_w', 10)
    expect(t.accept('srv', 'ses_w', 15).kind).toBe('gap')
    // 水位已推进到 15，重复的旧事件必须仍被判 duplicate
    expect(t.accept('srv', 'ses_w', 14).kind).toBe('duplicate')
    expect(t.accept('srv', 'ses_w', 15).kind).toBe('duplicate')
  })
})
