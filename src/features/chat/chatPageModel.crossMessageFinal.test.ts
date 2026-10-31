import { describe, expect, it } from 'vitest'
import { buildProcessTimeline } from './chatPageModel'
import { messageHasFinalContent, messageHasProcessContent } from '../message/messageRenderLogic'
import type { Content, Message, TextContent, ToolContent } from '../../types/message'

/**
 * 回归（2026-10-31 实测，arm 主机 ses_e6dcd22dbffe67R75bZIbrBWHI）：
 * 多工具长回合里，**最终回答被整轮折进默认收起的过程块**，页面上只剩
 * 「已处理 1m 34s」+ 最后一句过程说明；整页刷新（走骨架/历史快照）才完整。
 *
 * 服务端真实形状（六条 assistant，全部 finish=tool-calls）：
 *   m1  text(第一条说明) + tool(shell)
 *   m2  text(第二条说明) + tool(shell)
 *   …
 *   m5  text(第五条说明) + tool(shell)
 *   m6  tool(shell)                      ← 末条**没有正文**，整轮回答在 m5 里
 *
 * 旧实现把最终回答定位在**末条**消息上（`messageHasFinal(末条)` 为 false），
 * 于是一整轮正文全部进过程块；折叠块在轮次结束后默认收起 → 回答消失，
 * 用户只能刷新（骨架把「提问 + 回复」重新投影成两段）才看得到。
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

function assistant(id: string, content: Content[], finish = 'tool-calls'): Message {
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

describe('多工具长回合的最终回答定位', () => {
  const messages: Message[] = [
    userMessage('u1'),
    assistant('m1', [text('m1', 'm1-t', '第一步'), tool('m1', 'c1')]),
    assistant('m2', [text('m2', 'm2-t', '第二步'), tool('m2', 'c2')]),
    assistant('m3', [text('m3', 'm3-t', '第三步'), tool('m3', 'c3')]),
    assistant('m4', [text('m4', 'm4-t', '第四条已输出 a4，最后执行第五条命令。'), tool('m4', 'c4')]),
    // 末条只有工具：整轮真正的回答在 m4 里
    assistant('m5', [tool('m5', 'c5')]),
  ]

  const timeline = buildProcessTimeline(messages, {
    turnDurationMap: new Map(),
    sessionIsStreaming: false,
    serverRunning: false,
    messageHasProcess: messageHasProcessContent,
    messageHasFinal: messageHasFinalContent,
  })

  it('末条只有工具时，最终回答取轮内最后一条「以正文收尾」的助手消息', () => {
    const shell = timeline.find(item => item.kind === 'process-shell')
    expect(shell).toBeDefined()
    if (shell?.kind !== 'process-shell') return
    // 折叠块外必须挂出最终回答，否则收起后整轮正文消失
    expect(shell.finalMessage?.info.id).toBe('m4')
    // 同一行消息在壳内只以 'final' 作用域出现一次（只画正文，不画过程，也不重复）
    const finalChildren = shell.children.filter(child => child.message.info.id === 'm4')
    expect(finalChildren).toHaveLength(1)
    expect(finalChildren[0].processContentScope).toBe('final')
  })

  it('过程块仍承载全过程（含最终回答那条的过程部分），顺序不变', () => {
    const shell = timeline.find(item => item.kind === 'process-shell')
    if (shell?.kind !== 'process-shell') throw new Error('expected process shell')
    // 最终回答那条以 'final' 作用域留在壳内：只渲染正文，过程部分由其余 inline 消息承载
    expect(shell.children.map(child => `${child.message.info.id}:${child.processContentScope}`)).toEqual([
      'm1:inline',
      'm2:inline',
      'm3:inline',
      'm4:final',
      'm5:inline',
    ])
  })
})
