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

const getSession = vi.fn()
const getContext = vi.fn()
const recordFallback = vi.fn()
const recordSnapshot = vi.fn()
const applyUsageBackfill = vi.fn()

vi.mock('./v2NativeSession', () => ({
  nativeGetSessionContext: getContext,
  nativeGetSession: getSession,
}))
vi.mock('../store/messageStore', () => ({
  messageStore: {
    recordSessionUsageFallback: recordFallback,
    recordContextUsageSnapshot: recordSnapshot,
    applyUsageBackfill,
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
    /**
     * 默认让轻量的 `session` 接口返回 null。
     *
     * 这样下列「累加 assistant」的用例仍走 session.context 求和分支，
     * 断言口径不变；专门覆盖轻量路径的用例会自己设置返回值。
     */
    getSession.mockResolvedValue(null)
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

  describe('按 id 回填骨架消息', () => {
    it('把每条 assistant 的 tokens/时间按 id 收集起来', () => {
      /**
       * 骨架投影把 tokens / time.streamed / model 整段剥掉，
       * 轮次统计与 TPS 因此全空。这两者无法从前端可见数据反推，
       * 只能由 session.context 按消息 id 回填。
       */
      getContext.mockResolvedValue([
        {
          id: 'msg_a',
          type: 'assistant',
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 0 } },
          cost: 0.1,
          time: { created: 1000, streamed: 5000, completed: 5100 },
        },
        {
          id: 'msg_b',
          type: 'assistant',
          tokens: { input: 200, output: 30, reasoning: 0, cache: { read: 2000, write: 0 } },
          cost: 0.2,
          time: { created: 6000 },
        },
      ])

      return backfillSessionUsage(KEY).then(() => {
        const arg = applyUsageBackfill.mock.calls[0][1] as Map<string, unknown>
        expect(arg.size).toBe(2)
        expect(arg.get('msg_a')).toMatchObject({
          tokens: { input: 100, output: 20, reasoning: 5 },
          cost: 0.1,
          created: 1000,
          streamed: 5000,
          completed: 5100,
        })
        expect(arg.get('msg_b')).toMatchObject({ created: 6000 })
      })
    })

    it('缺少 id 的记录不回填', async () => {
      getContext.mockResolvedValue([
        { type: 'assistant', tokens: { input: 1, output: 0, reasoning: 0, cache: {} } },
      ])
      await backfillSessionUsage(KEY)
      const arg = applyUsageBackfill.mock.calls[0][1] as Map<string, unknown>
      expect(arg.size).toBe(0)
    })
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

describe('轻量路径：优先用 session 接口的累计 tokens', () => {
  /**
   * 实测回归（工作主机，V1 升级上来的大会话）。
   *
   * `session.context` 返回「最后一次压缩之后的完整消息」。读过大量文件的会话里
   * 它会有十几 MB —— 实测某会话 50 次 `read`（每次 350~666KB）导致该响应
   * **10.76MB / 约 2.3~3.9 秒**，而 OCC 只用它算几个 token 数字。
   *
   * 更糟的是它和骨架、session info 抢同一条隧道，把首屏拖慢到数秒。
   *
   * `session` 接口本身就带**会话累计用量**（504 字节 / 约 600ms，口径一致），
   * 所以先走它；逐条明细（上下文快照 / 骨架回填）才需要 context。
   */
  beforeEach(() => {
    vi.clearAllMocks()
    resetContextBackfill()
  })

  it('session 有累计 tokens 时，用它写累计用量（不必依赖 context 求和）', async () => {
    getSession.mockResolvedValue({
      tokens: { input: 111, output: 22, reasoning: 33, cache: { read: 444, write: 0 } },
      cost: 1.25,
    })
    // context 返回的求和值与它不同，用来验证优先用了 session 的值
    getContext.mockResolvedValue([
      assistant({ input: 1, output: 1, reasoning: 1, cache: { read: 1, write: 0 } }, 0),
    ])

    await backfillSessionUsage(KEY)

    expect(recordFallback).toHaveBeenCalledWith(
      KEY,
      { input: 111, output: 22, reasoning: 33, cache: { read: 444, write: 0 } },
      1.25,
    )
  })

  it('session 的 tokens 全 0 时退回 context 求和', async () => {
    getSession.mockResolvedValue({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 })
    getContext.mockResolvedValue([
      assistant({ input: 7, output: 3, reasoning: 0, cache: { read: 9, write: 0 } }, 0.5),
    ])

    await backfillSessionUsage(KEY)

    expect(recordFallback).toHaveBeenCalledWith(
      KEY,
      { input: 7, output: 3, reasoning: 0, cache: { read: 9, write: 0 } },
      0.5,
    )
  })

  it('session 请求失败不影响后续（仍能用 context 兜底）', async () => {
    getSession.mockRejectedValue(new Error('boom'))
    getContext.mockResolvedValue([
      assistant({ input: 5, output: 5, reasoning: 0, cache: { read: 5, write: 0 } }, 0),
    ])

    await expect(backfillSessionUsage(KEY)).resolves.toBeUndefined()
    expect(recordFallback).toHaveBeenCalledWith(
      KEY,
      { input: 5, output: 5, reasoning: 0, cache: { read: 5, write: 0 } },
      0,
    )
  })

  it('累计用量只有一份：session 成功时不再被 context 的求和覆盖', async () => {
    getSession.mockResolvedValue({ tokens: { input: 999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 })
    getContext.mockResolvedValue([assistant({ input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 0)])

    await backfillSessionUsage(KEY)

    // 只写一次，且写的是 session 的值
    expect(recordFallback).toHaveBeenCalledTimes(1)
    expect(recordFallback.mock.calls[0][1].input).toBe(999)
  })
})
