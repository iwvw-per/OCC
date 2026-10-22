import { describe, expect, it } from 'vitest'
import { computeSessionTurnStats, computeSessionTurnStatsCached, mergeIntervalMs, EMPTY_SESSION_TURN_STATS } from './sessionTurnStats'
import type { Message, Content, Part } from '../types/message'

function userMessage(created: number): Message {
  return {
    info: { role: 'user', time: { created } } as Message['info'],
    content: [],
  }
}

interface AssistantOptions {
  created: number
  completed?: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  textWindows?: { start: number; end: number }[]
  tools?: { start: number; end: number }[]
}

function assistantMessage(options: AssistantOptions): Message {
  const { created, completed, textWindows = [], tools = [] } = options
  const content: Content[] = []

  for (const window of textWindows) {
    content.push({ type: 'text', text: 'x', time: window } as Part)
  }
  for (const window of tools) {
    content.push({
      type: 'tool',
      callID: `call-${window.start}`,
      tool: 'bash',
      state: { status: 'completed', time: window },
    } as Part)
  }

  return {
    info: {
      role: 'assistant',
      time: completed === undefined ? { created } : { created, completed },
      tokens: {
        input: options.input ?? 0,
        output: options.output ?? 0,
        reasoning: options.reasoning ?? 0,
        cache: { read: options.cacheRead ?? 0, write: options.cacheWrite ?? 0 },
      },
      cost: 0,
    } as Message['info'],
    content,
  }
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

  it('does not depend on input order', () => {
    expect(
      mergeIntervalMs([
        { start: 3000, end: 4000 },
        { start: 0, end: 1000 },
      ]),
    ).toBe(2000)
  })
})

describe('computeSessionTurnStats', () => {
  it('returns the empty shape with hasData false for no messages', () => {
    const stats = computeSessionTurnStats([])
    expect(stats).toEqual(EMPTY_SESSION_TURN_STATS)
  })

  it('counts turns from user messages and steps from settled assistant messages', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({ created: 1000, completed: 2000, output: 100 }),
      userMessage(3000),
      assistantMessage({ created: 4000, completed: 5000, output: 100 }),
    ])
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(2)
    expect(stats.hasData).toBe(true)
  })

  it('excludes a streaming assistant message from steps and timing', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({ created: 1000 }), // no completed => still streaming
    ])
    expect(stats.steps).toBe(0)
    expect(stats.modelMs).toBe(0)
    expect(stats.tokensPerSec).toBeNull()
    expect(stats.hasData).toBe(true) // user turn still counts
  })

  it('counts skeleton turn steps from compressedStats instead of message count', () => {
    // 轮次骨架路径：一整轮的 124 次工具调用被聚合成**一条**助手消息。
    // 若按消息数计步，统计面板会显示「182 轮 · 0 步」。
    const skeletonAssistant: Message = {
      info: {
        role: 'assistant',
        time: { created: 1000, completed: 2000 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      } as Message['info'],
      content: [{ type: 'text', text: '改好了。', time: { start: 1100, end: 1900 } } as Part],
      isCompressed: true,
      compressedStats: { reasoningCount: 50, stepCount: 124 },
    }
    const stats = computeSessionTurnStats([userMessage(0), skeletonAssistant])
    expect(stats.turns).toBe(1)
    // 1（助手消息本身）+ 124（骨架带回的工具调用数）
    expect(stats.steps).toBe(125)
  })

  it('subtracts tool time from model time', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({
        created: 1000,
        completed: 11_000, // 10s total
        output: 500,
        tools: [
          { start: 2000, end: 5000 }, // 3s
          { start: 7000, end: 8000 }, // 1s
        ],
      }),
    ])
    expect(stats.toolMs).toBe(4000)
    expect(stats.modelMs).toBe(6000)
  })

  it('accumulates tool time even while the message is still streaming', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({
        created: 1000,
        tools: [{ start: 2000, end: 4500 }],
      }),
    ])
    expect(stats.toolMs).toBe(2500)
    expect(stats.modelMs).toBe(0)
  })

  it('never reports negative model time when tool time exceeds message time', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({
        created: 1000,
        completed: 2000, // 1s message
        tools: [{ start: 500, end: 5000 }], // 4.5s tool
      }),
    ])
    expect(stats.modelMs).toBe(0)
  })

  it('averages TTFT across settled messages that produced a part', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      // first part at 1500 => 500ms after created
      assistantMessage({ created: 1000, completed: 3000, textWindows: [{ start: 1500, end: 2900 }] }),
      // first part at 6100 => 1100ms after created
      assistantMessage({ created: 5000, completed: 7000, textWindows: [{ start: 6100, end: 6900 }] }),
    ])
    expect(stats.ttftMs).toBe(800)
  })

  it('leaves TTFT null when no message produced a timed part', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({ created: 1000, completed: 2000, output: 10 }),
    ])
    expect(stats.ttftMs).toBeNull()
  })

  it('uses the earliest part start when reasoning precedes text', () => {
    const message = assistantMessage({ created: 1000, completed: 5000 })
    message.content = [
      { type: 'reasoning', text: 'thinking', time: { start: 1200, end: 2000 } } as Part,
      { type: 'text', text: 'answer', time: { start: 2000, end: 4900 } } as Part,
    ]
    const stats = computeSessionTurnStats([userMessage(0), message])
    expect(stats.ttftMs).toBe(200)
  })

  it('computes tokens per second from merged text windows only', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({
        created: 1000,
        completed: 11_000,
        output: 200,
        // 1s + 1s of generation = 2s => 100 tok/s
        textWindows: [
          { start: 1000, end: 2000 },
          { start: 9000, end: 10_000 },
        ],
      }),
    ])
    expect(stats.tokensPerSec).toBe(100)
  })

  it('falls back to whole message duration when parts carry no timing', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({ created: 1000, completed: 3000, output: 100 }),
    ])
    expect(stats.tokensPerSec).toBe(50)
  })

  it('excludes reasoning tokens from the speed numerator', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({
        created: 1000,
        completed: 3000,
        output: 100,
        reasoning: 900,
        textWindows: [{ start: 1000, end: 2000 }],
      }),
    ])
    expect(stats.tokensPerSec).toBe(100)
    expect(stats.outputTokens).toBe(100)
  })

  it('aggregates token totals and computes cache hit percent', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({
        created: 1000,
        completed: 2000,
        input: 100,
        cacheRead: 800,
        cacheWrite: 100,
        output: 50,
      }),
    ])
    // denominator = 100 + 800 + 100 = 1000
    expect(stats.inputTokens).toBe(1000)
    expect(stats.cacheReadTokens).toBe(800)
    expect(stats.cacheHitPercent).toBe(80)
    expect(stats.outputTokens).toBe(50)
  })

  it('leaves cache hit percent null when there is no billed input', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({ created: 1000, completed: 2000, output: 10 }),
    ])
    expect(stats.cacheHitPercent).toBeNull()
  })

  it('treats a zero-length or reversed assistant window as unsettled', () => {
    const stats = computeSessionTurnStats([
      userMessage(0),
      assistantMessage({ created: 2000, completed: 2000, output: 10 }),
      assistantMessage({ created: 3000, completed: 2500, output: 10 }),
    ])
    expect(stats.steps).toBe(0)
    expect(stats.tokensPerSec).toBeNull()
  })
})

describe('computeSessionTurnStatsCached', () => {
  it('reuses the result for the same array reference', () => {
    const messages = [userMessage(0), assistantMessage({ created: 1000, completed: 2000, output: 10 })]
    const first = computeSessionTurnStatsCached(messages)
    const second = computeSessionTurnStatsCached(messages)
    expect(second).toBe(first)
  })

  it('recomputes when the array reference changes', () => {
    const first = computeSessionTurnStatsCached([userMessage(0)])
    const second = computeSessionTurnStatsCached([userMessage(0), userMessage(1)])
    expect(second).not.toBe(first)
    expect(second.turns).toBe(2)
  })
})
