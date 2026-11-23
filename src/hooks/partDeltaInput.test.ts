import { describe, expect, it } from 'vitest'
import { toPartDeltaInput } from './partDeltaInput'

/**
 * 回归:v2 映射(`api/v2/events.ts`)给的是**预拼好的 partID**,且**不转发
 * ordinal**。消费端若用 assistantMessageID + ordinal 重算,运行期拼出
 * `...-text-undefined`,永远匹配不到 part(增量全丢,表现为「不流式」)。
 */
describe('toPartDeltaInput', () => {
  it('text:直接用映射给的 partID(不靠 ordinal 重算)', () => {
    const input = toPartDeltaInput({
      sessionID: 's',
      messageID: 'msg_1',
      assistantMessageID: 'msg_1',
      partID: 'msg_1-text-2',
      field: 'text',
      delta: 'hi',
    })
    expect(input).toEqual({ sessionID: 's', messageID: 'msg_1', partID: 'msg_1-text-2', field: 'text', delta: 'hi' })
  })

  it('reasoning:field/partID 都跟着走,不会被改写成 text', () => {
    const input = toPartDeltaInput({
      sessionID: 's',
      messageID: 'msg_1',
      partID: 'msg_1-reasoning-0',
      field: 'reasoning',
      delta: 'think',
    })
    expect(input?.field).toBe('reasoning')
    expect(input?.partID).toBe('msg_1-reasoning-0')
  })

  it('缺少 partID 时按 field 回退拼装(兼容旧形状)', () => {
    expect(toPartDeltaInput({ sessionID: 's', assistantMessageID: 'msg_1', ordinal: 3, delta: 'x' })?.partID).toBe(
      'msg_1-text-3',
    )
    expect(
      toPartDeltaInput({ sessionID: 's', assistantMessageID: 'msg_1', ordinal: 1, field: 'reasoning', delta: 'x' })
        ?.partID,
    ).toBe('msg_1-reasoning-1')
  })

  it('既无 partID 也无消息 id → null(不产生悬空缓冲键)', () => {
    expect(toPartDeltaInput({ sessionID: 's', delta: 'x' })).toBeNull()
  })

  it('无 sessionID → null', () => {
    expect(toPartDeltaInput({ sessionID: '', partID: 'p', delta: 'x' } as never)).toBeNull()
  })
})
