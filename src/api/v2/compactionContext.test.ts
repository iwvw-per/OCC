import { describe, expect, it } from 'vitest'
import { adaptMessagePage } from './message'
import { computeSessionStats } from '../../hooks/sessionStatsCompute'

/**
 * 压缩标记的端到端形状：message.list → marker → 上下文用量。
 *
 * 用本机实测的真实数据形状（v2 压缩条目）：
 *   - 该条目 tokens 是**压缩前**用量：input 342383 / cache.read 577024
 *   - summary 5442 字符、recent 92322 字符 → 压缩后约 24.4k tokens
 *
 * 旧实现只认 `session.compaction.ended` 事件（实测这次压缩根本没发），且把它的
 * tokens（压缩前用量）当成压缩后占用，于是圆环在压缩后反而显得更满。
 */

const COMPACTION_AT = 1_792_435_995_434

function v2Page() {
  return {
    data: [
      // desc（最新在前），与 v2 message.list 一致
      {
        id: 'msg_after',
        type: 'assistant',
        time: { created: COMPACTION_AT + 60_000 },
        agent: 'build',
        model: { id: 'm', providerID: 'p' },
        content: [{ type: 'text', text: 'after compaction' }],
      },
      {
        id: 'msg_compaction',
        type: 'compaction',
        status: 'completed',
        reason: 'manual',
        time: { created: COMPACTION_AT },
        model: { id: 'm', providerID: 'p', variant: 'default' },
        summary: 's'.repeat(5442),
        recent: 'r'.repeat(92_322),
        cost: 0,
        // 压缩前用量，不能当作压缩后的占用
        tokens: { input: 342_383, output: 2443, reasoning: 0, cache: { read: 577_024, write: 0 } },
      },
      {
        id: 'msg_before',
        type: 'assistant',
        time: { created: COMPACTION_AT - 60_000 },
        agent: 'build',
        model: { id: 'm', providerID: 'p' },
        content: [{ type: 'text', text: 'before compaction '.repeat(20_000) }],
      },
    ],
  }
}

describe('compaction marker end-to-end', () => {
  it('extracts the marker from a v2 message page', () => {
    const page = adaptMessagePage(v2Page())

    expect(page.compactedAt).toBe(COMPACTION_AT)
    expect(page.compaction).toEqual({
      at: COMPACTION_AT,
      summaryChars: 5442,
      recentChars: 92_322,
    })
  })

  it('does not treat the pre-compaction tokens as the post-compaction context', () => {
    const page = adaptMessagePage(v2Page())
    const marker = page.compaction!

    // 统计层吃的是 UI 形状（content 而非 parts）；这里只验证「压缩后不再把旧轮次
    // 算进上下文」这一条，因此直接构造压缩后的最小消息集。
    const afterMessages = [
      {
        info: {
          id: 'msg_after',
          role: 'assistant',
          sessionID: 's',
          time: { created: COMPACTION_AT + 60_000 },
          tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        content: [{ type: 'text', text: 'after compaction' }],
      },
    ]

    const stats = computeSessionStats(afterMessages as never, 200_000, undefined, undefined, marker)

    // 压缩之后又跑了新一轮 → 真实用量优先，marker 让位
    expect(stats.contextUsed).toBe(1100)
  })

  it('uses the marker when no newer turn has run yet', () => {
    const page = adaptMessagePage(v2Page())
    const marker = page.compaction!

    // 压缩后还没有新消息（消息尚未重拉）：必须按 marker 显示，
    // 否则圆环会回落到 0 或停留在压缩前的高水位。
    const stats = computeSessionStats([], 200_000, undefined, undefined, marker)

    expect(stats.contextUsed).toBe(Math.ceil((5442 + 92_322) / 4))
    expect(stats.contextUsed).toBeLessThan(30_000)
    // 字符数换算而来，如实标注为估算
    expect(stats.contextEstimated).toBe(true)
  })
})
