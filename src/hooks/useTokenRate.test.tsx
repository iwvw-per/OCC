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

// 真实时间戳是毫秒级 epoch；hook 用 !created 判断字段是否存在，0 会被当成缺失
const BASE = 1_700_000_000_000

interface PartSpec {
  type: 'text' | 'reasoning' | 'tool'
  start?: number
  end?: number
}

/** 只填 hook 实际读取的字段，其余用断言补齐（与 messageStore.test.ts 的写法一致） */
function makeAssistantMessage(options: {
  createdOffset: number
  completedOffset: number
  output: number
  reasoning: number
  parts: PartSpec[]
}): Message {
  return {
    info: {
      id: 'msg-1',
      role: 'assistant',
      time: { created: BASE + options.createdOffset, completed: BASE + options.completedOffset },
      tokens: { input: 10, output: options.output, reasoning: options.reasoning, cache: { read: 0, write: 0 } },
    },
    content: options.parts.map((part, index) => ({
      id: `part-${index}`,
      sessionID: 'session-1',
      messageID: 'msg-1',
      type: part.type,
      text: 'x',
      time:
        part.start !== undefined && part.end !== undefined
          ? { start: BASE + part.start, end: BASE + part.end }
          : undefined,
    })),
  } as unknown as Message
}

/** 只有 created、没有 completed 的流式中消息 */
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

  it('counts only output tokens, excluding reasoning', () => {
    // 文本生成窗口 1000ms；output=100、reasoning=900
    // 只算输出应为 100 tok/s；若把 reasoning 也算进去会是 1000 tok/s
    getVisibleMessagesMock.mockReturnValue([
      makeAssistantMessage({
        createdOffset: 0,
        completedOffset: 2000,
        output: 100,
        reasoning: 900,
        parts: [{ type: 'text', start: 0, end: 1000 }],
      }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(100)
    expect(result.current.hasData).toBe(true)
  })

  it('excludes reasoning parts from the generation window', () => {
    // 文本 0-500ms，推理 500-2000ms；output=50
    // 只按文本窗口算 = 50 / 0.5s = 100 tok/s
    getVisibleMessagesMock.mockReturnValue([
      makeAssistantMessage({
        createdOffset: 0,
        completedOffset: 2000,
        output: 50,
        reasoning: 500,
        parts: [
          { type: 'text', start: 0, end: 500 },
          { type: 'reasoning', start: 500, end: 2000 },
        ],
      }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(100)
  })

  it('excludes tool-call gaps by merging text windows', () => {
    // 两段文本 0-1000 与 3000-4000，中间是工具调用等待
    // 合并后 2000ms，output=200 → 100 tok/s（按整条 4000ms 会算成 50）
    getVisibleMessagesMock.mockReturnValue([
      makeAssistantMessage({
        createdOffset: 0,
        completedOffset: 4000,
        output: 200,
        reasoning: 0,
        parts: [
          { type: 'text', start: 0, end: 1000 },
          { type: 'tool', start: 1000, end: 3000 },
          { type: 'text', start: 3000, end: 4000 },
        ],
      }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(100)
  })

  it('merges overlapping text windows instead of double counting', () => {
    // 重叠窗口 0-1000 与 500-1500 → 合并为 1500ms，output=150 → 100 tok/s
    getVisibleMessagesMock.mockReturnValue([
      makeAssistantMessage({
        createdOffset: 0,
        completedOffset: 1500,
        output: 150,
        reasoning: 0,
        parts: [
          { type: 'text', start: 0, end: 1000 },
          { type: 'text', start: 500, end: 1500 },
        ],
      }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(100)
  })

  it('falls back to whole-message duration when parts have no time window', () => {
    getVisibleMessagesMock.mockReturnValue([
      makeAssistantMessage({
        createdOffset: 0,
        completedOffset: 2000,
        output: 100,
        reasoning: 500,
        parts: [{ type: 'text' }],
      }),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    // 2000ms 窗口，仍只用 output：100 / 2s = 50 tok/s
    expect(result.current.tokensPerSec).toBe(50)
  })

  it('skips the streaming message and uses the last completed one', () => {
    getVisibleMessagesMock.mockReturnValue([
      makeAssistantMessage({
        createdOffset: 0,
        completedOffset: 1000,
        output: 100,
        reasoning: 0,
        parts: [{ type: 'text', start: 0, end: 1000 }],
      }),
      makeStreamingMessage(),
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current.tokensPerSec).toBe(100)
  })

  it('reports no data when only user messages exist', () => {
    getVisibleMessagesMock.mockReturnValue([
      {
        info: { id: 'u1', role: 'user', time: { created: BASE } },
        parts: [],
      } as unknown as Message,
    ])

    const { result } = renderHook(() => useTokenRate('session-1'))

    expect(result.current).toEqual({ tokensPerSec: 0, hasData: false })
  })
})
