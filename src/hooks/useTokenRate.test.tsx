import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTokenRate } from './useTokenRate'
import { messageStore } from '../store'
import type { Message } from '../types/message'

// 只打桩数据来源，速率计算本身用真实实现
vi.mock('../store', () => ({
  messageStore: {
    getVisibleMessages: vi.fn(() => []),
    subscribeSession: vi.fn(() => () => {}),
  },
}))

const getVisibleMessagesMock = vi.mocked(messageStore.getVisibleMessages)
const subscribeSessionMock = vi.mocked(messageStore.subscribeSession)

// 真实时间戳是毫秒级 epoch；避免 0 被当成「缺失」的歧义
const BASE = 1_700_000_000_000

interface PartSpec {
  type: 'text' | 'reasoning' | 'tool'
  start?: number
  end?: number
}

/**
 * 构造一条 assistant 消息。
 *
 * 口径对齐官方 turnTokensPerSecond：
 *   速度 = Σ(output + reasoning) / Σ(streamed − created)
 */
function makeAssistantMessage(options: {
  id?: string
  createdOffset: number
  /** 流式结束时刻；不填则退回 completed / part 窗口 */
  streamedOffset?: number
  completedOffset?: number
  output: number
  reasoning?: number
  parts?: PartSpec[]
}): Message {
  return {
    info: {
      id: options.id ?? 'msg-1',
      role: 'assistant',
      time: {
        created: BASE + options.createdOffset,
        ...(options.streamedOffset !== undefined ? { streamed: BASE + options.streamedOffset } : {}),
        ...(options.completedOffset !== undefined ? { completed: BASE + options.completedOffset } : {}),
      },
      tokens: {
        input: 10,
        output: options.output,
        reasoning: options.reasoning ?? 0,
        cache: { read: 0, write: 0 },
      },
    },
    content: (options.parts ?? []).map((part, index) => ({
      id: `part-${index}`,
      sessionID: 'session-1',
      messageID: options.id ?? 'msg-1',
      type: part.type,
      text: 'x',
      time:
        part.start !== undefined && part.end !== undefined
          ? { start: BASE + part.start, end: BASE + part.end }
          : undefined,
    })),
  } as unknown as Message
}

function makeUserMessage(createdOffset: number): Message {
  return {
    info: { id: `u-${createdOffset}`, role: 'user', time: { created: BASE + createdOffset }, text: 'hi' },
    content: [],
  } as unknown as Message
}

/** 只有 created、没有 streamed/completed 的流式中消息 */
function makeStreamingMessage(): Message {
  return {
    info: {
      id: 'msg-2',
      role: 'assistant',
      time: { created: BASE + 2000 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    content: [],
  } as unknown as Message
}

describe('useTokenRate', () => {
  beforeEach(() => {
    getVisibleMessagesMock.mockReset()
    subscribeSessionMock.mockReset()
    subscribeSessionMock.mockImplementation(() => () => {})
    getVisibleMessagesMock.mockReturnValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns zero when there is no session', () => {
    const { result } = renderHook(() => useTokenRate(null))
    expect(result.current).toEqual({ tokensPerSec: 0, hasData: false })
  })

  it('uses streamed-created as the denominator (official口径)', () => {
    // streamed−created = 1000ms → 100 / 1s = 100 tok/s。
    // 若错用 completed−created（2000ms）会得到 50。
    getVisibleMessagesMock.mockReturnValue([
      makeUserMessage(0),
      makeAssistantMessage({ createdOffset: 0, streamedOffset: 1000, completedOffset: 2000, output: 100 }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(100)
    expect(result.current.hasData).toBe(true)
  })

  it('counts reasoning tokens in the numerator (official口径)', () => {
    // 官方用 output+reasoning：(100+900) / 1s = 1000
    getVisibleMessagesMock.mockReturnValue([
      makeUserMessage(0),
      makeAssistantMessage({
        createdOffset: 0,
        streamedOffset: 1000,
        completedOffset: 2000,
        output: 100,
        reasoning: 900,
      }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(1000)
  })

  it('falls back to completed when streamed is absent', () => {
    getVisibleMessagesMock.mockReturnValue([
      makeUserMessage(0),
      makeAssistantMessage({ createdOffset: 0, completedOffset: 2000, output: 100 }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    // 兜底口径：2000ms，output+reasoning = 100 → 50 tok/s
    expect(result.current.tokensPerSec).toBe(50)
  })

  it('aggregates every step in the turn, weighted by its own window', () => {
    // 一轮两步：1s/100tok + 3s/300tok → 400 / 4s = 100 tok/s
    // 只看最后一步会得到 300/3s = 100（碰巧相同），所以再验证 token 总量口径
    // 关键差别在「前面几步的 token 不再被丢弃」。
    getVisibleMessagesMock.mockReturnValue([
      makeUserMessage(0),
      makeAssistantMessage({ id: 'msg-step1', createdOffset: 0, streamedOffset: 1000, output: 100 }),
      makeAssistantMessage({ id: 'msg-step2', createdOffset: 1000, streamedOffset: 4000, output: 300 }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(100)
  })

  it('weights long steps more than short ones', () => {
    // 100tok/1s + 100tok/4s → 200 / 5s = 40 tok/s
    // 若各步平均会得到 (100+25)/2 = 62.5，说明必须按时间加权累加
    getVisibleMessagesMock.mockReturnValue([
      makeUserMessage(0),
      makeAssistantMessage({ id: 's1', createdOffset: 0, streamedOffset: 1000, output: 100 }),
      makeAssistantMessage({ id: 's2', createdOffset: 1000, streamedOffset: 5000, output: 100 }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(40)
  })

  it('skips the streaming message and uses the previous settled turn', () => {
    getVisibleMessagesMock.mockReturnValue([
      makeUserMessage(0),
      makeAssistantMessage({ createdOffset: 0, streamedOffset: 1000, output: 100 }),
      // 新一轮：用户发问 + 尚在流式的回复
      makeUserMessage(2000),
      makeStreamingMessage(),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(100)
  })

  it('reports no data when the only turn is still streaming', () => {
    getVisibleMessagesMock.mockReturnValue([makeUserMessage(0), makeStreamingMessage()])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current).toEqual({ tokensPerSec: 0, hasData: false })
  })

  it('reports no data when only user messages exist', () => {
    getVisibleMessagesMock.mockReturnValue([makeUserMessage(0)])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current).toEqual({ tokensPerSec: 0, hasData: false })
  })
})
