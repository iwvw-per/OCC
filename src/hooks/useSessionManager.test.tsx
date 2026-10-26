import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionManager } from './useSessionManager'
import { HISTORY_TURN_BATCH_SIZE } from '../constants'

const {
  getSessionMock,
  getSessionTurnPageMock,
  lightweightMessagesMock,
  probeLightweightSupportMock,
  peekLightweightSupportMock,
  messageStoreMock,
  sessionErrorHandlerMock,
  revertMessageMock,
  extractUserMessageContentMock,
  backfillSessionUsageMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionTurnPageMock: vi.fn(),
  lightweightMessagesMock: vi.fn(),
  probeLightweightSupportMock: vi.fn(async () => false),
  peekLightweightSupportMock: vi.fn(),
  messageStoreMock: {
    getSessionState: vi.fn(),
    setLoadState: vi.fn(),
    setLoadError: vi.fn(),
    setMessages: vi.fn(),
    updateSessionMetadata: vi.fn(),
    prependMessages: vi.fn(),
    setRevertState: vi.fn(),
    compressHistoricalTurns: vi.fn(() => false),
    // hydrateTurn 的两条落库路径（合并 / 骨架轮整段替换）
    hydrateMessages: vi.fn(() => true),
    replaceTurnMessages: vi.fn(() => true),
    setTurnSkeleton: vi.fn(),
    getTrimmedCount: vi.fn(() => 0),
    settleByAuthoritativeIdle: vi.fn(() => false),
  },
  sessionErrorHandlerMock: vi.fn(),
  revertMessageMock: vi.fn(),
  extractUserMessageContentMock: vi.fn((_message: unknown) => ({ text: 'hello', attachments: [] })),
  backfillSessionUsageMock: vi.fn(async () => {}),
}))

vi.mock('../api', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  getSessionTurnPage: (...args: unknown[]) => getSessionTurnPageMock(...args),
  // 首屏两段式：测试里等价于「一次就取够」，不额外发第二段请求。
  // 需要验证分段行为时单独 mock getSessionFirstScreenMock。
  getSessionFirstScreen: async (...args: unknown[]) => {
    const page = await getSessionTurnPageMock(...args)
    return { ...page, complete: true }
  },
  getSessionMessagePage: (...args: unknown[]) => getSessionTurnPageMock(...args),
  // 轮次骨架路径：只有 peekLightweightSupport 已确认支持时才会被调用。
  // 未知时首屏一律走按量分页，绝不为探测付几十 MB 的代价。
  getSessionLightweightMessages: (...args: unknown[]) => lightweightMessagesMock(...args),
  probeLightweightSupport: (...args: unknown[]) => probeLightweightSupportMock(...(args as [])),
  peekLightweightSupport: (...args: unknown[]) => peekLightweightSupportMock(...(args as [])),
  revertMessage: (...args: unknown[]) => revertMessageMock(...args),
  unrevertSession: vi.fn(),
  encodeBeforeCursor: (message: unknown) => `cursor:${(message as { info?: { id?: string } }).info?.id ?? ''}`,
  extractUserMessageContent: (message: unknown) => extractUserMessageContentMock(message),
  // 真实模块里的常量：hydrateTurn 用它当单页上限
  LIGHTWEIGHT_MESSAGE_LIMIT: 200,
}))

vi.mock('../store', () => ({
  messageStore: messageStoreMock,
}))

// 上下文用量兜底会真的打网络（session.context），测试里必须隔离。
// 它由 loadSession 通过 `void` 调用，若让真实实现跑起来，失败路径会变成
// unhandled rejection —— 表现为「断言全过但退出码非 0」。
vi.mock('../api/contextBackfill', () => ({
  backfillSessionUsage: (...args: unknown[]) => backfillSessionUsageMock(...(args as [])),
  resetContextBackfill: vi.fn(),
}))

vi.mock('../utils', () => ({
  sessionErrorHandler: (...args: unknown[]) => sessionErrorHandlerMock(...args),
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

describe('useSessionManager', () => {
  beforeEach(() => {
    getSessionMock.mockReset()
    getSessionTurnPageMock.mockReset()
    lightweightMessagesMock.mockReset()
    probeLightweightSupportMock.mockReset()
    probeLightweightSupportMock.mockResolvedValue(false)
    peekLightweightSupportMock.mockReset()
    peekLightweightSupportMock.mockReturnValue(undefined)
    messageStoreMock.getSessionState.mockReset()
    messageStoreMock.setLoadState.mockReset()
    messageStoreMock.setLoadError.mockReset()
    messageStoreMock.setMessages.mockReset()
    messageStoreMock.updateSessionMetadata.mockReset()
    messageStoreMock.prependMessages.mockReset()
    messageStoreMock.setRevertState.mockReset()
    messageStoreMock.compressHistoricalTurns.mockReset()
    messageStoreMock.compressHistoricalTurns.mockReturnValue(false)
    messageStoreMock.hydrateMessages.mockReset()
    messageStoreMock.hydrateMessages.mockReturnValue(false)
    messageStoreMock.getTrimmedCount.mockReset()
    messageStoreMock.settleByAuthoritativeIdle.mockReset()
    messageStoreMock.getTrimmedCount.mockReturnValue(0)
    sessionErrorHandlerMock.mockReset()
    revertMessageMock.mockReset()
    extractUserMessageContentMock.mockReset()

    messageStoreMock.getSessionState.mockReturnValue(null)
    getSessionMock.mockResolvedValue({ id: 'session-1', directory: '/workspace/demo' })
    getSessionTurnPageMock.mockResolvedValue({ messages: [], nextCursor: undefined, hasMore: false })
    revertMessageMock.mockResolvedValue({})
    extractUserMessageContentMock.mockReturnValue({ text: 'hello', attachments: [] })
  })

  it('reports missing route sessions when loading returns not found', async () => {
    const onSessionMissing = vi.fn()
    const notFoundError = Object.assign(new Error('session not found'), { status: 404 })
    getSessionMock.mockRejectedValue(notFoundError)
    getSessionTurnPageMock.mockRejectedValue(notFoundError)

    renderHook(() =>
      useSessionManager({
        sessionId: 'missing-session',
        directory: '/workspace/demo',
        onSessionMissing,
      }),
    )

    await waitFor(() => {
      expect(onSessionMissing).toHaveBeenCalledWith('missing-session')
    })

    expect(messageStoreMock.setLoadState).toHaveBeenCalledWith('missing-session', 'loading')
    expect(messageStoreMock.setLoadError).toHaveBeenCalledWith(
      'missing-session',
      expect.objectContaining({ name: 'APIError' }),
    )
  })

  it('probes once on a cold cache, then falls back to paging when unsupported', async () => {
    /**
     * 冷缓存（第一次打开）时先探测一次，再决定走骨架还是分页。
     *
     * 探测很便宜：只要响应头，body 立刻 cancel。相比「先分页、下次才用骨架」，
     * 多付一个往返能省下几 MB 的分页拉取，是划算的。
     *
     * 关键安全点：**探测判定不支持时绝不发骨架请求**。旧版 Agent 会把
     * `X-Lightweight: skeleton` 原样透传给 opencode，拿到的是单条普通消息 ——
     * 若当成整段用，会话就只剩最后一条。
     */
    getSessionTurnPageMock.mockResolvedValue({ messages: [], nextCursor: undefined, hasMore: false })
    peekLightweightSupportMock.mockReturnValue(undefined)
    probeLightweightSupportMock.mockResolvedValue(false)

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadSession('session-1')
    })

    // 冷缓存 → 探测过一次
    expect(probeLightweightSupportMock).toHaveBeenCalled()
    // 判定不支持 → 不拉骨架，走分页
    expect(lightweightMessagesMock).not.toHaveBeenCalled()
    expect(getSessionTurnPageMock).toHaveBeenCalled()
  })

  it('uses the turn skeleton path once support is confirmed', async () => {
    // 缓存确认支持 → 首屏走骨架（整段、每轮只有提问 + 回复），不再分页。
    peekLightweightSupportMock.mockReturnValue(true)
    lightweightMessagesMock.mockResolvedValue({
      messages: [
        { info: { id: 'user-1', role: 'user', time: { created: 1 } }, parts: [] },
        { info: { id: 'reply-1', role: 'assistant', time: { created: 1 } }, parts: [] },
      ],
      hasMore: false,
    })
    getSessionTurnPageMock.mockResolvedValue({ messages: [], nextCursor: undefined, hasMore: false })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadSession('session-1')
    })

    // 骨架路径生效：不再走分页（具体调用次数取决于 effect 是否也触发一次加载）
    expect(lightweightMessagesMock).toHaveBeenCalled()
    expect(getSessionTurnPageMock).not.toHaveBeenCalled()
  })

  it('backfills usage on the skeleton path (it returns early, before the shared tail call)', async () => {
    /**
     * 回归：骨架路径在补完大纲后直接 `return`，走不到末尾的统一
     * `backfillSessionUsage` 调用。于是「进入会话」时 tokens 全部缺失：
     * 上下文圆环按字符估算、轮次统计全是「—」、TPS 为 0 ——
     * 只有发一条消息（走完整拉取）后才突然正常。
     */
    peekLightweightSupportMock.mockReturnValue(true)
    lightweightMessagesMock.mockResolvedValue({
      messages: [
        { info: { id: 'user-1', role: 'user', time: { created: 1 } }, parts: [] },
        { info: { id: 'reply-1', role: 'assistant', time: { created: 1 } }, parts: [] },
      ],
      hasMore: false,
    })
    getSessionTurnPageMock.mockResolvedValue({ messages: [], nextCursor: undefined, hasMore: false })
    backfillSessionUsageMock.mockClear()

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadSession('session-1')
    })

    expect(backfillSessionUsageMock).toHaveBeenCalled()
  })

  it('loads history by turn batch with the store cursor', async () => {
    const apiMessage = {
      info: { id: 'message-0', role: 'user', time: { created: 1 } },
      content: [], parts: [],
    }
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [{ info: { id: 'message-1', role: 'user', time: { created: 2 } }, content: [], parts: [] }],
      directory: '/workspace/demo',
      hasMoreHistory: true,
      historyCursor: 'cursor-1',
    })
    getSessionTurnPageMock.mockResolvedValue({ messages: [apiMessage], nextCursor: 'cursor-2', hasMore: true })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    expect(getSessionTurnPageMock).toHaveBeenCalledWith(
      'session-1',
      HISTORY_TURN_BATCH_SIZE,
      'cursor-1',
      '/workspace/demo',
      expect.anything(),
      expect.objectContaining({ pageLimit: expect.any(Number) }),
    )
    expect(messageStoreMock.prependMessages).toHaveBeenCalledWith('session-1', [apiMessage], true, 'cursor-2')
  })

  it('stops auto-loading when a has-cursor page overlaps fully with loaded messages', async () => {
    // v2 边界：带游标翻页，服务端却返回与内存完全重叠的一页（且仍报 hasMore）。
    // 去重后没有任何新内容 —— 不能把 hasMoreHistory 续成 true，也不能保留耗尽的游标，
    // 否则 ChatArea 在顶部反复触发 loadMore，形成「加载历史记录…」无限循环。
    const kept = { info: { id: 'message-1', role: 'user', time: { created: 2 } }, content: [], parts: [] }
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [kept],
      loadState: 'loaded',
      isStale: false,
      directory: '/workspace/demo',
      hasMoreHistory: true,
      historyCursor: 'cursor-1',
    })
    messageStoreMock.getTrimmedCount.mockReturnValue(0)
    getSessionTurnPageMock.mockResolvedValue({ messages: [kept], nextCursor: 'cursor-2', hasMore: true })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    // 有游标 → 确实发起了翻页，但一条都没补到：hasMore=false 且游标清空，循环终止
    expect(getSessionTurnPageMock).toHaveBeenCalledWith(
      'session-1',
      HISTORY_TURN_BATCH_SIZE,
      'cursor-1',
      '/workspace/demo',
      expect.anything(),
      expect.objectContaining({ pageLimit: expect.any(Number) }),
    )
    expect(messageStoreMock.prependMessages).toHaveBeenCalledWith('session-1', [], false, undefined)
  })

  it('loads older history by turn batch when the server returns no cursor', async () => {
    const apiMessage = {
      info: { id: 'message-0', role: 'user', time: { created: 1 } },
      content: [], parts: [],
    }
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [
        { info: { id: 'message-1', role: 'user', time: { created: 2 } }, content: [], parts: [] },
        { info: { id: 'message-2', role: 'assistant', time: { created: 3 } }, content: [], parts: [] },
      ],
      directory: '/workspace/demo',
      hasMoreHistory: true,
      historyCursor: undefined,
    })
    getSessionTurnPageMock.mockResolvedValue({
      messages: [apiMessage],
      nextCursor: undefined,
      hasMore: false,
    })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    // 无游标（旧版 serve）：以不少于 HISTORY_TURN_BATCH_SIZE 的轮数从最新端补齐
    const historyCalls = getSessionTurnPageMock.mock.calls.filter(call => call[2] === undefined && (call[1] as number) >= HISTORY_TURN_BATCH_SIZE)
    expect(historyCalls).toHaveLength(1)
    expect(messageStoreMock.prependMessages).toHaveBeenCalledWith('session-1', [apiMessage], false, undefined)
  })

  it('loads forward until the target message is in memory', async () => {
    const target = { info: { id: 'target', role: 'user', time: { created: 1 } }, content: [], parts: [] }
    let state: {
      messages: Array<{ info: Record<string, unknown>; content: unknown[]; parts: unknown[] }>
      directory: string
      hasMoreHistory: boolean
      historyCursor: string | undefined
    } = {
      messages: [{ info: { id: 'message-1', role: 'user', time: { created: 2 } }, content: [], parts: [] }],
      directory: '/workspace/demo',
      hasMoreHistory: true,
      historyCursor: 'cursor-1',
    }
    messageStoreMock.getSessionState.mockImplementation(() => state)
    getSessionTurnPageMock.mockImplementation(async () => {
      state = { ...state, messages: [target, ...state.messages], historyCursor: undefined, hasMoreHistory: false }
      return { messages: [target], nextCursor: undefined, hasMore: false }
    })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    let found = false
    await act(async () => {
      found = await result.current.loadUntilMessage('target')
    })

    expect(found).toBe(true)
  })

  it('does not request history when the session is already at the earliest message', async () => {
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [{ info: { id: 'message-1', role: 'user', time: { created: 2 } }, content: [], parts: [] }],
      loadState: 'loaded',
      isStale: false,
      directory: '/workspace/demo',
      hasMoreHistory: false,
      historyCursor: undefined,
    })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    expect(getSessionTurnPageMock).not.toHaveBeenCalled()
  })

  it('does not re-arm hasMoreHistory when a no-cursor refetch yields no older messages', async () => {
    // 大会话「一次拉全」后被裁剪：服务端说没有更早历史，本地存在缺口。
    const kept = { info: { id: 'message-kept', role: 'assistant', time: { created: 9 } }, content: [], parts: [] }
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [kept],
      loadState: 'loaded',
      isStale: false,
      directory: '/workspace/demo',
      hasMoreHistory: false,
      historyCursor: undefined,
    })
    messageStoreMock.getTrimmedCount.mockReturnValue(700)
    // 重拉的「最新一页」与内存完全重叠 → 去重后没有任何新内容
    getSessionTurnPageMock.mockResolvedValue({
      messages: [kept],
      nextCursor: 'cursor-next',
      hasMore: true,
    })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    // 有缺口时确实发起了一次补拉
    expect(getSessionTurnPageMock).toHaveBeenCalled()
    // 关键：一条新内容都没补到，就不能把页面再次置为「还有历史」——
    // 否则 ChatArea 会立刻再触发 loadMore，形成「加载历史记录」循环。
    expect(messageStoreMock.prependMessages).toHaveBeenCalledWith('session-1', [], false, 'cursor-next')
  })

  it('keeps hasMoreHistory when a no-cursor refetch does bring older messages', async () => {
    const kept = { info: { id: 'message-kept', role: 'assistant', time: { created: 9 } }, content: [], parts: [] }
    const older = { info: { id: 'message-older', role: 'user', time: { created: 1 } }, content: [], parts: [] }
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [kept],
      loadState: 'loaded',
      isStale: false,
      directory: '/workspace/demo',
      hasMoreHistory: false,
      historyCursor: undefined,
    })
    messageStoreMock.getTrimmedCount.mockReturnValue(700)
    getSessionTurnPageMock.mockResolvedValue({
      messages: [older, kept],
      nextCursor: 'cursor-next',
      hasMore: true,
    })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    // 补到了更早内容且服务端仍报 hasMore → 保留「还有历史」，上滑可继续
    expect(messageStoreMock.prependMessages).toHaveBeenCalledWith('session-1', [older], true, 'cursor-next')
  })

  it('auto-recovers the trimmed gap right after a load without waiting for scroll', async () => {
    // 场景：首屏一次拉全后被内存预算裁掉最旧一段。若不主动补，
    // 缺口只能靠用户手动上滑 —— 而那条路径还有 userScrolled 判定问题，
    // 实际表现就是「会话最前面几轮永远看不到」。
    const kept = { info: { id: 'msg-kept', role: 'assistant', time: { created: 9 } }, content: [], parts: [] }
    const older = { info: { id: 'msg-older', role: 'user', time: { created: 1 } }, content: [], parts: [] }

    messageStoreMock.getSessionState.mockReturnValue({
      messages: [kept],
      loadState: 'idle',
      isStale: false,
      directory: '/workspace/demo',
      hasMoreHistory: false,
      historyCursor: undefined,
    })
    getSessionMock.mockResolvedValue({ id: 'session-1', directory: '/workspace/demo' })
    getSessionTurnPageMock.mockResolvedValue({
      messages: [older, kept],
      nextCursor: 'cursor-next',
      hasMore: false,
    })
    // 拉全后 setMessages 触发裁剪 → 缺口 700
    messageStoreMock.getTrimmedCount.mockReturnValue(700)

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadSession('session-1')
    })

    // 加载即自动补缺口：无需任何用户滚动
    await waitFor(() => {
      expect(messageStoreMock.prependMessages).toHaveBeenCalled()
    })
    const [sid, candidates] = messageStoreMock.prependMessages.mock.calls.at(-1) as [string, unknown[]]
    expect(sid).toBe('session-1')
    expect(candidates).toEqual([older])
  })

  it('gap recovery fetches OLDER from the oldest loaded message, not the newest page', async () => {
    // 回归：大会话（2245 条）窗口被裁出缺口后，旧实现用 before=undefined 重拉
    // 「最新一页」——与内存窗口重叠、去重后 0 条，缺口永不归零，ChatArea 在顶部
    // 无限自动加载「加载历史记录…」。正确做法是从「内存里最旧一条」向前翻页。
    const oldest = { info: { id: 'msg-oldest', role: 'user', time: { created: 100 } }, content: [], parts: [] }
    const newer = { info: { id: 'msg-newer', role: 'assistant', time: { created: 200 } }, content: [], parts: [] }
    const older = { info: { id: 'msg-older', role: 'user', time: { created: 50 } }, content: [], parts: [] }
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [oldest, newer],
      loadState: 'loaded',
      isStale: false,
      directory: '/workspace/demo',
      hasMoreHistory: true,
      historyCursor: undefined,
    })
    messageStoreMock.getTrimmedCount.mockReturnValue(700)
    getSessionTurnPageMock.mockResolvedValue({ messages: [older], nextCursor: 'cursor-next', hasMore: true })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadMoreHistory()
    })

    // 关键：带上了指向最旧一条之前的游标，而不是 before=undefined 重拉最新端
    expect(getSessionTurnPageMock).toHaveBeenCalledWith(
      'session-1',
      HISTORY_TURN_BATCH_SIZE,
      'cursor:msg-oldest',
      '/workspace/demo',
      expect.anything(),
      expect.objectContaining({ pageLimit: expect.any(Number) }),
    )
    expect(messageStoreMock.prependMessages).toHaveBeenCalledWith('session-1', [older], true, 'cursor-next')
  })

  it('does not attempt gap recovery when nothing was trimmed', async () => {
    messageStoreMock.getSessionState.mockReturnValue(null)
    getSessionMock.mockResolvedValue({ id: 'session-1', directory: '/workspace/demo' })
    getSessionTurnPageMock.mockResolvedValue({ messages: [], nextCursor: undefined, hasMore: false })
    // 未发生裁剪
    messageStoreMock.getTrimmedCount.mockReturnValue(0)
    messageStoreMock.compressHistoricalTurns.mockReturnValue(false)

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadSession('session-1')
    })

    // 没有缺口就不该多发一次补拉请求（省一次隧道往返）
    expect(messageStoreMock.prependMessages).not.toHaveBeenCalled()
  })

  it('keeps showing existing messages while force-refreshing a loaded session', async () => {
    // 重连/host 切换后的 force 刷新不应把 loadState 打回 loading：
    // ChatPane 用 loadState === 'loaded' 决定是否挂载 ChatArea，一旦回落，
    // 已渲染的对话会被卸载、闪一次全屏 loading、再重挂，滚动位置丢失。
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [{ info: { id: 'message-1', role: 'user', time: { created: 2 } }, content: [], parts: [] }],
      loadState: 'loaded',
      isStale: false,
      isStreaming: false,
      directory: '/workspace/demo',
      hasMoreHistory: false,
      historyCursor: undefined,
    })
    getSessionTurnPageMock.mockResolvedValue({
      messages: [{ info: { id: 'message-1', role: 'user', time: { created: 2 } }, content: [], parts: [] }],
    })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    messageStoreMock.setLoadState.mockClear()

    await act(async () => {
      await result.current.loadSession('session-1', { force: true })
    })

    expect(messageStoreMock.setLoadState).not.toHaveBeenCalledWith('session-1', 'loading')
    expect(messageStoreMock.setMessages).toHaveBeenCalled()
  })

  it('still shows the loading state when the session has no displayed messages yet', async () => {
    messageStoreMock.getSessionState.mockReturnValue(null)
    getSessionTurnPageMock.mockResolvedValue({ messages: [], nextCursor: undefined, hasMore: false })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    await act(async () => {
      await result.current.loadSession('session-2')
    })

    expect(messageStoreMock.setLoadState).toHaveBeenCalledWith('session-2', 'loading')
  })

  it('retries a transient Failed to fetch and succeeds without surfacing an error', async () => {
    vi.useFakeTimers()
    try {
      messageStoreMock.getSessionState.mockReturnValue(null)
      getSessionTurnPageMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({ messages: [], nextCursor: undefined, hasMore: false })

      const { result } = renderHook(() =>
        useSessionManager({ sessionId: null, directory: '/workspace/demo' }),
      )

      const loadPromise = result.current.loadSession('session-1')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
        await loadPromise
      })

      expect(getSessionTurnPageMock).toHaveBeenCalledTimes(2)
      expect(messageStoreMock.setMessages).toHaveBeenCalled()
      expect(messageStoreMock.setLoadError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after retries and surfaces the error', async () => {
    vi.useFakeTimers()
    try {
      messageStoreMock.getSessionState.mockReturnValue(null)
      getSessionTurnPageMock.mockRejectedValue(new TypeError('Failed to fetch'))

      const { result } = renderHook(() =>
        useSessionManager({ sessionId: null, directory: '/workspace/demo' }),
      )

      const loadPromise = result.current.loadSession('session-1')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
        await loadPromise
      })

      // 1 次初始 + 2 次重试（退避已缩短为 [300, 800]，最多 3 次尝试）
      expect(getSessionTurnPageMock).toHaveBeenCalledTimes(3)
      expect(messageStoreMock.setLoadError).toHaveBeenCalledWith('session-1', expect.objectContaining({ name: 'APIError' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a 404 session-not-found error', async () => {
    vi.useFakeTimers()
    try {
      messageStoreMock.getSessionState.mockReturnValue(null)
      const notFound = Object.assign(new Error('session not found'), { status: 404 })
      getSessionTurnPageMock.mockRejectedValue(notFound)

      const { result } = renderHook(() =>
        useSessionManager({ sessionId: null, directory: '/workspace/demo' }),
      )

      const loadPromise = result.current.loadSession('session-1')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
        await loadPromise
      })

      expect(getSessionTurnPageMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('requestUndo issues the network call but does not commit state', async () => {
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [
        {
          info: { id: 'message-1', role: 'user', time: { created: 1 }, model: { providerID: 'p', modelID: 'm' }, agent: 'build' },
          content: [], parts: [],
        },
        { info: { id: 'message-2', role: 'assistant', time: { created: 2 } }, content: [], parts: [] },
      ],
      directory: '/workspace/demo',
    })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    let revertState: unknown
    await act(async () => {
      revertState = await result.current.requestUndo('message-1')
    })

    expect(revertMessageMock).toHaveBeenCalledWith('session-1', 'message-1', undefined, '/workspace/demo', expect.anything())
    expect(revertState).toMatchObject({ messageId: 'message-1' })
    // 拆分后 requestUndo 不落状态，由 commitUndo 负责
    expect(messageStoreMock.setRevertState).not.toHaveBeenCalled()
  })

  it('commitUndo applies the revert state to the store', async () => {
    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'session-1', directory: '/workspace/demo' }),
    )

    act(() => {
      result.current.commitUndo({ messageId: 'message-1', history: [] })
    })

    expect(messageStoreMock.setRevertState).toHaveBeenCalledWith('session-1', {
      messageId: 'message-1',
      history: [],
    })
  })
})

describe('hydrateTurn（展开折叠块回拉）', () => {
  /**
   * 回归：偶发「展开最新轮次一片空白，多刷几次又好了」。
   *
   * 三个成因，都已修：
   *   1. 请求条数用 turnMessages.length —— 骨架态内存里只有 2 条，只拉回 2 条
   *   2. 时间戳切分遇到毫秒级偏移把整轮剔光，然后静默 return
   *   3. 用 loadSequenceRef 判并发 —— 与首屏加载竞争时丢弃结果且不重试
   */
  const TURN_USER = 'msg_user_1'
  const NEXT_USER = 'msg_user_2'

  function assistantMsg(id: string, created: number) {
    return {
      info: { id, role: 'assistant', time: { created, completed: created + 10 } },
      content: [{ id: `${id}-p`, type: 'text', text: 'x', sessionID: 's', messageID: id }],
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // 只清返回值，不清调用记录（hydrateTurn 的断言依赖它）
    getSessionTurnPageMock.mockClear()
    getSessionTurnPageMock.mockResolvedValue({ messages: [], nextCursor: undefined, hasMore: false })
    messageStoreMock.getSessionState.mockReturnValue({
      messages: [
        // 骨架态：本轮只有 user + 最终回复两条
        { info: { id: TURN_USER, role: 'user', time: { created: 1000 } }, content: [], isCompressed: true },
        {
          info: { id: 'reply_1', role: 'assistant', time: { created: 1000, completed: 1000 } },
          content: [],
          // 骨架/压缩态：hydrateTurn 靠它判断「这一轮需要回拉」
          isCompressed: true,
        },
        { info: { id: NEXT_USER, role: 'user', time: { created: 5000 } }, content: [], isCompressed: true },
      ],
      directory: '/w',
    })
  })

  it('按单页上限请求，而不是按内存里的条数', async () => {
    // 内存只有 2 条，旧实现只请求 2 条 → 展开后几乎空白
    getSessionTurnPageMock.mockResolvedValue({ messages: [assistantMsg('a1', 1100)], nextCursor: undefined, hasMore: false })

    const { result } = renderHook(() => useSessionManager({ sessionId: 'session-1', directory: '/w' }))
    // 清掉挂载时的首屏分页调用，只观察 hydrateTurn 自己发的那次
    getSessionTurnPageMock.mockClear()

    await act(async () => {
      await result.current.hydrateTurn(TURN_USER)
    })

    // 首屏分页用的是小 limit（3）；hydrateTurn 必须用单页上限 200。
    // 直接找 limit===200 的调用，避免受首屏请求顺序影响。
    const limits = getSessionTurnPageMock.mock.calls.map(c => c[1])
    expect(limits).toContain(200)
  })

  it('用消息 id 切分区间，不依赖毫秒级时间戳', async () => {
    // assistant 的 created 比 user 晚 1ms：旧的 >= turnStart 比较会命中，
    // 但一旦骨架时间与真实时间差更多就会把整轮剔光
    getSessionTurnPageMock.mockResolvedValue({
      messages: [assistantMsg('a1', 1001), assistantMsg('a2', 1002)],
      nextCursor: undefined,
      hasMore: false,
    })

    const { result } = renderHook(() => useSessionManager({ sessionId: 'session-1', directory: '/w' }))
    await act(async () => {
      await result.current.hydrateTurn(TURN_USER)
    })

    // 拿到了内容 → 交给 store（骨架轮走替换，普通轮走合并）
    const replaced = (messageStoreMock.replaceTurnMessages.mock.calls.at(-1) as unknown[] | undefined)?.[2] as
      | unknown[]
      | undefined
    const merged = (messageStoreMock.hydrateMessages.mock.calls.at(-1) as unknown[] | undefined)?.[1] as
      | unknown[]
      | undefined
    const applied = replaced ?? merged
    expect(applied).toHaveLength(2)
  })

  it('切分失败时兜底使用原始一页，而不是静默 return', async () => {
    // 锚点不在这一页（本轮 200+ 条、点的是更早的轮次），时间也对不上
    getSessionTurnPageMock.mockResolvedValue({
      messages: [assistantMsg('unrelated', 999999)],
      nextCursor: undefined,
      hasMore: false,
    })

    const { result } = renderHook(() => useSessionManager({ sessionId: 'session-1', directory: '/w' }))
    await act(async () => {
      await result.current.hydrateTurn(TURN_USER)
    })

    // 至少要把数据交给 store（合并），不能什么都不做
    const merged =
      messageStoreMock.hydrateMessages.mock.calls.length + messageStoreMock.replaceTurnMessages.mock.calls.length
    expect(merged).toBeGreaterThan(0)
  })
})

describe('骨架未定稿轮次补拉（正在进行的回复不能消失）', () => {
  /**
   * 回归：刷新后最新那条「正在进行的回复」整段空白。
   *
   * 骨架投影把未定稿轮次（settled: false）整轮剔除，它只能靠一次补拉拿回来。
   * 原实现里补拉失败被 catch 静默吞掉、锚点找不到时 tailMessages 为空 ——
   * 于是页面只剩历史轮次，正在进行的回复凭空消失。
   */
  const UNSETTLED = 'msg_unsettled_1'

  function skeletonPage(overrides: Partial<{ messages: unknown[]; nextCursor?: string }> = {}) {
    return {
      messages: [
        { info: { id: 'hist_user', role: 'user', time: { created: 100 } }, parts: [] },
        { info: { id: 'hist_reply', role: 'assistant', time: { created: 200, completed: 210 } }, parts: [] },
      ],
      nextCursor: 'c1',
      hasMore: true,
      config: {},
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    peekLightweightSupportMock.mockReturnValue(true)
    getSessionTurnPageMock.mockResolvedValue({ messages: [], nextCursor: undefined, hasMore: false })
  })

  it('补拉成功时，未定稿轮次的内容进入首屏', async () => {
    lightweightMessagesMock.mockResolvedValue({
      ...skeletonPage(),
      unsettledTurns: [UNSETTLED],
    })
    getSessionTurnPageMock.mockResolvedValue({
      messages: [
        { info: { id: UNSETTLED, role: 'user', time: { created: 300 } }, parts: [] },
        { info: { id: 'live_reply', role: 'assistant', time: { created: 310 } }, parts: [] },
      ],
      nextCursor: undefined,
      hasMore: false,
    })

    const { result } = renderHook(() => useSessionManager({ sessionId: 'session-1', directory: '/w' }))
    await act(async () => {
      await result.current.loadSession('session-1')
    })

    const applied = messageStoreMock.setMessages.mock.calls.at(-1)?.[1] as Array<{ info: { id: string } }>
    const ids = applied.map(m => m.info.id)
    expect(ids).toContain('live_reply')
  })

  it('锚点不在页里时退化为「从最后一条 user 开始」，而不是放弃', async () => {
    lightweightMessagesMock.mockResolvedValue({
      ...skeletonPage(),
      // Agent 给的 turn id 与消息 id 不同源
      unsettledTurns: ['agent-side-turn-id'],
    })
    getSessionTurnPageMock.mockResolvedValue({
      messages: [
        { info: { id: 'old_user', role: 'user', time: { created: 100 } }, parts: [] },
        { info: { id: 'old_reply', role: 'assistant', time: { created: 110 } }, parts: [] },
        { info: { id: 'real_live_user', role: 'user', time: { created: 300 } }, parts: [] },
        { info: { id: 'real_live_reply', role: 'assistant', time: { created: 310 } }, parts: [] },
      ],
      nextCursor: undefined,
      hasMore: false,
    })

    const { result } = renderHook(() => useSessionManager({ sessionId: 'session-1', directory: '/w' }))
    await act(async () => {
      await result.current.loadSession('session-1')
    })

    const applied = messageStoreMock.setMessages.mock.calls.at(-1)?.[1] as Array<{ info: { id: string } }>
    const ids = applied.map(m => m.info.id)
    // 从最后一条 user 起：正在进行的这一轮被拿回来了
    expect(ids).toContain('real_live_user')
    expect(ids).toContain('real_live_reply')
  })
})
