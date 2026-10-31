import { describe, expect, it } from 'vitest'
import { adaptTurnSkeleton } from './turnSkeleton'
import { adaptMessagePage } from './v2/message'
import { toUIMessage } from '../utils/messageConversion'

/**
 * 回归（2026-10-31 实测，笔电主机 ses_e6da629a0ffeWtRJFlpikPE9df）：
 * 「流式拼接」与「轮次投影」两条路径混用后，**真正的回答被排到本轮过程消息之前**，
 * 渲染层按位置挑「最后一条带正文的消息」，于是选中过程里的最后一句说明，
 * 回答被折进折叠块 —— 页面上只剩一行过程文字，Ctrl+R 刷新后正常。
 *
 * 现场（中途打开会话时，同一轮的 store 顺序 vs 服务端顺序）：
 *
 *   store:  user → reply(compressed, created=user.created) → 过程1 → 过程2 …
 *   server: user → 过程1 → 过程2 → … → reply(created=最后一条的时间)
 *
 * 根因：投影合成「该轮回复」时，`time.created` 直接用了**轮次起点**（user 的
 * created），而流式消息各自带真实时间。两者混进同一个数组后按 created 排序，
 * 回复就跑到前面去了。投影里那个 created 只是给折叠块计时用的，不是消息时间。
 *
 * 服务端骨架原始响应（节选）：
 *   {"type":"turn","id":"msg_19259ed2a001…",
 *    "time":{"created":1793456729404},              ← 轮次起点 = user 的 created
 *    "reply":{"messageID":"msg_1925a2a5d001…","text":"…最终结论…"}}
 * 而该回复在服务端消息流里的真实 created 是 1793456745057（最后一条）。
 */

function turn(overrides: Record<string, unknown> = {}) {
  return {
    type: 'turn',
    id: 'u1',
    time: { created: 1000 },
    durationMs: 22305,
    user: { text: '跑 6 条命令' },
    reply: { messageID: 'a-last', ordinal: 0, text: '## 最终结论\n全部完成。' },
    stats: { reasoningCount: 1, stepCount: 6 },
    ...overrides,
  }
}

describe('轮次投影的时间字段不能污染消息排序', () => {
  it('投影合成消息的 created 应等于轮次结束（回拉时能排到最后），而不是轮次起点', () => {
    const { raw } = adaptTurnSkeleton([turn()])
    const reply = raw.find(item => (item as { type?: string }).type === 'assistant') as
      | { id: string; time: { created: number; completed: number } }
      | undefined
    expect(reply).toBeDefined()
    // 轮次起点 1000 + durationMs 22305 → 回复发生在这轮末尾
    expect(reply!.time.created).toBe(1000 + 22305)
  })

  it('没有 durationMs 时退化为「不早于轮次起点」，仍不能早于该轮任何过程消息', () => {
    const { raw } = adaptTurnSkeleton([turn({ durationMs: undefined })])
    const reply = raw.find(item => (item as { type?: string }).type === 'assistant') as
      | { time: { created: number } }
      | undefined
    expect(reply!.time.created).toBeGreaterThanOrEqual(1000)
  })

  it('混入流式消息后，按 created 排序仍把回答放在本轮最后', () => {
    const { raw } = adaptTurnSkeleton([turn()])
    const page = adaptMessagePage({ data: raw })
    const ui = page.messages.map(toUIMessage)

    // 该轮的过程消息（流式建立，带真实时间，均晚于轮次起点、早于轮次结束）
    const processMessages = [1100, 1200, 1300].map((created, index) => ({
      ...ui[0],
      info: {
        id: `proc-${index}`,
        sessionID: 's',
        role: 'assistant' as const,
        time: { created, completed: created + 50 },
        finish: 'tool-calls',
      },
      content: [
        {
          id: `proc-${index}-t`,
          sessionID: 's',
          messageID: `proc-${index}`,
          type: 'text' as const,
          text: `第 ${index + 1} 条命令执行完成。`,
          synthetic: false,
        },
      ],
    }))

    const merged = [...ui, ...processMessages].sort(
      (a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0),
    )
    expect(merged.at(-1)?.info.id).toBe('a-last')
  })
})
