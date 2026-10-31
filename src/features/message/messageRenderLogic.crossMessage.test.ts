import { describe, expect, it } from 'vitest'
import { groupContentsForRender, messageHasFinalContent, splitProcessRenderItems } from './messageRenderLogic'
import type { Message, TextContent, ToolContent } from '../../types/message'

/**
 * 回归：跨消息的「最终回答」不再被拆分规则吞掉。
 *
 * 真实故障（2026-10-31 实测，arm 主机 ses_e6dcd22dbffe67R75bZIbrBWHI）：
 * agent 连跑 5 条 shell，轮次以 `finish: tool-calls` 的消息收尾，**真正的
 * 回答在倒数第一条**（它本身也是 tool-calls，正文后面还跟着工具）。
 *
 * 旧实现按「**单条消息内**最后一段连续 text」判最终回答：
 *   最后一条 assistant 没有任何可见正文 → messageHasFinal 为 false
 *   → 倒数第一条里那句回答被当成过程内容塞进折叠块
 * → 折叠块默认收起，页面上只剩「已处理 1m 34s」，回答凭空消失；
 *   而整页刷新走骨架/历史快照路径（消息被拆成「提问 + 回复」两段）就正常
 *   —— 正是用户报的「回复完了显示不全，刷新才完整」。
 *
 * 服务端数据（msg_1923314ef001iLvnS9jLJS2q46，finish=tool-calls）：
 *   content = [text("第四条已输出 a4，最后执行第五条命令。"), tool(shell)]
 */
function text(id: string, value: string): TextContent {
  return {
    id,
    sessionID: 's',
    messageID: 'm',
    type: 'text',
    text: value,
    synthetic: false,
  } as TextContent
}

function tool(id: string): ToolContent {
  return {
    id,
    sessionID: 's',
    messageID: 'm',
    type: 'tool',
    callID: id,
    tool: 'shell',
    state: { status: 'completed', input: {}, output: 'a4' },
  } as unknown as ToolContent
}

/** 与服务端一致：消息已定稿（有 completed），且末条以 tool-calls 收尾 */
function message(id: string, content: Message['content'], finish: string): Message {
  return {
    info: {
      id,
      sessionID: 's',
      role: 'assistant',
      time: { created: 1, completed: 2 },
      finish,
    },
    content,
    isStreaming: false,
  } as unknown as Message
}

describe('跨消息的最终回答（多工具长回合）', () => {
  const withReply = message('m-reply', [text('t1', '第四条已输出 a4，最后执行第五条命令。'), tool('c1')], 'tool-calls')
  const toolOnly = message('m-tool-only', [tool('c5')], 'tool-calls')

  it('单条消息内：正文后跟工具时，正文仍是最终回答（既有行为）', () => {
    const split = splitProcessRenderItems(groupContentsForRender(withReply.content))
    expect(split.hasFinal).toBe(true)
    expect(messageHasFinalContent(withReply)).toBe(true)
  })

  it('末条消息只有工具时，单条判据为 false —— 这正是旧实现的缺口', () => {
    // 记录现状：拆分只看单条消息，所以末条「纯工具」消息自己永远没有最终回答。
    expect(messageHasFinalContent(toolOnly)).toBe(false)
  })

  it('轮次里存在可展示的最终回答时，即便末条只有工具也不应整轮落进折叠块', () => {
    // 期望语义：最终回答 = 轮内最后一条「以正文收尾」的助手消息。
    // 该判据由轮次级（chatPageModel）负责，单条消息的判据只回答「我自己有没有」。
    const candidates = [withReply, toolOnly].filter(messageHasFinalContent)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].info.id).toBe('m-reply')
  })
})
