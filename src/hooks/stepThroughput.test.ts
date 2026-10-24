import { describe, expect, it } from 'vitest'
import {
  aggregateThroughput,
  mergeIntervalMs,
  splitTurns,
  stepGenerationWindow,
  stepThroughput,
  turnThroughput,
} from './stepThroughput'
import type { Message } from '../types/message'

const BASE = 1_700_000_000_000

function makeMessage(options: {
  role?: 'user' | 'assistant'
  id?: string
  created?: number
  streamed?: number
  completed?: number
  output?: number
  reasoning?: number
  textWindows?: { start: number; end: number }[]
  toolWindows?: { start: number; end: number }[]
}): Message {
  const role = options.role ?? 'assistant'
  if (role === 'user') {
    return {
      info: { id: options.id ?? 'u1', role: 'user', time: { created: BASE + (options.created ?? 0) } },
      content: [],
    } as unknown as Message
  }
  const content: unknown[] = []
  for (const window of options.textWindows ?? []) {
    content.push({ id: `t-${window.start}`, type: 'text', text: 'x', time: window })
  }
  for (const window of options.toolWindows ?? []) {
    content.push({
      id: `c-${window.start}`,
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', time: window },
    })
  }
  return {
    info: {
      id: options.id ?? 'a1',
      role: 'assistant',
      time: {
        created: BASE + (options.created ?? 0),
        ...(options.streamed !== undefined ? { streamed: BASE + options.streamed } : {}),
        ...(options.completed !== undefined ? { completed: BASE + options.completed } : {}),
      },
      tokens: {
        input: 0,
        output: options.output ?? 0,
        reasoning: options.reasoning ?? 0,
        cache: { read: 0, write: 0 },
      },
    },
    content,
  } as unknown as Message
}

describe('mergeIntervalMs', () => {
  it('returns zero for no intervals', () => {
    expect(mergeIntervalMs([])).toBe(0)
  })

  it('sums disjoint intervals without the gaps', () => {
    expect(
      mergeIntervalMs([
        { start: 0, end: 1000 },
        { start: 3000, end: 4000 },
      ]),
    ).toBe(2000)
  })

  it('merges overlapping intervals instead of double counting', () => {
    expect(
      mergeIntervalMs([
        { start: 0, end: 1000 },
        { start: 500, end: 1500 },
      ]),
    ).toBe(1500)
  })
})

describe('stepGenerationWindow', () => {
  it('prefers streamed-created and marks it authoritative', () => {
    const result = stepGenerationWindow(makeMessage({ created: 0, streamed: 1500, completed: 9000 }))
    expect(result).toEqual({ durationMs: 1500, authoritative: true })
  })

  it('ignores completed-created when streamed is present', () => {
    // completed 比 streamed 晚 7.5s（工具收尾），不能算进生成时间
    const result = stepGenerationWindow(makeMessage({ created: 0, streamed: 500, completed: 8000 }))
    expect(result.durationMs).toBe(500)
  })

  it('falls back to text part windows when streamed is absent', () => {
    const result = stepGenerationWindow(
      makeMessage({
        created: 0,
        completed: 9000,
        textWindows: [
          { start: 0, end: 1000 },
          { start: 5000, end: 6000 },
        ],
      }),
    )
    expect(result).toEqual({ durationMs: 2000, authoritative: false })
  })

  it('falls back to completed-created when nothing else is available', () => {
    const result = stepGenerationWindow(makeMessage({ created: 1000, completed: 3000 }))
    expect(result).toEqual({ durationMs: 2000, authoritative: false })
  })

  it('ignores tool-only windows for the generation denominator', () => {
    const result = stepGenerationWindow(
      makeMessage({ created: 0, completed: 4000, toolWindows: [{ start: 0, end: 4000 }] }),
    )
    expect(result.durationMs).toBe(4000)
    expect(result.authoritative).toBe(false)
  })

  it('returns zero duration for an unsettled message', () => {
    expect(stepGenerationWindow(makeMessage({ created: 1000 })).durationMs).toBe(0)
  })
})

describe('stepThroughput', () => {
  it('counts output plus reasoning', () => {
    const result = stepThroughput(makeMessage({ created: 0, streamed: 1000, output: 100, reasoning: 50 }))
    expect(result?.tokens).toBe(150)
  })

  it('keeps a step with zero tokens (it still contributes duration)', () => {
    // 官方只按 streamed === undefined 过滤，token 为 0 的 step 仍参与：
    // 它贡献时长、不贡献 token。若因 token=0 丢弃，整轮速度会被虚高。
    expect(stepThroughput(makeMessage({ created: 0, streamed: 1000 }))).toEqual({
      durationMs: 1000,
      tokens: 0,
      authoritative: true,
    })
  })

  it('returns null when there is no generation window', () => {
    expect(stepThroughput(makeMessage({ created: 1000, output: 100 }))).toBeNull()
  })

  it('returns null for a user message', () => {
    expect(stepThroughput(makeMessage({ role: 'user' }))).toBeNull()
  })
})

describe('aggregateThroughput', () => {
  it('aggregates before dividing so长步按自身时长加权', () => {
    // 100tok/1s + 100tok/4s = 200/5s = 40（不是各步平均的 62.5）
    const rate = aggregateThroughput([
      { durationMs: 1000, tokens: 100, authoritative: true },
      { durationMs: 4000, tokens: 100, authoritative: true },
    ])
    expect(rate).toBe(40)
  })

  it('returns null for empty input', () => {
    expect(aggregateThroughput([])).toBeNull()
  })

  it('returns null when total tokens are zero', () => {
    expect(aggregateThroughput([{ durationMs: 1000, tokens: 0, authoritative: true }])).toBeNull()
  })
})

describe('turnThroughput', () => {
  it('aggregates every step in the turn, weighted by its own window', () => {
    // 100tok/1s + 300tok/3s = 400/4s = 100
    const messages = [
      makeMessage({ id: 'a1', created: 0, streamed: 1000, output: 100 }),
      makeMessage({ id: 'a2', created: 1000, streamed: 4000, output: 300 }),
    ]
    expect(turnThroughput(messages)).toBe(100)
  })

  it('returns null when any step has no generation window (still streaming)', () => {
    // 最后一步还在流式：没有 streamed/completed → 整轮不可用（显示上一轮的值）
    const messages = [
      makeMessage({ id: 'a1', created: 0, streamed: 1000, output: 100 }),
      makeMessage({ id: 'a2', created: 1000, output: 300 }),
    ]
    expect(turnThroughput(messages)).toBeNull()
  })

  it('ignores non-assistant messages', () => {
    const messages = [
      makeMessage({ role: 'user', id: 'u1', created: 0 }),
      makeMessage({ id: 'a1', created: 0, streamed: 1000, output: 100 }),
    ]
    expect(turnThroughput(messages)).toBe(100)
  })

  it('returns null for a turn without assistant steps', () => {
    expect(turnThroughput([makeMessage({ role: 'user', id: 'u1' })])).toBeNull()
  })

  it('returns 0 when every step produced no tokens', () => {
    const messages = [makeMessage({ id: 'a1', created: 0, streamed: 1000 })]
    expect(turnThroughput(messages)).toBe(0)
  })
})

describe('splitTurns', () => {
  it('starts a new turn at each user message', () => {
    const turns = splitTurns([
      makeMessage({ role: 'user', id: 'u1', created: 0 }),
      makeMessage({ id: 'a1', created: 1, streamed: 100, output: 10 }),
      makeMessage({ role: 'user', id: 'u2', created: 200 }),
      makeMessage({ id: 'a2', created: 201, streamed: 300, output: 10 }),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0].map(m => m.info.id)).toEqual(['a1'])
    expect(turns[1].map(m => m.info.id)).toEqual(['a2'])
  })

  it('ignores assistant messages that appear before any user message', () => {
    const turns = splitTurns([makeMessage({ id: 'orphan', created: 1 })])
    expect(turns).toHaveLength(0)
  })
})
