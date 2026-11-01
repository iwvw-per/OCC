import { describe, expect, it } from 'vitest'
import { buildProcessTimeline } from './chatPageModel'
import { messageHasFinalContent, messageHasProcessContent } from '../message/messageRenderLogic'
import type { Content, Message, MessageError, TextContent, ToolContent } from '../../types/message'

/**
 * 「最终回答要不要露到折叠块外」的完整判据矩阵。
 *
 * 依据三台主机 30 个会话 / 308 轮 / 5861 条带 finish 消息的全量实测：
 *
 *   finish       末 part    条数   该不该露在壳外
 *   stop         text        211    ✅ 露
 *   length       text          0    ✅ 露（截断的回答）
 *   tool-calls   tool        多      ❌ 折叠（过程说明）
 *   tool-calls   text          0    （服务端不存在这种形态）
 *   error        tool         65    ❌ 折叠（被打断的过程）
 *   error        text          3    ✅ 露（被打断前已写出的实质回答）
 *   无 finish    text          1    ✅ 露（骨架轮，按位置兜底）
 *   无 finish    tool         多      ❌ 折叠（纯工具轮）
 */

function text(messageID: string, id: string, value: string, synthetic = false): TextContent {
  return { id, sessionID: 's', messageID, type: 'text', text: value, synthetic } as TextContent
}
function reasoning(messageID: string, id: string, value: string): Content {
  return { id, sessionID: 's', messageID, type: 'reasoning', text: value } as Content
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
function aborted(): MessageError {
  return { name: 'MessageAbortedError', data: { message: 'Step interrupted' } } as unknown as MessageError
}
function assistant(id: string, content: Content[], finish?: string, error?: MessageError): Message {
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
function user(id: string): Message {
  return {
    info: { id, sessionID: 's', role: 'user', time: { created: 1 } },
    content: [text(id, `${id}:t`, '问题')],
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

/** 壳外可见正文（全部最终回答拼接） */
function outside(timeline: ReturnType<typeof buildProcessTimeline>): string[] {
  const out: string[] = []
  const tx = (m: Message) =>
    m.content
      .filter((c): c is TextContent => c.type === 'text')
      .map(c => c.text)
      .join('')
  for (const item of timeline) {
    if (item.kind === 'message' && item.message.info.role === 'assistant') out.push(tx(item.message))
    if (item.kind === 'process-shell') {
      for (const f of item.finalMessages ?? (item.finalMessage ? [item.finalMessage] : [])) out.push(tx(f))
    }
  }
  return out.filter(t => t.trim())
}

const build = (messages: Message[]) => buildProcessTimeline(messages, base)

describe('最终回答判据矩阵', () => {
  it('stop + text 收尾 → 露在壳外', () => {
    const t = build([
      user('u1'),
      assistant('m1', [reasoning('m1', 'r1', 'think'), text('m1', 't1', '过程'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [reasoning('m2', 'r2', 'think'), text('m2', 't2', '这是回答。')], 'stop'),
    ])
    expect(outside(t)).toEqual(['这是回答。'])
  })

  it('tool-calls + tool 收尾 → 折叠（过程说明不外露）', () => {
    const t = build([
      user('u1'),
      assistant('m1', [text('m1', 't1', '收到，我逐条执行。'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [tool('m2', 'c2')], 'tool-calls'),
    ])
    expect(outside(t)).toEqual([])
  })

  it('error(aborted) + tool 收尾 → 折叠（被打断的过程）', () => {
    const t = build([
      user('u1'),
      assistant('m1', [text('m1', 't1', '我来跑一下。'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [tool('m2', 'c2')], 'error', aborted()),
    ])
    expect(outside(t)).toEqual([])
  })

  it('error(aborted) + text 收尾 → 露在壳外（打断前已写完的回答）', () => {
    /**
     * 实测 ARM 主机 ses_eaa3442ccffeFLuqH2Vt3aN9TA 第 4 轮：
     * 用户点停止时模型已写完 2480 字分析。
     */
    const answer = '## 二、次要热点\n\n'.repeat(10) + '这份证据已经足够，可以下结论了。'
    const t = build([
      user('u1'),
      assistant('m1', [text('m1', 't1', '先取证。'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [text('m2', 't2', answer)], 'error', aborted()),
    ])
    expect(outside(t)).toEqual([answer])
  })

  it('单步中断（无 finish）+ text 收尾 → 按位置兜底露在壳外', () => {
    const t = build([
      user('u1'),
      assistant('m1', [reasoning('m1', 'r1', 'think'), text('m1', 't1', '被中断前写完的回答。')]),
    ])
    // 纯正文、无过程 → 直接平铺；有壳则回答在壳外
    expect(outside(t)).toEqual(['被中断前写完的回答。'])
  })

  it('单步中断（finish=error）+ tool 收尾 → 折叠（不把过程当回答）', () => {
    /**
     * 实测 8 例（笔电主机 ses_e6c879329ffexw42oeNQJzCRvr 等）：
     * 用户刚发出 `sleep 90` 就点停止，那一轮只有一条 assistant：
     *   [text(「这条命令会先暂停 90 秒…」), tool]  finish=error(aborted)
     *
     * 这段正文是过程说明（末 part 是 tool → 被工具调用打断），不能露到壳外。
     */
    const t = build([
      user('u1'),
      assistant('m1', [text('m1', 't1', '这条命令会先静默等待 90 秒…'), tool('m1', 'c1')], 'error', aborted()),
    ])
    expect(outside(t)).toEqual([])
  })

  it('无 finish 且没有任何以正文收尾的消息 → 退回「带正文」兜底（兼容老数据）', () => {
    /**
     * 无 finish 的真实消息在全量数据里只有 8 条（0.14%），且都还在流式。
     * 这种数据没有服务端结论可依：若一条「以正文收尾」的都没有，仍按旧行为
     * 取最后一条带正文的，避免老会话的回复整轮消失。
     */
    const t = build([user('u1'), assistant('m1', [text('m1', 't1', '这条命令会先静默等待 90 秒…'), tool('m1', 'c1')])])
    expect(outside(t)).toEqual(['这条命令会先静默等待 90 秒…'])
  })

  it('无 finish 的纯工具轮 → 折叠', () => {
    const t = build([user('u1'), assistant('m1', [tool('m1', 'c1')]), assistant('m2', [tool('m2', 'c2')])])
    expect(outside(t)).toEqual([])
  })

  it('length（被截断的回答）→ 露在壳外', () => {
    const t = build([
      user('u1'),
      assistant('m1', [text('m1', 't1', '被截断的回答…'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [text('m2', 't2', '这是一段被长度截断的回答')], 'length'),
    ])
    expect(outside(t)).toEqual(['这是一段被长度截断的回答'])
  })
})

describe('多段执行（后台任务唤醒）', () => {
  it('两个 stop 的正文都露在壳外，中间过程说明不外露', () => {
    const t = build([
      user('u1'),
      assistant('m1', [text('m1', 't1', '先确认版本号。'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [text('m2', 't2', 'CI 还在运行。')], 'stop'),
      // synthetic 之后继续跑
      assistant('m3', [tool('m3', 'c3')], 'tool-calls'),
      assistant('m4', [text('m4', 't4', 'Release 已成功完成。'), tool('m4', 'c4')], 'tool-calls'),
      assistant('m5', [text('m5', 't5', '全部完成，且都已核实。')], 'stop'),
    ])
    expect(outside(t)).toEqual(['CI 还在运行。', '全部完成，且都已核实。'])
  })

  it('展开/收起的语义等价：壳外内容只由 finish 决定，与 children 无关', () => {
    const messages = [
      user('u1'),
      assistant('m1', [text('m1', 't1', '过程一'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [text('m2', 't2', '回答一')], 'stop'),
      assistant('m3', [text('m3', 't3', '过程二'), tool('m3', 'c3')], 'tool-calls'),
      assistant('m4', [text('m4', 't4', '回答二'), tool('m4', 'c4')], 'stop'),
    ]
    const t = build(messages)
    const shell = t.find(i => i.kind === 'process-shell')
    if (shell?.kind !== 'process-shell') throw new Error('expected shell')
    // 壳外两条
    expect(shell.finalMessages?.map(m => m.info.id)).toEqual(['m2', 'm4'])
    expect(shell.finalMessage?.info.id).toBe('m4')
    // 结论消息一律以 process 作用域进壳（壳内只画过程项，正文只由壳外渲染）
    for (const idx of ['m2', 'm4']) {
      const child = shell.children.find(c => c.message.info.id === idx)
      if (child) expect(child.processContentScope).toBe('process')
    }
    // 同一消息绝不既以 process 又以 final 出现
    for (const c of shell.children) {
      const dup = shell.children.filter(x => x.message.info.id === c.message.info.id)
      expect(dup).toHaveLength(1)
    }
  })
})

describe('中断轮里已写出的回答', () => {
  it('先正常结束若干段、最后才被打断：所有 stop 结论都要保留', () => {
    /**
     * 实测 ARM 主机 ses_e754c2c25ffeR6bIwbgwgBmLQ6（user msg_18ab3d621001NF…）：
     *   [47] finish=stop  text(90)   「`npm run audit:fast` 已在后台运行…」
     *   [58] finish=stop  text(101)  「`gh run watch` 已在后台监听…」
     *   [84] finish=error(aborted)   content 只有 reasoning
     *   IDLE interrupted
     *
     * 旧实现用「最后一条以正文收尾的消息」覆盖，把 [47] 丢了（只显示 1 条）。
     */
    const t = build([
      user('u1'),
      assistant('m1', [text('m1', 't1', 'audit:fast 已在后台运行。'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [text('m2', 't2', 'audit:fast 已在后台运行，等待其完成。')], 'stop'),
      assistant('m3', [text('m3', 't3', '现在监听 CI。'), tool('m3', 'c3')], 'tool-calls'),
      assistant('m4', [text('m4', 't4', 'gh run watch 已在后台监听 CI。')], 'stop'),
      assistant('m5', [reasoning('m5', 'r5', '被中断')], 'error', aborted()),
    ])
    expect(outside(t)).toEqual(['audit:fast 已在后台运行，等待其完成。', 'gh run watch 已在后台监听 CI。'])
  })

  it('整轮没有正常结论、但已写出正文：露出来', () => {
    const answer = '## 二、次要热点\n\n'.repeat(6) + '这份证据已经足够。'
    const t = build([
      user('u1'),
      assistant('m1', [text('m1', 't1', '先取证。'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [text('m2', 't2', answer)], 'error', aborted()),
    ])
    expect(outside(t)).toEqual([answer])
  })
})

describe('中断提示', () => {
  it('中断轮带 interrupted 标记，且有回答时回答也在壳外', () => {
    const t = build([
      user('u1'),
      assistant('m1', [text('m1', 't1', '过程'), tool('m1', 'c1')], 'tool-calls'),
      assistant('m2', [text('m2', 't2', '被打断前写完的回答')], 'error', aborted()),
    ])
    const shell = t.find(i => i.kind === 'process-shell')
    if (shell?.kind !== 'process-shell') throw new Error('expected shell')
    expect(shell.interrupted).toBe(true)
    expect(outside(t)).toEqual(['被打断前写完的回答'])
  })
})
