import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionManager } from './useSessionManager'

/**
 * 回归（2026-10-31 实测，arm 主机 ses_e6dc660c7ffe6Xn7Xdra1K0YpH）：
 * 「对话跑到一半才打开页面 → 轮次结束 → 正文残缺，刷新才完整」。
 *
 * 实测时间线（笔电主机、网页客户端、Live 模式）：
 *   +21s 打开，Working for 21s，正文 220 字（中途快照）
 *   +63s 服务端仍 running；正文停在 344 字（「最后执行第六条命令：」）
 *   +65s 服务端 idle → 界面 Worked，但正文只剩 29 字
 *   +125s 仍是 29 字；刷新后 563 字（服务端完整 739 字）
 *
 * 根因：`shouldKeepStreamingOnly` 判定「本地条数 ≥ 分页条数」后直接 `return`，
 * 连 `lastTurn` / 分页游标 / 模型这些会话级元数据都不写。而
 * `settleByAuthoritativeIdle` 的唯一输入就是 `lastTurn`：缺它，本地这条
 * 未定稿 assistant 永远等不到定稿 → 一直显示「处理中」；也就永远走不到
 * `isLastTurnComplete` 的服务端对账，正文只能停在半截。
 */

const {
  getSessionMock,
  getSessionFirstScreenMock,
  getSessionTurnPageMock,
  lightweightMessagesMock,
  messageStoreMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionFirstScreenMock: vi.fn(),
  getSessionTurnPageMock: vi.fn(),
  lightweightMessagesMock: vi.fn(),
  messageStoreMock: {
    getSessionState: vi.fn(),
    setLoadState: vi.fn(),
    setLoadError: vi.fn(),
    setMessages: vi.fn(),
    updateSessionMetadata: vi.fn(),
    prependMessages: vi.fn(),
    setRevertState: vi.fn(),
    compressHistoricalTurns: vi.fn(() => false),
    hydrateMessages: vi.fn(() => true),
    replaceTurnMessages: vi.fn(() => true),
    setTurnSkeleton: vi.fn(),
    getTrimmedCount: vi.fn(() => 0),
    settleByAuthoritativeIdle: vi.fn(() => true),
    getSessionChangeVersion: vi.fn(() => 0),
    subscribe: vi.fn(() => () => {}),
    subscribeSession: vi.fn(() => () => {}),
    onSessionEvicted: vi.fn(() => () => {}),
    protectSession: vi.fn(),
    unprotectSession: vi.fn(),
    getAllSessionKeys: vi.fn(() => []),
    getSessionUsage: vi.fn(() => undefined),
    getCompactionMarker: vi.fn(() => undefined),
    markSessionStale: vi.fn(),
  },
}))

vi.mock('../api/message', () => ({
  getSessionFirstScreen: getSessionFirstScreenMock,
  getSessionTurnPage: getSessionTurnPageMock,
  getSessionMessages: vi.fn(async () => []),
  getSessionMessagePage: vi.fn(async () => ({ messages: [], nextCursor: undefined })),
  getSessionLightweightMessages: lightweightMessagesMock,
  peekLightweightSupport: () => false,
  probeLightweightSupport: vi.fn(async () => false),
  getSessionContext: vi.fn(async () => null),
}))

vi.mock('../api/session', () => ({
  getSession: getSessionMock,
  getSessionStatus: vi.fn(async () => ({})),
  updateSession: vi.fn(),
}))

vi.mock('../store/messageStore', () => ({ messageStore: messageStoreMock }))

vi.mock('../store/index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../store')>()
  return { ...actual, messageStore: messageStoreMock }
})

beforeEach(() => {
  vi.clearAllMocks()
  getSessionMock.mockResolvedValue({ id: 'ses_test', directory: '/tmp', title: 't' })
})

describe('轮次结束时的服务端对账（中途打开会话）', () => {
  it('本地条数不少于分页条数时，会话级元数据（lastTurn）仍必须落地', async () => {
    // 本地从 SSE 拼出来的这一轮：条数比分页返回的还多
    messageStoreMock.getSessionState.mockReturnValue({
      loadState: 'loaded',
      isStale: false,
      isStreaming: true,
      messages: [{}, {}, {}],
      lastTurn: undefined,
    })
    // 真实路径：会话已在流式中且已加载过 → 命中「只刷元数据」的早退分支，
    // 它取的是 getSessionTurnPage 那一页（skeleton 可用时根本不会走分页首屏）。
    getSessionTurnPageMock.mockResolvedValue({
      messages: [{}, {}],
      hasMore: false,
      // 服务端这一轮已经结束 —— 这正是定稿所需的权威信号
      idle: { at: 10, outcome: 'succeeded' },
    })

    const onLoadComplete = vi.fn()
    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'local::ses_test', directory: '/tmp', onLoadComplete } as never),
    )

    await result.current.loadSession('local::ses_test')

    await waitFor(() => {
      expect(messageStoreMock.updateSessionMetadata).toHaveBeenCalled()
    })
    const metadata = messageStoreMock.updateSessionMetadata.mock.calls.at(-1)?.[1] ?? {}
    // 缺这条，settleByAuthoritativeIdle 没有任何输入，界面永久停在「处理中」
    expect(metadata.lastTurn).toEqual({ at: 10, outcome: 'succeeded' })
  })

  it('拿到权威 idle 后要真正去定稿本地这条未完成消息', async () => {
    messageStoreMock.getSessionState.mockReturnValue({
      loadState: 'loaded',
      isStale: false,
      isStreaming: true,
      messages: [{}, {}, {}],
      lastTurn: undefined,
    })
    getSessionFirstScreenMock.mockResolvedValue({
      messages: [{}, {}],
      hasMore: false,
      complete: true,
      idle: { at: 10, outcome: 'succeeded' },
    })

    const { result } = renderHook(() =>
      useSessionManager({ sessionId: 'local::ses_test', directory: '/tmp', onLoadComplete: vi.fn() } as never),
    )
    await result.current.loadSession('local::ses_test')

    await waitFor(() => {
      expect(messageStoreMock.settleByAuthoritativeIdle).toHaveBeenCalledWith('local::ses_test')
    })
  })
})
