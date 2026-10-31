import { describe, expect, it } from 'vitest'
import { buildProcessTimeline } from './chatPageModel'
import { messageHasFinalContent, messageHasProcessContent } from '../message/messageRenderLogic'
import type { Content, Message, TextContent, ToolContent } from '../../types/message'

/**
 * 回归（2026-11-01 实测，笔电主机 ses_e6cc8b786ffepHbTstQ3zvDJ7f）：
 * **Agent 工作中被打断时，过程说明会泄漏成最终回复**。
 *
 * 现场（真实 UI 点击停止按钮）：
 *   打断前  shell 标题「Working for 6s …」，壳内 1184 字，正文区 2 块
 *   打断后  shell 标题「Worked for 6s …」，那句过程说明**露到壳外**
 *   刷新后  shell 只有「Worked for 6s 1 1 steps」，正文区 0 块（服务端无回复）
 *
 * 服务端数据（abort 后）：
 *   assistant finish=tool-calls  content=[reasoning(642), text(41), tool]
 *   即：这一轮**没有最终回复**，那句 text 是过程说明。
 *
 * 根因：最终回复的判定用 `messageHasFinal()`，只看「这条消息里有没有可见
 * text」，不看服务端的 `finish`。打断瞬间轮次结束，于是把 finish=tool-calls
 * 的过程说明当成了最终回答挂到壳外。
 *
 * 正确判据：`finish === 'stop'`（模型正常收尾）才是最终回复；`length`
 * 是「被截断的回答」可作兜底；`tool-calls` 永远只是过程。
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
    content: [text(id, `${id}:t`, '执行 12 条命令')],
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

describe('打断场景：过程说明不能泄漏成最终回复', () => {
  it('只有 finish=tool-calls 的过程说明时，不应在壳外挂出「最终回复」', () => {
    const messages: Message[] = [
      userMessage('u1'),
      assistant('a1', [text('a1', 'a1-t', '收到，我逐条执行这 12 个 echo 命令。'), tool('a1', 'c1')], 'tool-calls'),
      assistant('a2', [tool('a2', 'c2')], 'tool-calls'),
    ]

    const timeline = buildProcessTimeline(messages, base)
    const shell = timeline.find(item => item.kind === 'process-shell')
    expect(shell).toBeDefined()
    if (shell?.kind !== 'process-shell') return

    // 这一轮被中断，服务端没有 stop → 壳外不应有正文
    expect(shell.finalMessage).toBeUndefined()
    // 过程说明仍可在壳内看到（展开后）
    const scopes = shell.children.map(c => `${c.message.info.id}:${c.processContentScope}`)
    expect(scopes).toContain('a1:inline')
  })

  it('finish=stop 的那条才是最终回复', () => {
    const messages: Message[] = [
      userMessage('u1'),
      assistant('a1', [text('a1', 'a1-t', '中间说明'), tool('a1', 'c1')], 'tool-calls'),
      assistant('a2', [text('a2', 'a2-t', '这是真正的回答。')], 'stop'),
    ]

    const timeline = buildProcessTimeline(messages, base)
    const shell = timeline.find(item => item.kind === 'process-shell')
    if (shell?.kind !== 'process-shell') throw new Error('expected shell')
    expect(shell.finalMessage?.info.id).toBe('a2')
  })

  it('finish=length（被输出长度截断）也当作回答，可作兜底', () => {
    const messages: Message[] = [
      userMessage('u1'),
      assistant('a1', [text('a1', 'a1-t', '被截断的回答…')], 'length'),
    ]

    const timeline = buildProcessTimeline(messages, base)
    const shell = timeline.find(item => item.kind === 'process-shell')
    if (shell?.kind === 'process-shell') {
      expect(shell.finalMessage?.info.id).toBe('a1')
    } else {
      // 没有过程内容时直接平铺，也是可接受的呈现
      expect(timeline.some(item => item.kind === 'message' && item.message.info.id === 'a1')).toBe(true)
    }
  })
})
