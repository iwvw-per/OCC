import { describe, expect, it } from 'vitest'
import { adaptTurnSkeleton } from './turnSkeleton'
import { buildProcessTimeline } from '../features/chat/chatPageModel'
import { messageHasFinalContent, messageHasProcessContent } from '../features/message/messageRenderLogic'
import type { Content, Message } from '../types/message'

/**
 * 端到端回归：**骨架响应 → 时间线**，验证「折叠块外的最终回答」与服务端
 * `replies` 完全一致。
 *
 * 核心缺陷（2026-11-01 实测 ARM 主机 ses_e754c2c25ffeR6bIwbgwgBmLQ6）：
 * 后端骨架正确返回 `replies: [90 字, 101 字]`，但 `adaptTurnSkeleton` 合成的
 * 消息**不带 `finish`**，前端因此以为「这一轮没有服务端结论」，只能按位置
 * 兜底 —— **多条 replies 时只显示最后一条**，前面的结论凭空消失。
 *
 * 现在合成的回复一律带 `finish: 'stop'`（中断轮的最后一条带 error）。
 */

const textLen = (m: Message) =>
  m.content.filter(x => x.type === 'text').reduce((a, x) => a + ((x as { text: string }).text || '').length, 0)

/** 骨架响应 → 时间线，返回「壳外正文长度」按轮的数组 */
function outsideByTurn(skeletonTurns: unknown[]): number[][] {
  const adapted = adaptTurnSkeleton(skeletonTurns)
  const messages: Message[] = []

  for (const entry of adapted.raw) {
    const e = entry as Record<string, unknown>
    const type = e.type as string
    const id = String(e.id ?? '')
    const sid = 's'
    if (type === 'user') {
      messages.push({
        info: { id, sessionID: sid, role: 'user', time: e.time } as never,
        content: [
          { id: `${id}-t`, sessionID: sid, messageID: id, type: 'text', text: (e.text as string) ?? '' } as Content,
        ],
        isStreaming: false,
      })
      continue
    }
    if (type !== 'assistant') continue
    const content: Content[] = ((e.content as Array<Record<string, unknown>>) ?? []).map(
      (p, i) =>
        ({
          id: `${id}-text-${i}`,
          sessionID: sid,
          messageID: id,
          type: 'text',
          text: (p.text as string) ?? '',
          synthetic: false,
        }) as Content,
    )
    const lw = e.lightweight as Record<string, unknown> | undefined
    messages.push({
      info: {
        id,
        sessionID: sid,
        role: 'assistant',
        time: e.time,
        finish: e.finish,
        ...(e.error ? { error: e.error } : {}),
      } as never,
      content,
      isStreaming: false,
      isCompressed: !!lw,
      compressedStats: lw
        ? { reasoningCount: Number(lw.reasoningCount ?? 0), stepCount: Number(lw.stepCount ?? 0) }
        : undefined,
    } as Message)
  }

  const timeline = buildProcessTimeline(messages, {
    turnDurationMap: new Map(),
    sessionIsStreaming: false,
    serverRunning: false,
    messageHasProcess: messageHasProcessContent,
    messageHasFinal: messageHasFinalContent,
  })

  const out: number[][] = []
  let current: number[] | null = null
  for (const item of timeline) {
    if (item.kind === 'message' && item.message.info.role === 'user') {
      current = []
      out.push(current)
      continue
    }
    if (!current) continue
    if (item.kind === 'process-shell') {
      console.log(
        'SHELL finals=',
        (item.finalMessages ?? []).map(f => `${f.info.id}:${textLen(f)}`),
        'children=',
        item.children.map(c => c.message.info.id),
      )
      // 壳外正文 = finalMessages
      for (const f of item.finalMessages ?? []) current.push(textLen(f))
      continue
    }
    // 平铺的 assistant（纯正文轮，不挂壳）也是壳外正文
    current.push(textLen(item.message))
  }
  return out
}

describe('骨架 → 时间线（端到端）', () => {
  it('单轮多条 replies：全部露在壳外', () => {
    const lengths = outsideByTurn([
      {
        type: 'turn',
        id: 'msg_turn_multi',
        time: { created: 1000 },
        user: { text: '继续' },
        stats: { reasoningCount: 0, stepCount: 12 },
        durationMs: 60000,
        replies: [
          { text: 'A'.repeat(90), messageID: 'msg_r1', ordinal: 0 },
          { text: 'B'.repeat(101), messageID: 'msg_r2', ordinal: 0 },
        ],
        reply: { text: 'B'.repeat(101), messageID: 'msg_r2', ordinal: 0 },
      },
      { type: 'idle', outcome: 'interrupted', time: { created: 61000 } },
    ])
    expect(lengths).toEqual([[90, 101]])
  })

  it('中断轮的多条 replies + 末尾 aborted：历史结论仍是 stop', () => {
    const lengths = outsideByTurn([
      {
        type: 'turn',
        id: 'msg_turn_interrupted',
        time: { created: 1000 },
        user: { text: '继续' },
        stats: { reasoningCount: 1, stepCount: 30 },
        durationMs: 90000,
        replies: [
          { text: 'C'.repeat(80), messageID: 'msg_a', ordinal: 0 },
          { text: 'D'.repeat(120), messageID: 'msg_b', ordinal: 0 },
        ],
      },
      { type: 'idle', outcome: 'interrupted', time: { created: 91000 } },
    ])
    expect(lengths).toEqual([[80, 120]])
  })

  it('纯过程轮（replies 为空）：壳外没有正文', () => {
    const lengths = outsideByTurn([
      {
        type: 'turn',
        id: 'msg_turn_tools',
        time: { created: 1000 },
        user: { text: '跑一下' },
        stats: { reasoningCount: 0, stepCount: 5 },
        durationMs: 20000,
        reply: null,
      },
      { type: 'idle', outcome: 'succeeded', time: { created: 21000 } },
    ])
    expect(lengths).toEqual([[]])
  })

  it('多轮互不干扰', () => {
    const lengths = outsideByTurn([
      {
        type: 'turn',
        id: 'msg_turn_1',
        time: { created: 1000 },
        user: { text: '第一轮' },
        stats: { reasoningCount: 0, stepCount: 2 },
        durationMs: 10000,
        replies: [
          { text: 'X'.repeat(50), messageID: 'msg_1a', ordinal: 0 },
          { text: 'Y'.repeat(60), messageID: 'msg_1b', ordinal: 0 },
        ],
      },
      { type: 'idle', outcome: 'succeeded', time: { created: 11000 } },
      {
        type: 'turn',
        id: 'msg_turn_2',
        time: { created: 20000 },
        user: { text: '第二轮' },
        stats: { reasoningCount: 0, stepCount: 1 },
        durationMs: 5000,
        replies: [{ text: 'Z'.repeat(70), messageID: 'msg_2a', ordinal: 0 }],
      },
      { type: 'idle', outcome: 'succeeded', time: { created: 26000 } },
    ])
    expect(lengths).toEqual([[50, 60], [70]])
  })
})
