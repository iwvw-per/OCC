import { describe, expect, it } from 'vitest'
import { buildProcessTimeline } from './chatPageModel'
import { messageHasFinalContent, messageHasProcessContent } from '../message/messageRenderLogic'
import type { Content, Message, TextContent, ToolContent } from '../../types/message'

/**
 * 多工具长回合里，最终回答的定位。
 *
 * ⚠️ 2026-11-01 语义修正（依据三台主机 391 轮真实数据统计，见下）。
 *
 * 旧用例断言「轮内六条 assistant 全部 finish=tool-calls、末条只有工具，
 * 回答在倒数第一条」。实测**这个形状在成功轮次里不存在**：
 *
 *   主机（60 个会话 / 95 轮）       succeeded 77 轮 → 末条 finish 全是 stop
 *   arm（40 个会话 / 120 轮）       succeeded 86 轮 → 末条 finish 全是 stop
 *   工作机（40 个会话 / 176 轮）    succeeded 48 轮 → 末条 finish 全是 stop
 *
 *   合计 211 个 succeeded 轮次，末条 finish = stop 的占比 100%；
 *   `finish=stop` 出现在非末条位置的次数 = 0。
 *
 * 也就是说，服务端的真实语义是：
 *   - 成功轮：中间若干条 finish=tool-calls（各带一句过程说明），**最后一条
 *     finish=stop 承载完整回答**；
 *   - 中断/失败轮：末条 finish=error（带 `error.type = aborted`），整轮
 *     **没有回答**，中间那些正文都是过程说明。
 *
 * 所以判据是「轮内有 finish 就只信 finish」，位置兜底只留给**完全没有
 * finish** 的数据（轮次骨架路径合成的回复消息不带 finish，见 turnSkeleton.ts）。
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
    content: [text(id, `${id}:t`, '连续执行 5 条 shell，最后输出总结')],
    isStreaming: false,
  } as unknown as Message
}

function timelineOf(messages: Message[]) {
  return buildProcessTimeline(messages, {
    turnDurationMap: new Map(),
    sessionIsStreaming: false,
    serverRunning: false,
    messageHasProcess: messageHasProcessContent,
    messageHasFinal: messageHasFinalContent,
  })
}

describe('多工具长回合的最终回答定位（真实形状）', () => {
  /** 服务端 succeeded 的真实形状：中间 tool-calls 各带说明，末条 stop 带回答 */
  const succeededTurn: Message[] = [
    userMessage('u1'),
    assistant('m1', [text('m1', 'm1-t', '第一步'), tool('m1', 'c1')], 'tool-calls'),
    assistant('m2', [text('m2', 'm2-t', '第二步'), tool('m2', 'c2')], 'tool-calls'),
    assistant('m3', [text('m3', 'm3-t', '第三步'), tool('m3', 'c3')], 'tool-calls'),
    assistant('m4', [text('m4', 'm4-t', '第四步'), tool('m4', 'c4')], 'tool-calls'),
    assistant('m5', [text('m5', 'm5-t', '全部完成，这是最终回答。')], 'stop'),
  ]

  it('最终回答 = finish=stop 那条的正文，挂在折叠块外', () => {
    const timeline = timelineOf(succeededTurn)
    const shell = timeline.find(item => item.kind === 'process-shell')
    expect(shell).toBeDefined()
    if (shell?.kind !== 'process-shell') return
    // 折叠块外必须挂出最终回答，否则收起后整轮正文消失
    expect(shell.finalMessage?.info.id).toBe('m5')
    /**
     * 纯正文的最终回答**不进壳**：壳内只放过程项，塞进去只会多一层边框
     * （见 chatPageModel 的 `if (messageHasProcess(m))` 分支）。
     * 因此壳内子消息只有 m1..m4。
     */
    const finalChildren = shell.children.filter(child => child.message.info.id === 'm5')
    expect(finalChildren).toHaveLength(0)
  })

  it('过程块仍承载全过程，顺序不变', () => {
    const timeline = timelineOf(succeededTurn)
    const shell = timeline.find(item => item.kind === 'process-shell')
    if (shell?.kind !== 'process-shell') throw new Error('expected process shell')
    expect(shell.children.map(child => `${child.message.info.id}:${child.processContentScope}`)).toEqual([
      'm1:inline',
      'm2:inline',
      'm3:inline',
      'm4:inline',
    ])
  })

  it('最终回答那条自身也带过程时，以 final 作用域进壳（只画正文）', () => {
    /**
     * 真实形状之一：`[reasoning, text(回答), tool]` —— 回答那条以工具收尾。
     * 这条消息必须拆成两半：过程进壳、正文放壳外，否则收起后回答消失。
     */
    const turn: Message[] = [
      userMessage('u1'),
      assistant('m1', [text('m1', 'm1-t', '第一步'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [text('m2', 'm2-t', '这是回答。'), tool('m2', 'c2')], 'stop'),
    ]
    const timeline = timelineOf(turn)
    const shell = timeline.find(item => item.kind === 'process-shell')
    if (shell?.kind !== 'process-shell') throw new Error('expected process shell')
    expect(shell.finalMessage?.info.id).toBe('m2')
    expect(shell.children.map(child => `${child.message.info.id}:${child.processContentScope}`)).toEqual([
      'm1:inline',
      'm2:final',
    ])
  })

  it('末条只有工具、轮内无 stop（真实=被中断）：中间说明不露到壳外', () => {
    /**
     * 实测形状（主机 ses_e7ff2377bffelpifNufQcCkERY 等 13 个中断轮）：
     *   全部 assistant finish=tool-calls，末条是纯工具，idle outcome=interrupted
     * 中间那些「我换一种写法」「找到根因了」都是过程说明，不是回答。
     */
    const interrupted: Message[] = [
      userMessage('u1'),
      assistant('m1', [text('m1', 'm1-t', '我换一种写法。'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [tool('m2', 'c2')], 'tool-calls'),
    ]
    const timeline = timelineOf(interrupted)
    const shell = timeline.find(item => item.kind === 'process-shell')
    expect(shell).toBeDefined()
    if (shell?.kind !== 'process-shell') return
    // 没有 finish=stop → 这一轮没有回答，正文全部留在壳内
    expect(shell.finalMessage).toBeUndefined()
    expect(shell.children.map(c => `${c.message.info.id}:${c.processContentScope}`)).toEqual([
      'm1:inline',
      'm2:inline',
    ])
  })

  it('骨架轮（合成回复不带 finish）：按位置兜底，回答仍露在壳外', () => {
    /**
     * 轮次骨架是历史快照的主路径，它合成的回复消息**没有 finish**
     * （实测骨架响应 reply = { text, messageID, ordinal }）。
     * 若严格只认 stop，刷新后所有历史轮次的回答都会消失。
     */
    const skeletonTurn: Message[] = [
      userMessage('u1'),
      assistant('m1', [text('m1', 'm1-t', '这是骨架带回的最终回复。')]),
    ]
    const timeline = timelineOf(skeletonTurn)
    const shell = timeline.find(item => item.kind === 'process-shell')
    // 纯正文、无过程 → 直接平铺也正确；有壳时回答必须在壳外
    if (shell?.kind === 'process-shell') {
      expect(shell.finalMessage?.info.id).toBe('m1')
      return
    }
    expect(timeline.some(item => item.kind === 'message' && item.message.info.id === 'm1')).toBe(true)
  })

  it('finish=length（被截断的回答）也算回答', () => {
    const truncated: Message[] = [
      userMessage('u1'),
      assistant('m1', [text('m1', 'm1-t', '被截断的回答…'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [text('m2', 'm2-t', '这是一段被输出长度截断的回答')], 'length'),
    ]
    const timeline = timelineOf(truncated)
    const shell = timeline.find(item => item.kind === 'process-shell')
    if (shell?.kind !== 'process-shell') throw new Error('expected process shell')
    expect(shell.finalMessage?.info.id).toBe('m2')
  })
})
