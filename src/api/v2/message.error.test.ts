import { describe, expect, it } from 'vitest'
import { adaptMessage } from './message'

/**
 * 中断信号在「刷新路径」上是否保留？
 *
 * 服务端实测（2026-11-01，笔电主机 ses_e6cc8b786ffepHbTstQ3zvDJ7f）：
 * 用户在工作中点停止后，该轮最后一条 assistant 是
 *   { type: 'assistant', finish: 'error', error: { type: 'aborted', message: 'Step interrupted' }, content: [] }
 * 同一页还有 idle 记录 outcome = 'interrupted'。
 *
 * 实时路径（v2/events.ts 的 session.step.failed）会把 error 映射成
 * MessageAbortedError 挂到消息上；刷新路径走 adaptMessage，必须同样保留，
 * 否则「这一轮是被打断的」这个事实刷新后消失，界面只剩一个没有回复的折叠块。
 */
describe('adaptMessage：中断/错误信号', () => {
  it('保留 assistant 的 aborted 错误（刷新后仍能识别为被中断）', () => {
    const raw = {
      type: 'assistant',
      id: 'msg_1',
      sessionID: 'ses_1',
      time: { created: 1, completed: 2 },
      finish: 'error',
      error: { type: 'aborted', message: 'Step interrupted' },
      content: [],
    }
    const adapted = adaptMessage(raw)
    expect(adapted).not.toBeNull()
    const info = adapted!.info as { error?: { name?: string } }
    expect(info.error?.name).toBe('MessageAbortedError')
  })

  it('保留普通 API 错误', () => {
    const raw = {
      type: 'assistant',
      id: 'msg_2',
      sessionID: 'ses_1',
      time: { created: 1, completed: 2 },
      finish: 'error',
      error: { type: 'provider.quota', message: 'quota exceeded', status: 429 },
      content: [],
    }
    const adapted = adaptMessage(raw)
    const info = adapted!.info as { error?: { name?: string; data?: { message?: string } } }
    expect(info.error?.name).toBe('APIError')
    expect(info.error?.data?.message).toBe('quota exceeded')
  })
})
