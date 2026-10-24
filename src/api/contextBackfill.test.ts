// ============================================
// 上下文用量兜底（session.context）
// ============================================
//
// `session.usage.updated` 是 ephemeral 事件：刷新/重连/换设备后不会补发，
// 统计会退化成「按已加载消息累加」，而首屏只加载 50 条 → 数字严重偏小。
// 这里用 `session.context` 汇总兜底。关键约束：
// 1. 每个会话只补一次（失败也不重试，避免抖动放大请求）。
// 2. 只累加 assistant 的 tokens（每条是该次请求用量，累加即累计消耗）。
// 3. 失败静默。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const getContext = vi.fn()
const recordFallback = vi.fn()
const recordSnapshot = vi.fn()

vi.mock('./v2NativeSession', () => ({ nativeGetSessionContext: getContext }))
vi.mock('../store/messageStore', () => ({
  messageStore: {
    recordSessionUsageFallback: recordFallback,
    recordContextUsageSnapshot: recordSnapshot,
  },
}))
vi.mock('../utils/sessionKey', () => ({
  sessionKeyToServerId: (key: string) => key.slice(0, key.indexOf('::')),
}))
vi.mock('../utils', () => ({ logger: { warn: vi.fn() } }))

const { backfillSessionUsage, resetContextBackfill } = await import('./contextBackfill')

const KEY = 'local::ses_1'

function assistant(tokens: Record<string, unknown>, cost = 0) {
  return { type: 'assistant', tokens, cost }
}

describe('backfillSessionUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetContextBackfill()
  })

  it('累加所有 assistant 的 tokens 并写入兜底值', async () => {
    getContext.mockResolvedValue([
      { type: 'user', text: 'hi' },
      assistant({ input: 100, output: 10, reasoning: 0, cache: { read: 1000, write: 0 } }, 0.5),
      assistant({ input: 200, output: 20, reasoning: 5, cache: { read: 2000, write: 0 } }, 1.5),
    ])

    await backfillSessionUsage(KEY)

    expect(recordFallback).toHaveBeenCalledWith(
      KEY,
      { input: 300, output: 30, reasoning: 5, cache: { read: 3000, write: 0 } },
      2,
    )
  })

  it('忽略非 assistant 消息', async () => {
    getContext.mockResolvedValue([
      { type: 'user', tokens: { input: 99999 } },
      { type: 'shell', tokens: { input: 88888 } },
      assistant({ input: 1, output: 0, reasoning: 0, cache: {} }),
    ])

    await backfillSessionUsage(KEY)
    expect(recordFallback.mock.calls[0][1].input).toBe(1)
  })

  it('没有 assistant 时不写入（会话还没跑过）', async () => {
    getContext.mockResolvedValue([{ type: 'user', text: 'hi' }])
    await backfillSessionUsage(KEY)
    expect(recordFallback).not.toHaveBeenCalled()
  })

  it('同一会话只请求一次', async () => {
    getContext.mockResolvedValue([assistant({ input: 1 })])
    await backfillSessionUsage(KEY)
    await backfillSessionUsage(KEY)
    expect(getContext).toHaveBeenCalledOnce()
  })

  it('失败时不抛错，也不重复请求', async () => {
    getContext.mockRejectedValue(new Error('boom'))
    await expect(backfillSessionUsage(KEY)).resolves.toBeUndefined()
    await backfillSessionUsage(KEY)
    expect(getContext).toHaveBeenCalledOnce()
  })

  it('缺失或异常的 tokens 字段按 0 处理', async () => {
    getContext.mockResolvedValue([
      { type: 'assistant' },
      assistant({ input: 'bad', output: null, cache: null }),
      assistant({ input: 7 }),
    ])

    await backfillSessionUsage(KEY)
    expect(recordFallback.mock.calls[0][1]).toEqual({
      input: 7,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
  })

  it('把裸 sessionID 传给服务端', async () => {
    getContext.mockResolvedValue([assistant({ input: 1 })])
    await backfillSessionUsage('aiagent:inst_9::ses_abc')
    expect(getContext).toHaveBeenCalledWith('aiagent:inst_9', 'ses_abc')
  })

  describe('上下文占用快照', () => {
    it('取最后一条带 tokens 的 assistant 作为快照', async () => {
      // 走网关骨架投影时消息不带 tokens，圆环只能靠这份快照。
      // 官方口径取「最后一条带 tokens 的 assistant」，不是累加。
      getContext.mockResolvedValue([
        { type: 'user', text: 'hi' },
        assistant({ input: 100, output: 10, reasoning: 0, cache: { read: 1000, write: 0 } }, 0.1),
        assistant({ input: 200, output: 20, reasoning: 5, cache: { read: 2000, write: 0 } }, 0.2),
      ])

      await backfillSessionUsage(KEY)

      expect(recordSnapshot).toHaveBeenCalledWith(
        KEY,
        { input: 200, output: 20, reasoning: 5, cache: { read: 2000, write: 0 } },
        0.2,
      )
    })

    it('跳过全 0 的 assistant（尚未结算）', async () => {
      getContext.mockResolvedValue([
        assistant({ input: 300, output: 30, reasoning: 0, cache: { read: 0, write: 0 } }),
        assistant({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      ])

      await backfillSessionUsage(KEY)

      expect(recordSnapshot).toHaveBeenCalledWith(
        KEY,
        { input: 300, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
        0,
      )
    })

    it('没有任何有效 tokens 时不写快照', async () => {
      getContext.mockResolvedValue([assistant({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })])
      await backfillSessionUsage(KEY)
      expect(recordSnapshot).not.toHaveBeenCalled()
    })
  })
})
