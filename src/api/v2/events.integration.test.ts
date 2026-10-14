// 集成验证：v2 事件流（/api/event SSE）经 v2EventToGlobalEvent 合成后，
// 能被 messageStore 正确消费，完成「assistant 消息骨架建立 + part 流式渲染」。
//
// 这是「对话发出后一直转圈无响应」的回归测试：
// v2 没有 message.updated / message.part.updated / message.part.delta 事件，
// 前端消息渲染依赖它们建骨架 + 填充 part。此前 v2 事件映射读 data.messageID
// （v2 实际字段是 assistantMessageID）且不建骨架，导致 assistant 消息永远
// 建立不起来 → UI 一直转圈。修复后 v2 事件被正确合成为 v1 形状，messageStore
// 能正常消费。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { v2EventToGlobalEvent } from './events'
import { EventTypes } from '../../types/api/event'
import { messageStore } from '../../store/messageStore'
import { sanitizeStreamPart } from '../sanitize'

/** 模拟 events.ts 的 handleEventForSubscriber 拆包分发，把合成事件喂给 messageStore。 */
function dispatchToStore(g: NonNullable<ReturnType<typeof v2EventToGlobalEvent>>) {
  const payload = g.payload as { type: string; properties: Record<string, unknown> }
  switch (payload.type) {
    case EventTypes.MESSAGE_UPDATED: {
      const info = (payload.properties.info ?? payload.properties.message) as never
      messageStore.handleMessageUpdated(info)
      break
    }
    case EventTypes.MESSAGE_PART_UPDATED: {
      messageStore.handlePartUpdated(sanitizeStreamPart(payload.properties.part as never) as never)
      break
    }
    case EventTypes.MESSAGE_PART_DELTA: {
      messageStore.handlePartDelta(payload.properties as never)
      break
    }
  }
}

const SESSION_ID = 'ses_test'

function v2StepStarted(assistantMessageID = 'msg_asst_1'): unknown {
  return {
    type: 'session.step.started',
    data: { sessionID: SESSION_ID, assistantMessageID, agent: 'build' },
    location: { directory: '/w' },
  }
}

function v2TextStarted(assistantMessageID = 'msg_asst_1', ordinal = 0): unknown {
  return {
    type: 'session.text.started',
    data: { sessionID: SESSION_ID, assistantMessageID, ordinal },
    location: { directory: '/w' },
  }
}

function v2TextDelta(assistantMessageID = 'msg_asst_1', ordinal = 0, delta: string): unknown {
  return {
    type: 'session.text.delta',
    data: { sessionID: SESSION_ID, assistantMessageID, ordinal, delta },
    location: { directory: '/w' },
  }
}

describe('v2 事件流 → messageStore 集成（对话流式渲染）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    messageStore.clearAll()
  })

  it('step.started 建立 assistant 骨架，text.started/delta 填充文本', () => {
    dispatchToStore(v2EventToGlobalEvent(v2StepStarted())!)
    dispatchToStore(v2EventToGlobalEvent(v2TextStarted())!)
    dispatchToStore(v2EventToGlobalEvent(v2TextDelta('msg_asst_1', 0, '你好'))!)
    dispatchToStore(v2EventToGlobalEvent(v2TextDelta('msg_asst_1', 0, '，世界'))!)

    const state = messageStore.getSessionState(SESSION_ID)
    expect(state?.messages).toHaveLength(1)
    const msg = state!.messages[0]
    expect(msg.info.id).toBe('msg_asst_1')
    expect(msg.info.role).toBe('assistant')
    expect(msg.info.agent).toBe('build')
    expect(msg.parts).toHaveLength(1)
    expect(msg.parts[0]).toMatchObject({ id: 'msg_asst_1-text-0', type: 'text', text: '你好，世界' })
  })

  it('多段文本（不同 ordinal）生成独立 part，互不串扰', () => {
    dispatchToStore(v2EventToGlobalEvent(v2StepStarted())!)
    dispatchToStore(v2EventToGlobalEvent(v2TextStarted('msg_asst_1', 0))!)
    dispatchToStore(v2EventToGlobalEvent(v2TextDelta('msg_asst_1', 0, '第一段'))!)
    dispatchToStore(v2EventToGlobalEvent(v2TextStarted('msg_asst_1', 1))!)
    dispatchToStore(v2EventToGlobalEvent(v2TextDelta('msg_asst_1', 1, '第二段'))!)

    const state = messageStore.getSessionState(SESSION_ID)
    const parts = state!.messages[0].parts
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({ id: 'msg_asst_1-text-0', text: '第一段' })
    expect(parts[1]).toMatchObject({ id: 'msg_asst_1-text-1', text: '第二段' })
  })
})
