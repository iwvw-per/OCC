import { describe, expect, it } from 'vitest'
import { adaptMessage } from './message'
import { isVisibleTextContent } from '../../types/message'

/**
 * 回归：后台任务完成通知是 v2 的 `synthetic` 消息。
 *
 * 它必须**被保留**（否则工作状态面板里所有后台任务永远「状态未知」），
 * 但**不能进对话流**（否则用户会在对话里看到一段 `<shell ...>` XML）。
 */
describe('adaptMessage: synthetic 后台任务通知', () => {
  const raw = {
    id: 'msg_syn_1',
    sessionID: 'ses_1',
    type: 'synthetic',
    time: { created: 5000 },
    text: '<shell id="sh_1" state="completed" command="npm run build">BUILD OK</shell>',
  }

  it('keeps the synthetic message so background jobs can be reconciled', () => {
    const adapted = adaptMessage(raw)
    expect(adapted).not.toBeNull()
    expect(adapted?.info.role).toBe('assistant')
    const part = adapted?.parts[0] as { type: string; text: string; synthetic?: boolean }
    expect(part.type).toBe('text')
    expect(part.synthetic).toBe(true)
    expect(part.text).toContain('sh_1')
  })

  it('keeps the synthetic text out of the conversation stream', () => {
    const adapted = adaptMessage(raw)
    const part = adapted?.parts[0]
    expect(part).toBeTruthy()
    // 渲染层的可见性判定必须把它过滤掉
    expect(isVisibleTextContent(part as never)).toBe(false)
  })

  it('drops empty synthetic messages', () => {
    expect(adaptMessage({ ...raw, text: '   ' })).toBeNull()
  })
})
