import { describe, expect, it } from 'vitest'
import { adaptTurnSkeleton, isTurnSkeleton } from './turnSkeleton'
import { adaptMessagePage } from './v2/message'

/** 造一条骨架轮次（主机 Agent 的输出形状） */
function turn(overrides: Record<string, unknown> = {}) {
  return {
    type: 'turn',
    id: 'msg_user_1',
    time: { created: 1000 },
    user: { text: '改一下这个 bug' },
    reply: { text: '改好了。', messageID: 'msg_reply_1' },
    stats: { reasoningCount: 2, stepCount: 3 },
    ...overrides,
  }
}

describe('isTurnSkeleton', () => {
  it('识别骨架响应', () => {
    expect(isTurnSkeleton([turn()])).toBe(true)
  })

  it('把普通 v2 消息响应判为非骨架', () => {
    expect(isTurnSkeleton([{ type: 'assistant', id: 'a1', content: [] }])).toBe(false)
    expect(isTurnSkeleton([])).toBe(false)
  })
})

describe('adaptTurnSkeleton', () => {
  it('每轮还原成 user + assistant 两条消息', () => {
    const { raw, turns } = adaptTurnSkeleton([turn()])

    expect(raw).toHaveLength(2)
    expect(raw[0]).toMatchObject({ type: 'user', id: 'msg_user_1', text: '改一下这个 bug' })
    expect(raw[1]).toMatchObject({
      type: 'assistant',
      id: 'msg_reply_1',
      content: [{ type: 'text', text: '改好了。' }],
      lightweight: { reasoningCount: 2, stepCount: 3 },
    })
    expect(turns.get('msg_user_1')).toMatchObject({ reasoningCount: 2, stepCount: 3 })
  })

  it('回复正文为空时不造空助手消息（纯工具轮由折叠块表达）', () => {
    const { raw } = adaptTurnSkeleton([
      turn({ reply: null, stats: { reasoningCount: 0, stepCount: 4 } }),
    ])

    // user + 带过程计数的 assistant（content 为空，但折叠块 header 要显示 4 步）
    expect(raw).toHaveLength(2)
    expect(raw[1]).toMatchObject({ type: 'assistant', content: [], lightweight: { stepCount: 4 } })
  })

  it('既无回复也无过程时不产出助手消息', () => {
    const { raw } = adaptTurnSkeleton([turn({ reply: null, stats: { reasoningCount: 0, stepCount: 0 } })])
    expect(raw).toHaveLength(1)
    expect(raw[0]).toMatchObject({ type: 'user' })
  })

  it('用户附件只带元信息，正文显式置空', () => {
    const { raw } = adaptTurnSkeleton([
      turn({
        user: {
          text: '看图',
          files: [{ mime: 'image/png', name: 'a.png', sizeBytes: 2048 }],
        },
      }),
    ])

    const user = raw[0] as { files: Array<{ data: string; mime: string; name: string }> }
    expect(user.files).toHaveLength(1)
    expect(user.files[0].data).toBe('')
    expect(user.files[0].mime).toBe('image/png')
    expect(user.files[0].name).toBe('a.png')
  })

  it('系统标记原样透传（idle / compaction 等由适配层提取）', () => {
    const { raw } = adaptTurnSkeleton([
      turn(),
      { type: 'idle', id: 'idle_1', outcome: 'succeeded', time: { created: 2000 } },
      { type: 'compaction', id: 'cmp_1', status: 'completed', time: { created: 1500 } },
    ])

    expect(raw.map(item => (item as { type: string }).type)).toEqual([
      'user',
      'assistant',
      'idle',
      'compaction',
    ])
  })

  it('改动文件清单挂在助手消息的 lightweight 上，供 DiffChips 渲染', () => {
    const { raw } = adaptTurnSkeleton([
      turn({ changedFiles: [{ path: 'src/a.cs', additions: 3, deletions: 1 }] }),
    ])

    expect(raw[1]).toMatchObject({
      lightweight: { changedFiles: [{ path: 'src/a.cs', additions: 3, deletions: 1 }] },
    })
  })

  it('整段骨架经 adaptMessagePage 后：助手消息标记为压缩态、idle 变成轮次结论', () => {
    const { raw } = adaptTurnSkeleton([
      turn(),
      { type: 'idle', id: 'idle_1', outcome: 'interrupted', time: { created: 2000 } },
    ])

    const page = adaptMessagePage({ data: raw, cursor: {} })

    expect(page.messages).toHaveLength(2)
    const assistant = page.messages[1]
    expect(assistant.info.role).toBe('assistant')
    expect(page.idle).toMatchObject({ at: 2000, outcome: 'interrupted' })
  })

  it('透传骨架回填的 durationMs 与 changedFiles', () => {
    // 骨架路径：过程被剥掉后，轮次时长与改动文件只能由 lightweight 带回。
    // 少了 durationMs，折叠块 header 会显示「已处理 0ms」。
    const page = adaptMessagePage({
      data: [
        {
          type: 'assistant',
          id: 'a1',
          content: [{ type: 'text', text: 'ok' }],
          lightweight: {
            reasoningCount: 21,
            stepCount: 54,
            durationMs: 1_752_473,
            changedFiles: [{ path: 'src/a.cs', additions: 3, deletions: 1 }],
          },
        },
      ],
      cursor: {},
    })

    const message = page.messages[0] as unknown as {
      lightweight: { durationMs: number; changedFiles: unknown[] }
    }
    expect(message.lightweight.durationMs).toBe(1_752_473)
    expect(message.lightweight.changedFiles).toEqual([{ path: 'src/a.cs', additions: 3, deletions: 1 }])
  })

  it('只有计数时 lightweight 仍按最小形态返回', () => {
    const page = adaptMessagePage({
      data: [
        {
          type: 'assistant',
          id: 'a1',
          content: [],
          lightweight: { reasoningCount: 2, stepCount: 3 },
        },
      ],
      cursor: {},
    })
    const message = page.messages[0] as unknown as { lightweight: Record<string, unknown> }
    expect(message.lightweight).toEqual({ reasoningCount: 2, stepCount: 3 })
  })

  it('把未定稿的轮次排除在骨架之外，交给调用方补拉', () => {
    /**
     * 骨架给的是「此刻的截断快照」，而实时 delta 是 ephemeral（不重放、不带 seq），
     * 前端无法判断重叠。所以正在生成的轮次必须整轮剔除，由调用方式用完整消息补拉。
     */
    const { raw, unsettled, turns } = adaptTurnSkeleton([
      turn({ id: 'msg_u1' }),
      turn({ id: 'msg_u2', settled: false, reply: { text: '写了一半', messageID: 'msg_a2' } }),
    ])

    expect(unsettled).toEqual(['msg_u2'])
    // 只剩第一轮的 user + assistant
    expect(raw).toHaveLength(2)
    expect((raw[0] as { id: string }).id).toBe('msg_u1')
    // 未定稿轮次不应出现在 turns 统计里
    expect(turns.has('msg_u1')).toBe(true)
    expect(turns.has('msg_u2')).toBe(false)
  })

  it('按 reply.ordinal 补齐占位段，保证 partID 与实时 delta 对齐', () => {
    /**
     * 前端 partID 是 `${messageID}-text-${ordinal}`，delta 也用它定位。
     * 若最终回复真实序号是 2，骨架必须把 content 序号顶到 2，
     * 否则 delta 会追加到第 0 段上（错位）。
     */
    const { raw } = adaptTurnSkeleton([
      turn({ reply: { text: '最终回复', messageID: 'msg_a1', ordinal: 2 } }),
    ])

    const assistant = raw[1] as { content: Array<{ type: string; text: string }> }
    expect(assistant.content).toHaveLength(3)
    expect(assistant.content[0]).toEqual({ type: 'text', text: '' })
    expect(assistant.content[1]).toEqual({ type: 'text', text: '' })
    expect(assistant.content[2]).toEqual({ type: 'text', text: '最终回复' })

    // 经 adaptMessagePage 后，真正的文本 part id 应该是 -text-2
    const page = adaptMessagePage({ data: raw, cursor: {} })
    const partIds = page.messages[1].parts.map(p => p.id)
    expect(partIds).toContain('msg_a1-text-2')
  })

  it('compaction 标记只靠字符数也能算出压缩规模', () => {
    const { raw } = adaptTurnSkeleton([
      turn(),
      {
        type: 'compaction',
        id: 'cmp_1',
        status: 'completed',
        time: { created: 1500 },
        summary: '',
        summaryChars: 1200,
        recent: '',
        recentChars: 340,
      },
    ])

    const page = adaptMessagePage({ data: raw, cursor: {} })
    expect(page.compaction).toMatchObject({ at: 1500, summaryChars: 1200, recentChars: 340 })
  })
})
