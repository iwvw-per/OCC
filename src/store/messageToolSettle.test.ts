import { describe, expect, it } from 'vitest'
import {
  isUnsettledToolPart,
  reconcileInFlightTools,
  settleToolByCallID,
  finalizeStreamingMessages,
  computeTrimCount,
  estimateMessageBytes,
} from './messageToolSettle'
import type { Message, ToolPart, ToolContent } from '../types/message'

const toolPart = (
  callID: string,
  status: 'pending' | 'running' | 'completed' | 'error' | 'interrupted',
  extra: Partial<ToolPart['state']> = {},
): ToolPart => ({
  id: `prt_${callID}`,
  sessionID: 's1',
  messageID: 'm1',
  type: 'tool',
  callID,
  tool: 'bash',
  state: { status, input: {}, ...extra },
})

const assistantMessage = (content: ToolContent[], isStreaming = false): Message =>
  ({
    info: {
      id: 'm1',
      sessionID: 's1',
      role: 'assistant',
      time: { created: 1 },
      agent: 'build',
      modelID: 'x',
      providerID: 'p',
      mode: 'chat',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    content,
    isStreaming,
  }) as unknown as Message

describe('isUnsettledToolPart', () => {
  it('is true only for running/pending tool parts', () => {
    expect(isUnsettledToolPart(toolPart('c', 'running'))).toBe(true)
    expect(isUnsettledToolPart(toolPart('c', 'pending'))).toBe(true)
    expect(isUnsettledToolPart(toolPart('c', 'completed'))).toBe(false)
    expect(isUnsettledToolPart(toolPart('c', 'error'))).toBe(false)
    expect(isUnsettledToolPart(toolPart('c', 'interrupted'))).toBe(false)
  })
})

describe('reconcileInFlightTools', () => {
  it('settles running/pending tools to interrupted', () => {
    const messages = [assistantMessage([toolPart('c1', 'running'), toolPart('c2', 'pending')])]
    const { messages: next, changed } = reconcileInFlightTools(messages, 1000)

    expect(changed).toBe(true)
    const [p1, p2] = next[0].content as ToolPart[]
    expect(p1.state.status).toBe('interrupted')
    expect(p1.state.metadata?.interrupted).toBe(true)
    expect(p1.state.time?.end).toBe(1000)
    expect(p2.state.status).toBe('interrupted')
  })

  it('leaves already-settled parts untouched and reports no change', () => {
    const settled = toolPart('c1', 'completed')
    const messages = [assistantMessage([settled])]
    const { messages: next, changed } = reconcileInFlightTools(messages, 1000)

    expect(changed).toBe(false)
    expect(next).toBe(messages)
    expect(next[0].content[0]).toBe(settled)
  })

  it('preserves an existing start time', () => {
    const messages = [assistantMessage([toolPart('c1', 'running', { time: { start: 500 } })])]
    const { messages: next } = reconcileInFlightTools(messages, 1000)
    expect((next[0].content[0] as ToolPart).state.time?.start).toBe(500)
  })
})

describe('settleToolByCallID', () => {
  it('marks the matching tool completed with output', () => {
    const messages = [assistantMessage([toolPart('c1', 'running'), toolPart('c2', 'running')])]
    const { messages: next, changed } = settleToolByCallID(
      messages,
      'c1',
      { status: 'completed', output: 'done', errorFallback: 'fb' },
      2000,
    )

    expect(changed).toBe(true)
    const [p1, p2] = next[0].content as ToolPart[]
    expect(p1.state.status).toBe('completed')
    expect(p1.state.output).toBe('done')
    // 未匹配的 callID 不受影响
    expect(p2.state.status).toBe('running')
  })

  it('marks the matching tool error with the provided error', () => {
    const messages = [assistantMessage([toolPart('c1', 'running')])]
    const { messages: next } = settleToolByCallID(
      messages,
      'c1',
      { status: 'error', error: 'boom', errorFallback: 'fb' },
      2000,
    )
    const part = next[0].content[0] as ToolPart
    expect(part.state.status).toBe('error')
    expect(part.state.error).toBe('boom')
  })

  it('falls back to the injected error text when none provided', () => {
    const messages = [assistantMessage([toolPart('c1', 'running')])]
    const { messages: next } = settleToolByCallID(
      messages,
      'c1',
      { status: 'error', errorFallback: 'fallback text' },
      2000,
    )
    expect((next[0].content[0] as ToolPart).state.error).toBe('fallback text')
  })

  it('reports no change when the callID is not found or already settled', () => {
    const messages = [assistantMessage([toolPart('c1', 'completed')])]
    expect(settleToolByCallID(messages, 'c1', { status: 'completed', errorFallback: 'fb' }, 1).changed).toBe(false)
    expect(settleToolByCallID(messages, 'nope', { status: 'completed', errorFallback: 'fb' }, 1).changed).toBe(false)
  })
})

describe('finalizeStreamingMessages', () => {
  it('clears streaming and stamps completion time', () => {
    const messages = [assistantMessage([], true)]
    const { messages: next, changed } = finalizeStreamingMessages(messages, 3000)

    expect(changed).toBe(true)
    expect(next[0].isStreaming).toBe(false)
    expect(next[0].info.time.completed).toBe(3000)
  })

  it('does not overwrite an existing completion time', () => {
    const messages = [assistantMessage([], true)]
    messages[0].info.time.completed = 111
    const { messages: next } = finalizeStreamingMessages(messages, 3000)
    expect(next[0].info.time.completed).toBe(111)
  })

  it('reports no change when nothing is streaming', () => {
    const messages = [assistantMessage([], false)]
    const { messages: next, changed } = finalizeStreamingMessages(messages, 3000)
    expect(changed).toBe(false)
    expect(next).toBe(messages)
  })
})

describe('estimateMessageBytes / computeTrimCount', () => {
  const bigMessage = (pad: number): Message => {
    const parts = Array.from({ length: pad }, (_, i) => toolPart(`c${i}`, 'completed', { output: 'x'.repeat(500) }))
    return assistantMessage(parts)
  }

  it('charges a message by its serialized size', () => {
    const m = assistantMessage([toolPart('c1', 'completed')])
    expect(estimateMessageBytes(m)).toBeGreaterThan(0)
  })

  it('caps a single message at the per-message budget', () => {
    const huge = bigMessage(50_000)
    expect(estimateMessageBytes(huge)).toBe(2 * 1024 * 1024)
  })

  it('returns 0 when nothing exceeds the budget', () => {
    const messages = [assistantMessage([toolPart('c1', 'completed')])]
    expect(computeTrimCount(messages, 12 * 1024 * 1024, 20_000)).toBe(0)
  })

  it('trims oldest messages when the count budget is exceeded', () => {
    const messages = Array.from({ length: 10 }, () => assistantMessage([toolPart('c', 'completed')]))
    // 只允许 3 条：至少裁到 3 条
    expect(computeTrimCount(messages, Number.MAX_SAFE_INTEGER, 3)).toBe(7)
  })

  it('trims by byte budget from the oldest end', () => {
    const messages = [
      bigMessage(10),
      bigMessage(10),
      bigMessage(10),
      assistantMessage([toolPart('c', 'completed')]),
    ]
    const perMessage = estimateMessageBytes(messages[0])
    // 预算只够容纳最新两条
    const cut = computeTrimCount(messages, perMessage * 2 + 1, 20_000)
    expect(cut).toBe(2)
  })

  it('returns 0 for an empty list', () => {
    expect(computeTrimCount([], 1024, 10)).toBe(0)
  })
})
