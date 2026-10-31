import { describe, expect, it } from 'vitest'
import { buildProcessTimeline } from './chatPageModel'
import { messageHasFinalContent, messageHasProcessContent } from '../message/messageRenderLogic'
import type { Content, Message, TextContent, ToolContent } from '../../types/message'

/**
 * 后台任务完成通知会把「一轮」拆成两段执行，前端把两段并进同一个 user 轮，
 * 于是同一轮出现**两个 finish=stop**。
 *
 * 服务端实测（2026-11-01，ARM 主机 ses_e6e0b3d23ffe7YEJI1DItkyUuv，消息下标 154~186）：
 *
 *   154  user      继续
 *   …    26 条 finish=tool-calls（各带一句过程说明）
 *   179  assistant finish=stop  text(806)   "CI 还在运行，Release 需要约 13 分钟…"
 *   180  idle      outcome=succeeded          ← 这一轮结束了
 *   181  synthetic <shell id="sh_19397e3f..." state="completed">  ← 后台任务完成通知
 *   182  assistant finish=tool-calls  tool(shell)
 *   183  assistant finish=tool-calls  text(28) tool(shell)
 *   184  assistant finish=tool-calls  tool(shell)
 *   185  assistant finish=stop  text(1164)   "全部完成，且都已核实。v2.0.55 已发布…"
 *   186  idle      outcome=succeeded          ← 第二次执行也结束了
 *
 * 前端只在遇到下一条 user 时才切轮（chatPageModel 的 TurnBag 累积），
 * 所以 182~185 被并进 154 那一轮，整轮出现两个 stop。
 *
 * 期望：
 *   - 每个 stop 都是它那一段执行的**结论**，都必须在折叠块外可见；
 *   - 中间那些 tool-calls 的说明留在折叠块内（展开可见，收起不可见）；
 *   - 展开/收起折叠块**不改变**页面上最终回答的数量与内容。
 */

function text(messageID: string, id: string, value: string): TextContent {
  return { id, sessionID: 's', messageID, type: 'text', text: value, synthetic: false } as TextContent
}

function tool(messageID: string, id: string): ToolContent {
  return {
    id,
    sessionID: 's',
    messageID,
    type: 'tool',
    callID: id,
    tool: 'shell',
    state: { status: 'completed', input: {}, output: 'ok' },
  } as unknown as ToolContent
}

function assistant(id: string, content: Content[], finish?: string): Message {
  return {
    info: { id, sessionID: 's', role: 'assistant', time: { created: 1, completed: 2 }, finish },
    content,
    isStreaming: false,
  } as unknown as Message
}

function userMessage(id: string): Message {
  return {
    info: { id, sessionID: 's', role: 'user', time: { created: 1 } },
    content: [text(id, `${id}:t`, '继续')],
    isStreaming: false,
  } as unknown as Message
}

const base = {
  turnDurationMap: new Map(),
  sessionIsStreaming: false,
  serverRunning: false,
  messageHasProcess: messageHasProcessContent,
  messageHasFinal: messageHasFinalContent,
}

/** 折叠块外的可见正文 = 壳外最终回答，收集它们的文本 */
function outsideTexts(timeline: ReturnType<typeof buildProcessTimeline>): string[] {
  const out: string[] = []
  const textOf = (m: Message) =>
    m.content
      .filter((c): c is TextContent => c.type === 'text')
      .map(c => c.text)
      .join('')
  for (const item of timeline) {
    if (item.kind === 'message' && item.message.info.role === 'assistant') {
      out.push(textOf(item.message))
    }
    if (item.kind === 'process-shell') {
      const finals = item.finalMessages ?? (item.finalMessage ? [item.finalMessage] : [])
      for (const f of finals) out.push(textOf(f))
    }
  }
  return out.filter(t => t.trim())
}

describe('后台任务完成通知把一轮拆成两段执行（同一轮两个 stop）', () => {
  const messages: Message[] = [
    userMessage('u1'),
    assistant('m1', [text('m1', 'm1-t', '先确认版本号需要同步的文件。'), tool('m1', 'c1')], 'tool-calls'),
    assistant('m2', [text('m2', 'm2-t', '已推送。Release workflow 由 tag 触发。'), tool('m2', 'c2')], 'tool-calls'),
    // 第一段执行的结论
    assistant('m3', [text('m3', 'm3-t', 'CI 还在运行，Release 需要约 13 分钟。')], 'stop'),
    // 后台任务完成通知唤醒 agent，继续第二段
    assistant('m4', [tool('m4', 'c4')], 'tool-calls'),
    assistant('m5', [text('m5', 'm5-t', 'Release 已成功完成。'), tool('m5', 'c5')], 'tool-calls'),
    // 第二段执行的结论
    assistant('m6', [text('m6', 'm6-t', '全部完成，且都已核实。')], 'stop'),
  ]

  it('两个 stop 的正文都必须露在折叠块外', () => {
    const timeline = buildProcessTimeline(messages, base)
    const outside = outsideTexts(timeline)

    expect(outside).toContain('CI 还在运行，Release 需要约 13 分钟。')
    expect(outside).toContain('全部完成，且都已核实。')
  })

  it('中间的过程说明不露到壳外', () => {
    const timeline = buildProcessTimeline(messages, base)
    const outside = outsideTexts(timeline)

    expect(outside).not.toContain('先确认版本号需要同步的文件。')
    expect(outside).not.toContain('已推送。Release workflow 由 tag 触发。')
    expect(outside).not.toContain('Release 已成功完成。')
  })

  it('壳外正文数量稳定（不随折叠状态变化）', () => {
    const timeline = buildProcessTimeline(messages, base)
    const outside = outsideTexts(timeline)
    // 恰好两段结论
    expect(outside).toHaveLength(2)
  })
})
