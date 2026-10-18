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

    // 回到最近一条带 tokens 的消息口径，而不是那条过期的 1000
    expect(stats.contextUsed).toBe(31000)
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
})
