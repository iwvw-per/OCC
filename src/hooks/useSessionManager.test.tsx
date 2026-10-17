import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionManager } from './useSessionManager'
import { HISTORY_TURN_BATCH_SIZE } from '../constants'

const {
  getSessionMock,
  getSessionTurnPageMock,
  messageStoreMock,
  sessionErrorHandlerMock,
  revertMessageMock,
  extractUserMessageContentMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionTurnPageMock: vi.fn(),
  messageStoreMock: {
    getSessionState: vi.fn(),
    setLoadState: vi.fn(),
    setLoadError: vi.fn(),
    setMessages: vi.fn(),
    updateSessionMetadata: vi.fn(),
    prependMessages: vi.fn(),
    setRevertState: vi.fn(),
    compressHistoricalTurns: vi.fn(() => false),
    hydrateMessages: vi.fn(() => false),
    getTrimmedCount: vi.fn(() => 0),
  },
  sessionErrorHandlerMock: vi.fn(),
  revertMessageMock: vi.fn(),
  extractUserMessageContentMock: vi.fn((_message: unknown) => ({ text: 'hello', attachments: [] })),
}))

vi.mock('../api', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  getSessionTurnPage: (...args: unknown[]) => getSessionTurnPageMock(...args),
  getSessionMessagePage: (...args: unknown[]) => getSessionTurnPageMock(...args),
  getSessionLightweightMessages: vi.fn(),
  probeLightweightSupport: vi.fn(async () => false),
  revertMessage: (...args: unknown[]) => revertMessageMock(...args),
  unrevertSession: vi.fn(),
  encodeBeforeCursor: (message: unknown) => `cursor:${(message as { info?: { id?: string } }).info?.id ?? ''}`,
  extractUserMessageContent: (message: unknown) => extractUserMessageContentMock(message),
}))

vi.mock('../store', () => ({
  messageStore: messageStoreMock,
}))

vi.mock('../utils', () => ({
  sessionErrorHandler: (...args: unknown[]) => sessionErrorHandlerMock(...args),
}))

describe('useSessionManager', () => {
  beforeEach(() => {
    getSessionMock.mockReset()
    getSessionTurnPageMock.mockReset()
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

      // 1 次初始 + 3 次重试
      expect(getSessionTurnPageMock).toHaveBeenCalledTimes(4)
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
