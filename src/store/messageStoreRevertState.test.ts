// 回归：撤销态的三态语义与「只 stage 不 commit」。
//
// 用户报障（2026-11-11）：点「从此处撤销」后，上一条消息回到输入框，但**立刻
// 又恢复成发送态**，无法编辑、反复重试都无效。
//
// 根因有两个，都是「撤销态被清掉」：
//
// 1. `nativeRevertMessage` 多调了一次 `revert.commit`。官方源码
//    （packages/core/src/session/projector.ts）显示 commit 会物理删除边界之后
//    的全部消息并把 `revert` 置为 null：
//        delete from SessionMessage where seq >= boundary.seq
//        setSession(..., { revert: null })
//    实测 commit 后 GET /api/session 的 revert 变成 null，再 stage 同一
//    messageID 直接报 MessageNotFoundError。→ 只 stage 才是正确的「撤销」。
//
// 2. `setMessages` 把 `revertState: sessionInfo?.revert ?? null` 当权威写回。
//    撤销发生的瞬间，loadSession 并发发出的 sessionInfo 请求可能还没有 revert，
//    于是用 null 覆盖掉了本地刚建立的撤销态。
//
// 这两个用例锁住修复：快照不涉及撤销态（undefined）时必须保留本地值。

import { beforeEach, describe, expect, it } from 'vitest'
import { messageStore } from './messageStore'
import type { ApiMessageWithParts } from '../api/types'

function msg(id: string): ApiMessageWithParts {
  return {
    info: {
      id,
      sessionID: 's',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'p', modelID: 'm', variant: 'default' },
    },
    parts: [{ id: `${id}-text`, sessionID: 's', messageID: id, type: 'text', text: id }],
  } as unknown as ApiMessageWithParts
}

describe('setMessages 的撤销态三态语义', () => {
  beforeEach(() => {
    messageStore.clearSession('s')
  })

  it('revertState 为 undefined 时保留本地撤销态（不覆盖）', () => {
    messageStore.setMessages('s', [msg('m1'), msg('m2'), msg('m3')])
    // 用户点撤销：本地先落撤销态（乐观）
    messageStore.setRevertState('s', { messageId: 'm3', history: [] })
    expect(messageStore.getRevertState('s')?.messageId).toBe('m3')

    /**
     * 紧随其后的一次消息重载：这次请求早于 stage，所以没有 revert 信息。
     * 旧实现传 `revertState: null`，直接把撤销态清掉 → 消息全部回来。
     */
    messageStore.setMessages('s', [msg('m1'), msg('m2'), msg('m3')])

    expect(messageStore.getRevertState('s')?.messageId).toBe('m3')
    // 可见消息仍应截断在撤销点
    expect(messageStore.getVisibleMessages('s').map(m => m.info.id)).toEqual(['m1', 'm2'])
  })

  it('revertState 为 null 时清空本地撤销态（服务端确认无撤销）', () => {
    messageStore.setMessages('s', [msg('m1'), msg('m2')])
    messageStore.setRevertState('s', { messageId: 'm2', history: [] })

    // 显式 null = 服务端确认没有撤销（例如用户在别处 redo 到底）
    messageStore.setMessages('s', [msg('m1'), msg('m2')], { revertState: null })

    expect(messageStore.getRevertState('s')).toBeNull()
    expect(messageStore.getVisibleMessages('s')).toHaveLength(2)
  })

  it('revertState 带 messageID 时按服务端权威点重建', () => {
    messageStore.setMessages('s', [msg('m1'), msg('m2'), msg('m3')])

    messageStore.setMessages('s', [msg('m1'), msg('m2'), msg('m3')], {
      revertState: { messageID: 'm2' } as never,
    })

    expect(messageStore.getRevertState('s')?.messageId).toBe('m2')
    expect(messageStore.getVisibleMessages('s').map(m => m.info.id)).toEqual(['m1'])
  })
})
