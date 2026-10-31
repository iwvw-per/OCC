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

describe('context usage snapshot（骨架投影不带 tokens 的兜底）', () => {
  /** 骨架投影里的 assistant：只有正文，没有任何 tokens */
  function skeletonAssistant(id: string, at: number): Message {
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
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      content: [{ type: 'text', text: '很短的回复', id: `${id}-p`, sessionID: 's', messageID: id }],
    } as unknown as Message
  }

  it('uses the snapshot when no message carries tokens', () => {
    // 典型场景：走网关骨架投影进入会话，消息里没有 tokens。
    // 没有快照就是「未知」—— 不再按字符估算（图片/附件不计入，估算系统性偏低）。
    const messages = [userMessage('u1', '问题', 0), skeletonAssistant('a1', 5)]
    const unknown = computeSessionStats(messages, 200000)
    const withSnapshot = computeSessionStats(messages, 200000, undefined, undefined, undefined, {
      at: BASE,
      tokens: { input: 8000, output: 300, reasoning: 200, cache: { read: 4000, write: 0 } },
      cost: 0,
    })

    expect(unknown.contextUsed).toBeNull()
    expect(unknown.contextPercent).toBeNull()

    // 官方口径：input + output + reasoning + cache.read + cache.write
    expect(withSnapshot.contextUsed).toBe(12500)
    expect(withSnapshot.contextEstimated).toBe(false)
  })

  it('ignores the snapshot once a message carries measured tokens', () => {
    // 用户发过消息 → 拉到完整消息，消息级实测值一定比快照新
    const messages = [
      userMessage('u1', '问题', 0),
      assistantMessage('a1', 5, { input: 1000, output: 50, reasoning: 0, cache: { read: 500, write: 0 } }),
    ]
    const stats = computeSessionStats(messages, 200000, undefined, undefined, undefined, {
      at: BASE,
      tokens: { input: 9999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    })

    expect(stats.contextUsed).toBe(1550)
    expect(stats.contextEstimated).toBe(false)
  })

  it('still prefers the compaction snapshot over the backfill snapshot', () => {
    const messages = [userMessage('u1', '问题', 0), skeletonAssistant('a1', 5)]
    const stats = computeSessionStats(
      messages,
      200000,
      { at: BASE, tokens: { input: 3000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      undefined,
      undefined,
      { at: BASE, tokens: { input: 9999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
    )

    expect(stats.contextUsed).toBe(3000)
  })

  it('reports unknown (not an estimate) when the snapshot is empty', () => {
    const messages = [userMessage('u1', '问题', 0), skeletonAssistant('a1', 5)]
    const stats = computeSessionStats(messages, 200000, undefined, undefined, undefined, {
      at: BASE,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    })

    expect(stats.contextUsed).toBeNull()
    expect(stats.contextPercent).toBeNull()
    expect(stats.contextEstimated).toBe(false)
  })
})

describe('computeSessionStats', () => {
  it('reports unknown context after a compaction turn with no measured tokens', () => {
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

    // 压缩摘要消息不带实测 tokens → 占用未知（不再按字符估算）
    expect(stats.contextUsed).toBeNull()
    expect(stats.contextPercent).toBeNull()
    expect(stats.contextEstimated).toBe(false)
  })

  it('reuses equality when numeric fields are unchanged', () => {
    const a = computeSessionStats([], 200000)
    const b = computeSessionStats([], 200000)
    expect(isSameSessionStats(a, b)).toBe(true)
    expect(isSameSessionStats(a, { ...b, contextUsed: (b.contextUsed ?? 0) + 1 })).toBe(false)
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

    // 回到最近一条带 tokens 的消息口径（31000）。
    // 末尾尚未处理的用户输入不再按字符加进去 —— 那是估算，与「只认服务端实测」
    // 相冲突；真实值在下一轮 assistant 的 tokens 里出现。
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

  it('recomputes when only the context usage snapshot arrives', () => {
    /**
     * backfill 是异步的：快照落地时 messages 引用没变。
     * 若快照不参与缓存键，圆环会一直停在字符估算值上 ——
     * 这正是「进入会话用量不对」的表现。
     */
    const messages: Parameters<typeof computeSessionStats>[0] = []
    const before = computeSessionStatsCached(messages, 200000)
    const after = computeSessionStatsCached(messages, 200000, undefined, undefined, undefined, {
      at: BASE,
      tokens: { input: 8000, output: 300, reasoning: 200, cache: { read: 4000, write: 0 } },
      cost: 0,
    })
    expect(after).not.toBe(before)
    expect(after.contextUsed).toBe(12500)
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
    // 没有任何服务端实测值 → 占用未知（不再按字符换算）
    expect(after.contextUsed).toBeNull()
    expect(after.contextPercent).toBeNull()
  })
})

describe('v2 compaction marker → context usage', () => {
  /**
   * v2 的压缩记录只在 `message.list` 里（`type: "compaction"`），没有压缩事件。
   * 该条目的 tokens 是**压缩前**用量，不能直接用。
   *
   * 压缩后的占用**只认服务端实测值**（`session.compaction.ended` 的 tokens）。
   * marker 只有字符数，换算出来是估算，现在不再采用 —— 因此压缩后若还没有
   * 新的实测值，占用显示为未知，而不是一个偏低的假数字。
   */
  it('does not invent a context estimate from the compaction marker', () => {
    const messages = [
      userMessage('u1', 'x'.repeat(200_000), 0),
      assistantMessage('a1', 1000, { input: 90_000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]

    const before = computeSessionStats(messages, 200000)
    expect(before.contextUsed).toBeGreaterThan(50_000)

    // 压缩完成后：摘要 5.4KB + 近期 92KB（只有字符数，没有服务端 tokens）。
    // 压缩事件给出 tokens 时口径见下一条用例；这里只有 marker，不该凭空造数字。
    const after = computeSessionStats(messages, 200000, { at: BASE + 2000, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, undefined, {
      at: BASE + 2000,
      summaryChars: 5442,
      recentChars: 92_322,
    })

    // 压缩快照 tokens 全 0 + 末条实测值早于压缩 → 未知
    expect(after.contextUsed).toBeNull()
    expect(after.contextPercent).toBeNull()
    expect(after.contextEstimated).toBe(false)
  })

  it('ignores the marker entirely and keeps the measured message usage', () => {
    const messages = [
      assistantMessage('a1', 1000, { input: 5000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }),
    ]

    // marker 只有字符数、没有服务端 tokens → 不参与计算，始终用消息实测值
    const withMarker = computeSessionStats(messages, 200000, undefined, undefined, {
      at: BASE + 2000,
      summaryChars: 4000,
      recentChars: 0,
    })
    expect(withMarker.contextUsed).toBe(5100)

    const withOlderMarker = computeSessionStats(messages, 200000, undefined, undefined, {
      at: BASE - 5000,
      summaryChars: 4000,
      recentChars: 0,
    })
    expect(withOlderMarker.contextUsed).toBe(5100)
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

describe('contextPercent 在窗口未知时为 null（不猜默认窗口）', () => {
  it('contextLimit 传 0 时 percent 为 null，而不是 0 或按 200000 算出的值', () => {
    /**
     * 回归：旧实现各处兜底 200000，实测某模型真实窗口是 1000000。
     * 用猜来的分母算百分比会虚高 5 倍，用户会以为「快满了」。
     * 未知就该是 null，由 UI 显示「窗口未知」。
     */
    const stats = computeSessionStats(
      [userMessage('u1', 'hello', 1000), assistantMessage('a1', 2000, {
        input: 300000,
        output: 1000,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })],
      0,
    )
    expect(stats.contextLimit).toBe(0)
    expect(stats.contextPercent).toBeNull()
    // 用量本身仍要正确上报（用户还是要看到用了多少）
    expect(stats.contextUsed).toBeGreaterThan(0)
  })

  it('缺省参数同样视为未知', () => {
    const stats = computeSessionStats([userMessage('u1', 'hi', 1000)])
    expect(stats.contextPercent).toBeNull()
  })

  it('窗口已知时仍正常计算', () => {
    const stats = computeSessionStats(
      [userMessage('u1', 'hello', 1000), assistantMessage('a1', 2000, {
        input: 100000,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })],
      1000000,
    )
    expect(stats.contextPercent).toBeCloseTo(10, 1)
  })

  it('缓存命中后仍区分「未知窗口」与「已知窗口」，不会互相污染', () => {
    const messages = [userMessage('u1', 'hello', 1000), assistantMessage('a1', 2000, {
      input: 100000,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })]
    const unknown = computeSessionStatsCached(messages, 0)
    const known = computeSessionStatsCached(messages, 1000000)
    expect(unknown.contextPercent).toBeNull()
    expect(known.contextPercent).toBeCloseTo(10, 1)
  })
})
