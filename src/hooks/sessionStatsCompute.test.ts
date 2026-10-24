import { describe, expect, it } from 'vitest'
import { computeSessionStats, computeSessionStatsCached, isSameSessionStats } from './sessionStatsCompute'
import type { Message, TokenUsage } from '../types/message'

const BASE = 1_700_000_000_000

function userMessage(id: string, text: string, at: number): Message {
  return {
    info: { id, role: 'user', time: { created: BASE + at }, sessionID: 's', agent: 'build', model: { providerID: 'p', modelID: 'm' } },
    content: [{ type: 'text', text, id: `${id}-p`, sessionID: 's', messageID: id }],
  } as unknown as Message
}

function assistantMessage(id: string, at: number, tokens: TokenUsage): Message {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 's',
      time: { created: BASE + at, completed: BASE + at + 10 },
      parentID: 'u1',
      modelID: 'm',
      providerID: 'p',
      mode: 'chat',
      agent: 'default',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens,
    },
    content: [],
  } as unknown as Message
}

/** v2 压缩后留下的摘要消息：没有 tokens，按文本估算会严重偏小 */
function compactionMessage(id: string, at: number): Message {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 's',
      time: { created: BASE + at, completed: BASE + at + 5 },
      parentID: 'u1',
      modelID: 'm',
      providerID: 'p',
      mode: 'compaction',
      agent: 'compaction',
      path: { cwd: '/', root: '/' },
      cost: 0,
      summary: true,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    content: [{ type: 'text', text: 'short summary', id: `${id}-p`, sessionID: 's', messageID: id }],
  } as unknown as Message
}

describe('computeSessionStats', () => {
  it('switches to estimated context after a compaction turn', () => {
    const stats = computeSessionStats(
      [
        {
          info: {
            id: 'user-1',
            role: 'user',
            time: { created: 1 },
            sessionID: 'session-1',
            agent: 'build',
            model: { providerID: 'p', modelID: 'm' },
          },
          content: [{ type: 'text', text: 'hello world', id: 'p1', sessionID: 's1', messageID: 'user-1' }],
        },
        {
          info: {
            id: 'assistant-1',
            role: 'assistant',
            sessionID: 'session-1',
            time: { created: 2 },
            parentID: 'user-1',
            modelID: 'model',
            providerID: 'provider',
            mode: 'chat',
            agent: 'default',
            path: { cwd: '/', root: '/' },
            cost: 0,
            tokens: { input: 12000, output: 800, reasoning: 200, cache: { read: 0, write: 0 } },
          },
          content: [{ type: 'text', text: 'long reply', id: 'p2', sessionID: 's1', messageID: 'assistant-1' }],
        },
        {
          info: {
            id: 'user-2',
            role: 'user',
            time: { created: 3 },
            sessionID: 'session-1',
            agent: 'build',
            model: { providerID: 'p', modelID: 'm' },
          },
          content: [],
        },
        {
          info: {
            id: 'assistant-2',
            role: 'assistant',
            sessionID: 'session-1',
            time: { created: 4 },
            parentID: 'user-2',
            modelID: 'model',
            providerID: 'provider',
            mode: 'compaction',
            agent: 'compaction',
            path: { cwd: '/', root: '/' },
            cost: 0,
            summary: true,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          content: [{ type: 'text', text: 'short summary', id: 'p4', sessionID: 's1', messageID: 'assistant-2' }],
        },
      ],
      200000,
    )

    expect(stats.contextEstimated).toBe(true)
    expect(stats.contextUsed).toBeLessThan(12000)
    expect(stats.contextUsed).toBeGreaterThan(0)
  })

  it('reuses equality when numeric fields are unchanged', () => {
    const a = computeSessionStats([], 200000)
    const b = computeSessionStats([], 200000)
    expect(isSameSessionStats(a, b)).toBe(true)
    expect(isSameSessionStats(a, { ...b, contextUsed: b.contextUsed + 1 })).toBe(false)
  })

  it('uses the server-reported post-compaction usage instead of estimating', () => {
    // 压缩后历史只剩摘要，按文本估算会得到很小的数；服务端回报的才是真实占用
    const stats = computeSessionStats(
      [
        userMessage('u1', 'hello', 1000),
        compactionMessage('a1', 2000),
        userMessage('u2', 'next turn', 3000),
      ],
      200000,
      {
        at: 2000,
        tokens: { input: 48000, output: 1200, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    )

    expect(stats.contextUsed).toBe(49200)
    expect(stats.contextEstimated).toBe(false)
    expect(stats.contextPercent).toBeCloseTo(24.6, 1)
  })

  it('ignores a compaction snapshot that predates the latest message with tokens', () => {
    // 压缩完成后又跑了一轮：上下文已被新一轮刷新，旧快照必须让位
    const stats = computeSessionStats(
      [
        userMessage('u1', 'hello', 1000),
        assistantMessage('a1', 2000, { input: 30000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } }),
        userMessage('u2', 'next turn', 5000),
      ],
      200000,
      { at: 1500, tokens: { input: 900, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
    )

    // 回到最近一条带 tokens 的消息口径（31000），再加上末尾尚未处理的用户输入
    // 'next turn'（9 字符 → 3 token）。此前末尾多一条 user 消息会让整轮退回字符
    // 估算，把实测值丢掉 —— 实测高估过 46%。
    expect(stats.contextUsed).toBe(31003)
  })

  it('prefers server cumulative usage over summing visible messages', () => {
    // 压缩裁掉了旧轮次：可见消息只累加出 100，服务端口径是 5000
    const stats = computeSessionStats(
      [assistantMessage('a1', 2000, { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })],
      200000,
      undefined,
      {
        tokens: { input: 4000, output: 800, reasoning: 100, cache: { read: 80, write: 20 } },
        cost: 3.5,
      },
    )

    expect(stats.inputTokens).toBe(4000)
    expect(stats.outputTokens).toBe(800)
    expect(stats.cacheRead).toBe(80)
    expect(stats.cacheWrite).toBe(20)
    expect(stats.totalTokens).toBe(5000)
    expect(stats.totalCost).toBe(3.5)
  })
})

describe('computeSessionStatsCached', () => {
  it('reuses the result for the same array reference and limit', () => {
    const messages: Parameters<typeof computeSessionStats>[0] = []
    expect(computeSessionStatsCached(messages, 200000)).toBe(computeSessionStatsCached(messages, 200000))
  })

  it('recomputes when the context limit differs', () => {
    const messages: Parameters<typeof computeSessionStats>[0] = []
    const first = computeSessionStatsCached(messages, 200000)
    const second = computeSessionStatsCached(messages, 100000)
    expect(second).not.toBe(first)
    expect(second.contextLimit).toBe(100000)
  })

  it('recomputes when the compaction snapshot changes on the same array reference', () => {
    // 压缩刚结束时消息可能还没重拉，数组引用不变；只比较引用会让圆环停在旧值
    const messages: Parameters<typeof computeSessionStats>[0] = []
    const before = computeSessionStatsCached(messages, 200000)
    const after = computeSessionStatsCached(messages, 200000, {
      at: BASE,
      tokens: { input: 9000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(after).not.toBe(before)
    expect(after.contextUsed).toBe(9500)
  })

  it('recomputes when the server cumulative usage changes', () => {
    const messages: Parameters<typeof computeSessionStats>[0] = []
    const a = computeSessionStatsCached(messages, 200000, undefined, {
      tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    })
    const b = computeSessionStatsCached(messages, 200000, undefined, {
      tokens: { input: 20, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    })
    expect(b).not.toBe(a)
    expect(b.inputTokens).toBe(20)
  })

  it('recomputes when only the v2 compaction marker changes', () => {
    // v2 只更新 marker（不发压缩事件）；缓存键不含 marker 就会一直返回旧值，
    // 表现为「压缩完了圆环不动」。
    const messages: Parameters<typeof computeSessionStats>[0] = []
    const before = computeSessionStatsCached(messages, 200000)
    const after = computeSessionStatsCached(messages, 200000, undefined, undefined, {
      at: BASE,
      summaryChars: 8000,
      recentChars: 4000,
    })
    expect(after).not.toBe(before)
    expect(after.contextUsed).toBe(3000)
  })
})

describe('v2 compaction marker → context usage', () => {
  /**
   * v2 的压缩记录只在 `message.list` 里（`type: "compaction"`），没有压缩事件。
   * 该条目的 tokens 是**压缩前**用量，不能直接用；压缩后上下文 ≈ 摘要 + 近期消息。
   * 旧轮次若仍被算进上下文，圆环永远停在压缩前的高水位 —— 用户报的正是这个。
   */
  it('drops the context estimate after compaction', () => {
    const messages = [
      userMessage('u1', 'x'.repeat(200_000), 0),
      assistantMessage('a1', 1000, { input: 90_000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]

    const before = computeSessionStats(messages, 200000)
    expect(before.contextUsed).toBeGreaterThan(50_000)

    // 压缩完成后：摘要 5.4KB + 近期 92KB ≈ 24.4k tokens（实测参考值）
    const after = computeSessionStats(messages, 200000, undefined, undefined, {
      at: BASE + 2000,
      summaryChars: 5442,
      recentChars: 92_322,
    })

    expect(after.contextUsed).toBeLessThan(before.contextUsed)
    expect(after.contextUsed).toBe(Math.ceil((5442 + 92_322) / 4))
    // 压缩标记是服务端记录的规模，但字符→token 是换算，仍如实标注为估算
    expect(after.contextEstimated).toBe(true)
  })

  it('lets a newer assistant turn take over from the marker', () => {
    const messages = [
      assistantMessage('a1', 1000, { input: 5000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]

    // 压缩在 a1 之后才发生 → 本轮之后的新用量不存在，用 marker
    const withMarker = computeSessionStats(messages, 200000, undefined, undefined, {
      at: BASE + 2000,
      summaryChars: 4000,
      recentChars: 0,
    })
    expect(withMarker.contextUsed).toBe(1000)

    // marker 早于 a1：说明压缩之后又跑了新一轮，真实用量优先
    const withNewerTurn = computeSessionStats(messages, 200000, undefined, undefined, {
      at: BASE - 5000,
      summaryChars: 4000,
      recentChars: 0,
    })
    expect(withNewerTurn.contextUsed).toBe(5100)
  })

  it('ignores a marker without any size information', () => {
    const messages = [
      assistantMessage('a1', 1000, { input: 5000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]

    const stats = computeSessionStats(messages, 200000, undefined, undefined, {
      at: BASE + 2000,
      summaryChars: 0,
      recentChars: 0,
    })

    // 规模未知时不能把上下文显示成 0
    expect(stats.contextUsed).toBe(5100)
  })
})
