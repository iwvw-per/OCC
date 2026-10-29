// ============================================
// 过程 / 最终回答的拆分（splitProcessRenderItems）
// ============================================
//
// 这套判定的输出直接决定「收起折叠块后用户还能不能看到回复」。
// 判错的代价是正文凭空消失，只剩一行「已处理 Ns」，因此每个形状都要钉住。

import { describe, expect, it } from 'vitest'
import { messageHasFinalContent, messageHasProcessContent, splitProcessRenderItems } from './messageRenderLogic'
import type { Message, TextContent, ToolContent } from '../../types/message'

const MID = 'msg_1'

function text(id: string, body: string): TextContent {
  return { id, sessionID: 's', messageID: MID, type: 'text', text: body, synthetic: false } as TextContent
}

function reasoning(id: string, body = 'think'): Message['content'][0] {
  return { id, sessionID: 's', messageID: MID, type: 'reasoning', text: body } as Message['content'][0]
}

function tool(id: string): ToolContent {
  return {
    id,
    sessionID: 's',
    messageID: MID,
    type: 'tool',
    tool: 'shell',
    callID: id,
    state: { status: 'completed', input: {}, time: { start: 1, end: 2 } },
  } as unknown as ToolContent
}

function message(content: Message['content'], completed = true): Message {
  return {
    info: {
      id: MID,
      sessionID: 's',
      role: 'assistant',
      time: completed ? { created: 1, completed: 2 } : { created: 1 },
    } as Message['info'],
    content,
    isStreaming: false,
  }
}

/** 便于断言的形状：只取类型名 */
function shape(items: { type: string; content?: { type: string; text?: string } }[]) {
  return items.map(item => (item.type === 'single' ? `${item.content?.type}:${item.content?.text ?? ''}` : item.type))
}

describe('splitProcessRenderItems', () => {
  it('空内容：既无过程也无最终', () => {
    const split = splitProcessRenderItems([])
    expect(split).toEqual({ processItems: [], finalItems: [], hasProcess: false, hasFinal: false })
  })

  it('纯文本：整段都是最终回答', () => {
    const split = splitProcessRenderItems([{ type: 'single', content: text('t1', 'the answer') }])
    expect(split.hasFinal).toBe(true)
    expect(split.hasProcess).toBe(false)
    expect(shape(split.finalItems)).toEqual(['text:the answer'])
  })

  it('末尾是 text：text 段是最终回答，前面都是过程', () => {
    const split = splitProcessRenderItems([
      { type: 'single', content: reasoning('r1') },
      { type: 'tool-group', contents: [tool('c1')] },
      { type: 'single', content: text('t1', 'answer') },
    ])
    expect(shape(split.finalItems)).toEqual(['text:answer'])
    expect(split.hasProcess).toBe(true)
  })

  it('text 后跟 tool（先回复再继续干活）：text 仍是最终回答，tool 进过程', () => {
    /**
     * 回归：实测 content 顺序常是 `[reasoning, text, tool, tool]` —— 模型先说明
     * 一句、然后继续调工具。旧实现从末尾找 text，第一项不是 text 就 break，
     * 于是 hasFinal=false，整轮回复被折进默认收起的过程块，正文消失。
     */
    const split = splitProcessRenderItems([
      { type: 'single', content: reasoning('r1') },
      { type: 'single', content: text('t1', 'the answer') },
      { type: 'tool-group', contents: [tool('c1'), tool('c2')] },
    ])
    expect(split.hasFinal).toBe(true)
    expect(shape(split.finalItems)).toEqual(['text:the answer'])
    // 末尾的工具不能丢，必须留在过程里
    expect(shape(split.processItems)).toEqual(['reasoning:think', 'tool-group'])
  })

  it('多段相邻 text 合并成一段最终回答', () => {
    const split = splitProcessRenderItems([
      { type: 'single', content: text('t1', 'part one ') },
      { type: 'single', content: text('t2', 'part two') },
    ])
    expect(shape(split.finalItems)).toEqual(['text:part one ', 'text:part two'])
    expect(split.hasProcess).toBe(false)
  })

  it('中间的 text 不算最终回答（后面还有工具与结论）', () => {
    // 中间说明属于过程；只有**最后一段**连续 text 是回复
    const split = splitProcessRenderItems([
      { type: 'single', content: text('t1', 'let me check') },
      { type: 'tool-group', contents: [tool('c1')] },
      { type: 'single', content: text('t2', 'final answer') },
    ])
    expect(shape(split.finalItems)).toEqual(['text:final answer'])
    expect(shape(split.processItems)).toEqual(['text:let me check', 'tool-group'])
  })

  it('完全没有 text：全部是过程，没有最终回答', () => {
    const split = splitProcessRenderItems([
      { type: 'single', content: reasoning('r1') },
      { type: 'tool-group', contents: [tool('c1')] },
    ])
    expect(split.hasFinal).toBe(false)
    expect(split.hasProcess).toBe(true)
  })
})

describe('messageHasFinalContent / messageHasProcessContent', () => {
  it('text 后跟 tool 时仍报告「有最终回答」', () => {
    const m = message([reasoning('r1'), text('t1', 'answer'), tool('c1')])
    expect(messageHasFinalContent(m)).toBe(true)
    expect(messageHasProcessContent(m)).toBe(true)
  })

  it('流式未完成时不报告最终回答（中间 text 后面还可能跟工具）', () => {
    const m = message([text('t1', 'still writing')], false)
    expect(messageHasFinalContent(m)).toBe(false)
    expect(messageHasProcessContent(m)).toBe(true)
  })

  it('纯文本且已结束：只有最终回答，没有过程', () => {
    const m = message([text('t1', 'answer')])
    expect(messageHasFinalContent(m)).toBe(true)
    expect(messageHasProcessContent(m)).toBe(false)
  })

  it('只有工具调用：没有最终回答', () => {
    const m = message([reasoning('r1'), tool('c1')])
    expect(messageHasFinalContent(m)).toBe(false)
    expect(messageHasProcessContent(m)).toBe(true)
  })
})

describe('轮次级：折叠块的最终回复提取（走真实 messageHasFinal）', () => {
  /**
   * 这些用例走真实的 `buildProcessTimeline` + 真实的 `messageHasFinalContent`，
   * 而不是 ChatArea.test 里那种 `content.some(p => p.type === 'text')` 的近似 mock。
   * 后者的判定比真实实现宽松，恰好掩盖了「text 后跟 tool」这一类形状。
   */
  function userMsg(id: string, t: number): Message {
    return {
      info: { id, sessionID: 's', role: 'user', time: { created: t } } as Message['info'],
      content: [],
      isStreaming: false,
    }
  }

  function assistantMsg(id: string, content: Message['content'], created: number, completed: number): Message {
    return {
      info: { id, sessionID: 's', role: 'assistant', time: { created, completed } } as Message['info'],
      content: content.map(part => ({ ...part, messageID: id })),
      isStreaming: false,
    }
  }

  async function timelineOf(messages: Message[]) {
    const { buildProcessTimeline } = await import('../chat/chatPageModel')
    return buildProcessTimeline(messages, {
      turnDurationMap: new Map(),
      sessionIsStreaming: false,
      serverRunning: false,
      messageHasProcess: messageHasProcessContent,
      messageHasFinal: messageHasFinalContent,
    })
  }

  it('末条消息 text 后跟 tool：回复仍在折叠块外', async () => {
    const a = assistantMsg('a1', [reasoning('r1'), text('t1', 'THE REPLY'), tool('c1')], 100, 200)
    const items = await timelineOf([userMsg('u1', 50), a])
    const shell = items.find(i => i.kind === 'process-shell')
    expect(shell && 'finalMessage' in shell ? shell.finalMessage?.info.id : undefined).toBe('a1')
  })

  it('末条消息只有 tool：前一条的回复仍被提取为最终回答', async () => {
    /**
     * 工具密集型回合常以「只含工具调用」的消息收尾。若按末条判定，
     * finalOutside 为空 → 整轮正文全落进默认折叠的过程块。
     */
    const a1 = assistantMsg('a1', [reasoning('r1'), text('t1', 'THE REPLY'), tool('c1')], 100, 200)
    const a2 = assistantMsg('a2', [tool('c2')], 200, 300)
    const items = await timelineOf([userMsg('u1', 50), a1, a2])
    const shell = items.find(i => i.kind === 'process-shell')
    expect(shell && 'finalMessage' in shell ? shell.finalMessage?.info.id : undefined).toBe('a1')
  })
})
