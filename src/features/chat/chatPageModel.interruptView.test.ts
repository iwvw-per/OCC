import { describe, expect, it } from 'vitest'
import { buildVisibleMessageEntries } from './chatAreaVisibility'
import { buildProcessTimeline } from './chatPageModel'
import { messageHasFinalContent, messageHasProcessContent } from '../message/messageRenderLogic'
import type { Content, Message, MessageError, TextContent, ToolContent } from '../../types/message'

/**
 * 打断后的呈现。
 *
 * 服务端实测（2026-11-01，笔电主机 ses_e6cc8b786ffepHbTstQ3zvDJ7f，用户在工作
 * 中点停止）：
 *
 *   USER   请依次执行 12 条 shell 命令…
 *   assist finish=tool-calls  [reasoning, text(39), tool]   ← 过程说明
 *   assist finish=error       []  error={type:'aborted'}     ← 空，仅承载中断事实
 *   IDLE   outcome=interrupted
 *
 * 期望：折叠块下方明确写出「本轮已被中断」，且过程说明不露到壳外。
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

function abortedError(): MessageError {
  return { name: 'MessageAbortedError', data: { message: 'Step interrupted' } } as unknown as MessageError
}

function assistant(
  id: string,
  content: Content[],
  finish?: string,
  error?: MessageError,
): Message {
  return {
    info: {
      id,
      sessionID: 's',
      role: 'assistant',
      time: { created: 1, completed: 2 },
      finish,
      ...(error ? { error } : {}),
    },
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

describe('打断轮次的呈现', () => {
  const messages: Message[] = [
    userMessage('u1'),
    assistant('a1', [text('a1', 'a1-t', '收到，我逐条执行这 12 个 echo 命令。'), tool('a1', 'c1')], 'tool-calls'),
    // 中断标记：content 为空，只有 error
    assistant('a2', [], 'error', abortedError()),
  ]

  it('中断轮次的过程说明不露到壳外', () => {
    const timeline = buildProcessTimeline(messages, base)
    const shell = timeline.find(item => item.kind === 'process-shell')
    expect(shell).toBeDefined()
    if (shell?.kind !== 'process-shell') return
    expect(shell.finalMessage).toBeUndefined()
  })

  it('单步中断轮（连 finish 都没有）也不能把过程说明当回答', () => {
    /**
     * 现场（2026-11-01，笔电主机 ses_e6c80cbd7ffeWmC9OPDk7CmiyT）：用户发出
     * 「先写一句说明，然后执行 sleep 90」后立刻点停止。这一轮只有一条 assistant：
     *
     *   [reasoning, text(「这条命令会先静默等待 90 秒…」), tool(shell)]
     *   finish = undefined        ← 服务端只发 step.failed，不发 step.ended
     *   error  = { type: 'aborted' }
     *
     * 因为轮内**没有任何 finish**，旧逻辑走「按位置兜底」，把那段过程说明
     * 当成了最终回答挂到折叠块外 —— 实测折叠块已收起（expanded=false），
     * 但 148px 的过程说明仍然可见，正是用户反馈的「打断后泄露折叠设计」。
     */
    const singleStepInterrupted: Message[] = [
      userMessage('u1'),
      assistant(
        'a1',
        [text('a1', 'a1-t', '这条命令会先静默等待 90 秒，之后执行 echo done。'), tool('a1', 'c1')],
        undefined,
        abortedError(),
      ),
    ]
    const timeline = buildProcessTimeline(singleStepInterrupted, base)
    const shell = timeline.find(item => item.kind === 'process-shell')
    expect(shell).toBeDefined()
    if (shell?.kind !== 'process-shell') return
    expect(shell.finalMessage).toBeUndefined()
    expect(shell.interrupted).toBe(true)
    // 过程说明仍在壳内（展开可见）
    expect(shell.children.map(c => `${c.message.info.id}:${c.processContentScope}`)).toEqual(['a1:inline'])
  })

  it('中断事实必须能传到时间线（折叠块下方要显示「已中断」）', () => {
    /**
     * 若中断消息被可见性过滤掉，timeline 只看到 tool-calls 的过程消息，
     * 无法区分「被用户打断」与「本来就没有回复的纯工具轮」。
     */
    const entries = buildVisibleMessageEntries(messages)
    const ids = entries.map(e => e.message.info.id)
    expect(ids).toContain('a2')

    const timeline = buildProcessTimeline(messages, base)
    const shell = timeline.find(item => item.kind === 'process-shell')
    if (shell?.kind !== 'process-shell') throw new Error('expected shell')
    expect(shell.interrupted).toBe(true)
  })

  it('正常结束的轮次不带 interrupted 标记', () => {
    const ok: Message[] = [
      userMessage('u1'),
      assistant('a1', [tool('a1', 'c1')], 'tool-calls'),
      assistant('a2', [text('a2', 'a2-t', '完成了。')], 'stop'),
    ]
    const timeline = buildProcessTimeline(ok, base)
    const shell = timeline.find(item => item.kind === 'process-shell')
    if (shell?.kind !== 'process-shell') throw new Error('expected shell')
    expect(shell.interrupted).toBeFalsy()
  })
})
