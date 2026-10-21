import { describe, expect, it } from 'vitest'
import { findCompactionMarker } from './message'

/**
 * v2 压缩记录的解析。
 *
 * 用户报的是：压缩完成后上下文占用不更新，圆环停在压缩前的高水位。V1 正常。
 *
 * 根因有两条：
 *   1. 压缩事件不一定发 —— 本机 39,446 条事件里没有任何 `session.compaction.*`，
 *      同一次压缩在消息列表里却有完整的 `type: "compaction"` 记录。所以消息列表
 *      才是权威来源。
 *   2. 该条目的 `tokens` 是**压缩前**用量（实测 input 342383 / cache.read 577024），
 *      不能拿来显示压缩后的占用；压缩后上下文 ≈ 摘要 + 保留的近期消息。
 */

function compactionEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_compaction',
    type: 'compaction',
    status: 'completed',
    reason: 'manual',
    time: { created: 1_700_000_000_000 },
    summary: '## Objective\n- 重构前端',
    recent: 'x'.repeat(4000),
    tokens: { input: 342383, output: 2443, reasoning: 0, cache: { read: 577024, write: 0 } },
    ...overrides,
  }
}

describe('findCompactionMarker', () => {
  it('extracts the compaction boundary and summary sizes', () => {
    const marker = findCompactionMarker([compactionEntry()])

    expect(marker?.at).toBe(1_700_000_000_000)
    expect(marker?.summaryChars).toBeGreaterThan(0)
    expect(marker?.recentChars).toBe(4000)
  })

  it('uses the newest completed compaction', () => {
    const marker = findCompactionMarker([
      compactionEntry({ time: { created: 1_700_000_000_000 } }),
      compactionEntry({ time: { created: 1_700_000_500_000 }, recent: 'y'.repeat(100) }),
    ])

    expect(marker?.at).toBe(1_700_000_500_000)
    expect(marker?.recentChars).toBe(100)
  })

  it('ignores compaction entries that are not completed', () => {
    const marker = findCompactionMarker([
      compactionEntry({ status: 'failed', summary: undefined, recent: undefined }),
    ])

    expect(marker).toBeUndefined()
  })

  it('tolerates a compaction entry without summary/recent', () => {
    const marker = findCompactionMarker([
      compactionEntry({ summary: undefined, recent: undefined }),
    ])

    // 有边界但无规模：仍然记录 at（用于分隔条），规模按 0 计
    expect(marker?.at).toBe(1_700_000_000_000)
    expect(marker?.summaryChars).toBe(0)
    expect(marker?.recentChars).toBe(0)
  })

  it('returns undefined when there is no compaction at all', () => {
    expect(findCompactionMarker([{ type: 'assistant' }, { type: 'user' }])).toBeUndefined()
  })
})
