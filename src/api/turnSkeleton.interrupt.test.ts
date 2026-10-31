import { describe, expect, it } from 'vitest'
import { adaptTurnSkeleton } from './turnSkeleton'

/**
 * 骨架路径必须保住「这一轮被中断」。
 *
 * 服务端实测（2026-11-01，笔电主机 ses_e6c932156ffeUnGS4vSwOmJYCs，用户在
 * agent 跑 `sleep 90` 时点停止）：
 *
 *   骨架响应：
 *     { type: 'turn', id: msg_x, reply: null, stats: { stepCount: 1 }, durationMs: 8199 }
 *     { type: 'idle', outcome: 'interrupted' }
 *
 *   真实消息形状：
 *     assistant { finish: 'error', error: { type: 'aborted' }, content: [reasoning, text, tool] }
 *     idle      { outcome: 'interrupted' }
 *
 * 骨架把这一轮压成 `reply: null`，中断事实只存在于**它后面的 idle**。
 * 不还原出来，刷新后「本轮已被中断」就消失（实测：实时视图有、刷新后没有）。
 */
describe('骨架路径：中断轮次', () => {
  it('把 idle.outcome=interrupted 还原成 assistant 的 aborted 错误', () => {
    const result = adaptTurnSkeleton([
      {
        type: 'turn',
        id: 'msg_turn_1',
        time: { created: 1000 },
        user: { text: '跑一个长命令' },
        reply: null,
        stats: { reasoningCount: 1, stepCount: 1 },
        durationMs: 8199,
      },
      { type: 'idle', outcome: 'interrupted', time: { created: 9200 } },
    ])

    const assistant = result.raw.find(
      entry => (entry as { type?: string }).type === 'assistant',
    ) as { finish?: string; error?: { type?: string }; content?: unknown[] } | undefined
    expect(assistant).toBeDefined()
    expect(assistant?.finish).toBe('error')
    expect(assistant?.error?.type).toBe('aborted')
  })

  it('正常结束的轮次不带 error/finish', () => {
    const result = adaptTurnSkeleton([
      {
        type: 'turn',
        id: 'msg_turn_2',
        time: { created: 1000 },
        user: { text: '问个问题' },
        reply: { text: '这是回答。', messageID: 'msg_reply_2', ordinal: 0 },
        stats: { reasoningCount: 0, stepCount: 2 },
        durationMs: 3000,
      },
      { type: 'idle', outcome: 'succeeded', time: { created: 4000 } },
    ])

    const assistant = result.raw.find(
      entry => (entry as { type?: string }).type === 'assistant',
    ) as { finish?: string; error?: unknown } | undefined
    expect(assistant).toBeDefined()
    expect(assistant?.finish).toBeUndefined()
    expect(assistant?.error).toBeUndefined()
  })

  it('outcome 只作用于它前面那一轮（多轮不串味）', () => {
    const result = adaptTurnSkeleton([
      {
        type: 'turn',
        id: 'msg_turn_a',
        time: { created: 1000 },
        user: { text: '第一轮' },
        reply: null,
        stats: { reasoningCount: 0, stepCount: 1 },
      },
      { type: 'idle', outcome: 'interrupted', time: { created: 2000 } },
      {
        type: 'turn',
        id: 'msg_turn_b',
        time: { created: 3000 },
        user: { text: '第二轮' },
        reply: { text: '第二轮的回答。', messageID: 'msg_reply_b', ordinal: 0 },
        stats: { reasoningCount: 0, stepCount: 1 },
      },
      { type: 'idle', outcome: 'succeeded', time: { created: 4000 } },
    ])

    const assistants = result.raw.filter(
      entry => (entry as { type?: string }).type === 'assistant',
    ) as Array<{ id: string; finish?: string }>
    expect(assistants).toHaveLength(2)
    // 第一轮被中断
    expect(assistants[0].finish).toBe('error')
    // 第二轮正常
    expect(assistants[1].finish).toBeUndefined()
  })
})
