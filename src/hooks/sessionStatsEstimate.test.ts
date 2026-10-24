/**
 * 上下文估算的三个真实缺陷（都用线上会话实测数据回归）：
 *
 *  1. 错误态工具结果的 `error` 不是字符串 → 整个估算变成 NaN
 *  2. v2 user 消息正文在 `info.text`，不在 content[] → 用户输入全被算成 0
 *  3. 工具输入按「顶层键个数 × 16」估算 → 实测低估 10.7 倍
 *
 * 另外统一了字符 → token 的折算：CJK 约 1 字 1 token，不能一律 /4。
 */
import { describe, expect, it } from 'vitest'
import { computeSessionStats, estimateTokensFromText } from './sessionStatsCompute'
import type { Message } from '../types/message'

const BASE = 1_700_000_000_000

function userMessage(id: string, text: string, at: number, withContent = false): Message {
  return {
    info: {
      id,
      role: 'user',
      time: { created: BASE + at },
      sessionID: 's',
      agent: 'build',
      model: { providerID: 'p', modelID: 'm' },
      text,
    },
    content: withContent
      ? [{ type: 'text', text, id: `${id}-p`, sessionID: 's', messageID: id }]
      : [],
  } as unknown as Message
}

function toolAssistant(id: string, at: number, state: Record<string, unknown>): Message {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 's',
      time: { created: BASE + at },
      parentID: 'u1',
      modelID: 'm',
      providerID: 'p',
      mode: 'chat',
      agent: 'default',
      path: { cwd: '/', root: '/' },
      cost: 0,
      // 没有 tokens：强制走估算路径
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    content: [{ type: 'tool', id: `${id}-t`, sessionID: 's', messageID: id, name: 'write', state }],
  } as unknown as Message
}

function plainAssistant(id: string, at: number, text: string): Message {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: 's',
      time: { created: BASE + at },
      parentID: 'u1',
      modelID: 'm',
      providerID: 'p',
      mode: 'chat',
      agent: 'default',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    content: [{ type: 'text', text, id: `${id}-p`, sessionID: 's', messageID: id }],
  } as unknown as Message
}

describe('estimateTokensFromText', () => {
  it('英文按 4 字符 1 token', () => {
    expect(estimateTokensFromText('a'.repeat(400))).toBe(100)
  })

  it('CJK 按 1 字 1 token，不再除以 4', () => {
    expect(estimateTokensFromText('中'.repeat(100))).toBe(100)
  })

  it('中英混排分别折算', () => {
    // 100 个中文 + 400 个英文 = 100 + 100
    expect(estimateTokensFromText('中'.repeat(100) + 'a'.repeat(400))).toBe(200)
  })

  it('空串为 0', () => {
    expect(estimateTokensFromText('')).toBe(0)
  })
})

describe('上下文估算的健壮性', () => {
  it('错误态工具结果缺 error 字段时不会变成 NaN', () => {
    const messages = [userMessage('u1', 'hi', 0), toolAssistant('a1', 1000, { status: 'error' })]

    const stats = computeSessionStats(messages, 200000)

    expect(Number.isNaN(stats.contextUsed)).toBe(false)
    expect(Number.isNaN(stats.contextPercent)).toBe(false)
    expect(stats.contextUsed).toBeGreaterThanOrEqual(0)
  })

  it('错误态 error 是对象时也不会崩', () => {
    const messages = [
      userMessage('u1', 'hi', 0),
      toolAssistant('a1', 1000, { status: 'error', error: { message: 'boom' } }),
    ]

    expect(() => computeSessionStats(messages, 200000)).not.toThrow()
    expect(Number.isNaN(computeSessionStats(messages, 200000).contextUsed)).toBe(false)
  })
})

describe('用户消息正文', () => {
  it('从 info.text 读取正文（v2 user 消息没有 content[]）', () => {
    const text = 'x'.repeat(4000)
    const messages = [userMessage('u1', text, 0), plainAssistant('a1', 1000, '')]

    const stats = computeSessionStats(messages, 200000)

    // 4000 字符 → 1000 token，全部来自 user 正文
    expect(stats.contextUsed).toBe(1000)
  })

  it('同时有 text 与 content 时不重复计正文', () => {
    const text = 'x'.repeat(4000)
    // content 里是同一段正文（v1 折叠路径），不应被算两遍
    const messages = [userMessage('u1', text, 0, true), plainAssistant('a1', 1000, '')]

    const stats = computeSessionStats(messages, 200000)

    expect(stats.contextUsed).toBe(1000)
  })

  it('中文正文按字计 token', () => {
    const messages = [userMessage('u1', '中'.repeat(500), 0), plainAssistant('a1', 1000, '')]

    expect(computeSessionStats(messages, 200000).contextUsed).toBe(500)
  })
})

describe('工具输入体积', () => {
  it('按实际 JSON 长度计，不再按键数 × 16', () => {
    const fileContent = 'a'.repeat(8000)
    // 单个键，旧算法只算 16 字符
    const messages = [
      userMessage('u1', '', 0),
      toolAssistant('a1', 1000, { status: 'completed', input: { content: fileContent }, output: '' }),
    ]

    const stats = computeSessionStats(messages, 200000)

    // JSON.stringify 后的长度约为 8000 + 结构开销 → /4 约 2000 token
    expect(stats.contextUsed).toBeGreaterThan(1900)
  })

  it('字符串形式的 input 按原长度计', () => {
    const messages = [
      userMessage('u1', '', 0),
      toolAssistant('a1', 1000, { status: 'completed', input: 'a'.repeat(4000), output: '' }),
    ]

    expect(computeSessionStats(messages, 200000).contextUsed).toBe(1000)
  })

  it('循环引用的 input 不会抛错', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    const messages = [userMessage('u1', '', 0), toolAssistant('a1', 1000, { status: 'completed', input: cyclic })]

    expect(() => computeSessionStats(messages, 200000)).not.toThrow()
    expect(Number.isNaN(computeSessionStats(messages, 200000).contextUsed)).toBe(false)
  })

  it('已压缩的工具输出用占位符长度，不按原文计', () => {
    const messages = [
      userMessage('u1', '', 0),
      toolAssistant('a1', 1000, {
        status: 'completed',
        input: {},
        output: 'a'.repeat(100_000),
        time: { compacted: BASE + 1000 },
      }),
    ]

    // 占位符 31 字符 → 远小于原文的 25000
    expect(computeSessionStats(messages, 200000).contextUsed).toBeLessThan(100)
  })
})
