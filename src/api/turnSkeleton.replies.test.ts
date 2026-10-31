import { describe, expect, it } from 'vitest'
import { adaptTurnSkeleton } from './turnSkeleton'

/**
 * 骨架 `replies` 数组 → 多条合成消息。
 *
 * 服务端实测（2026-11-01，ARM 主机 ses_e6e0b3d23ffe7YEJI1DItkyUuv）：
 * 后台任务完成通知会让 agent 在 idle 之后继续跑，同一轮有两段执行、两个结论。
 * 后端已改为返回 `replies` 数组（`reply` 保留最后一条以兼容）。
 */
describe('骨架路径：多段执行（多个结论）', () => {
  it('replies 有多条时，每条各合成一条 assistant 消息', () => {
    const result = adaptTurnSkeleton([
      {
        type: 'turn',
        id: 'msg_turn_1',
        time: { created: 1000 },
        user: { text: '继续' },
        stats: { reasoningCount: 1, stepCount: 3 },
        durationMs: 60000,
        replies: [
          { text: 'CI 还在运行，需要约 13 分钟。', messageID: 'msg_r1', ordinal: 0 },
          { text: '全部完成，且都已核实。', messageID: 'msg_r2', ordinal: 0 },
        ],
        reply: { text: '全部完成，且都已核实。', messageID: 'msg_r2', ordinal: 0 },
      },
      { type: 'idle', outcome: 'succeeded', time: { created: 62000 } },
    ])

    const assistants = result.raw.filter(
      (e): e is Record<string, unknown> => (e as { type?: string }).type === 'assistant',
    )
    expect(assistants).toHaveLength(2)

    const texts = assistants.map(a => (a.content as Array<{ text: string }>)[0].text)
    expect(texts).toEqual(['CI 还在运行，需要约 13 分钟。', '全部完成，且都已核实。'])
    expect(assistants.map(a => a.id)).toEqual(['msg_r1', 'msg_r2'])

    // 时间递增，保证都排在过程消息之后且顺序稳定
    const t0 = (assistants[0].time as { created: number }).created
    const t1 = (assistants[1].time as { created: number }).created
    expect(t1).toBeGreaterThan(t0)
  })

  it('过程统计只挂在最后一条，避免折叠块计数翻倍', () => {
    const result = adaptTurnSkeleton([
      {
        type: 'turn',
        id: 'msg_turn_2',
        time: { created: 1000 },
        user: { text: '继续' },
        stats: { reasoningCount: 2, stepCount: 5 },
        durationMs: 30000,
        replies: [
          { text: '第一段。', messageID: 'msg_a', ordinal: 0 },
          { text: '第二段。', messageID: 'msg_b', ordinal: 0 },
        ],
      },
      { type: 'idle', outcome: 'succeeded', time: { created: 31000 } },
    ])

    const assistants = result.raw.filter(
      (e): e is Record<string, unknown> => (e as { type?: string }).type === 'assistant',
    )
    expect(assistants[0].lightweight).toBeUndefined()
    expect(assistants[1].lightweight).toEqual({
      reasoningCount: 2,
      stepCount: 5,
      durationMs: 30000,
    })
  })

  it('只有 reply（旧后端）时仍按单条处理', () => {
    const result = adaptTurnSkeleton([
      {
        type: 'turn',
        id: 'msg_turn_3',
        time: { created: 1000 },
        user: { text: '问一下' },
        stats: { reasoningCount: 0, stepCount: 1 },
        durationMs: 5000,
        reply: { text: '只有一个回答。', messageID: 'msg_single', ordinal: 0 },
      },
      { type: 'idle', outcome: 'succeeded', time: { created: 6000 } },
    ])

    const assistants = result.raw.filter(
      (e): e is Record<string, unknown> => (e as { type?: string }).type === 'assistant',
    )
    expect(assistants).toHaveLength(1)
    expect(assistants[0].id).toBe('msg_single')
    expect((assistants[0].content as Array<{ text: string }>)[0].text).toBe('只有一个回答。')
  })
})
