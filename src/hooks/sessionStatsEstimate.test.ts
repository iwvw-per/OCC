/**
 * 上下文占用的新语义：**只认服务端实测值**。
 *
 * 这里原来测的是「按字符估算」的三个缺陷修复（错误态 error 非字符串导致 NaN、
 * v2 user 正文在 info.text、工具输入按 JSON 长度计）。那些缺陷之所以要修，
 * 是因为估算值会直接显示成圆环百分比。
 *
 * 现在估算整体不再参与上下文占用：
 *   - 有服务端 tokens（消息 / context 快照 / 压缩事件）→ 用它
 *   - 没有 → contextUsed 为 null，界面显示「—」
 *
 * 保留的验证点是：无论消息内容多畸形，都不能抛错、不能出现 NaN。
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
      // 没有 tokens：模拟「服务端还没给实测值」
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    content: [{ type: 'tool', id: `${id}-t`, sessionID: 's', messageID: id, name: 'write', state }],
  } as unknown as Message
}

function plainAssistant(id: string, at: number, text: string, tokens?: Record<string, unknown>): Message {
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
      tokens: tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    content: [{ type: 'text', text, id: `${id}-p`, sessionID: 's', messageID: id }],
  } as unknown as Message
}

describe('estimateTokensFromText（独立工具函数）', () => {
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

describe('畸形消息不会污染上下文数字', () => {
  it('错误态工具结果缺 error 字段时不会变成 NaN', () => {
    const messages = [userMessage('u1', 'hi', 0), toolAssistant('a1', 1000, { status: 'error' })]

    const stats = computeSessionStats(messages, 200000)

    // 没有实测值 → 未知，而不是 NaN 或 0
    expect(stats.contextUsed).toBeNull()
    expect(stats.contextPercent).toBeNull()
  })

  it('错误态 error 是对象时也不会崩', () => {
    const messages = [
      userMessage('u1', 'hi', 0),
      toolAssistant('a1', 1000, { status: 'error', error: { message: 'boom' } }),
    ]

    expect(() => computeSessionStats(messages, 200000)).not.toThrow()
    expect(computeSessionStats(messages, 200000).contextUsed).toBeNull()
  })

  it('循环引用的工具输入不会抛错', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    const messages = [userMessage('u1', '', 0), toolAssistant('a1', 1000, { status: 'completed', input: cyclic })]

    expect(() => computeSessionStats(messages, 200000)).not.toThrow()
    expect(computeSessionStats(messages, 200000).contextUsed).toBeNull()
  })
})

describe('上下文占用只取服务端实测值', () => {
  it('ignores message text entirely when no assistant carries tokens', () => {
    /**
     * 回归（语义变更）：此前这里会按字符估算出 1000/500 之类的数字。
     * 图片与附件完全不计入估算，导致系统性偏低 —— 现在一律返回未知。
     */
    const bigUserText = 'x'.repeat(4000)
    const stats = computeSessionStats(
      [userMessage('u1', bigUserText, 0, true), plainAssistant('a1', 1000, '')],
      200000,
    )

    expect(stats.contextUsed).toBeNull()
    expect(stats.contextPercent).toBeNull()
  })

  it('uses the measured tokens of the last assistant that has them', () => {
    const stats = computeSessionStats(
      [
        userMessage('u1', '问题', 0),
        plainAssistant('a1', 1000, 'answer', {
          input: 3000,
          output: 200,
          reasoning: 100,
          cache: { read: 500, write: 0 },
        }),
      ],
      200000,
    )

    // input + output + reasoning + cache.read + cache.write
    expect(stats.contextUsed).toBe(3800)
    expect(stats.contextPercent).toBeCloseTo(1.9, 1)
  })

  it('does not count huge tool output — it is not part of the measured value', () => {
    // 工具大输出会影响真实上下文，但前端不再自行折算；没有实测值就是未知
    const stats = computeSessionStats(
      [
        userMessage('u1', '', 0),
        toolAssistant('a1', 1000, {
          status: 'completed',
          input: {},
          output: 'a'.repeat(100_000),
        }),
      ],
      200000,
    )

    expect(stats.contextUsed).toBeNull()
  })
})
