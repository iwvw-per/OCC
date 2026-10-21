// ============================================
// 断线重连后恢复入队消息（session.inbox.list）
// ============================================
//
// SSE 是 volatile 的，断连期间的 `session.inbox.enqueued` 永久丢失。表现是
// 「另一台设备发的消息在这台设备上不出现」，直到那一轮跑完才突然冒出来。
// 这里用 inbox.list 纠错。关键约束：
// 1. 只补 user 类型（synthetic/compaction/move 是内部条目）。
// 2. 只处理已加载的会话（避免给没打开过的会话建档）。
// 3. 空文本跳过（无渲染内容）。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const listInbox = vi.fn()
const upsertUser = vi.fn()
const getKeys = vi.fn()
const touchSession = vi.fn()

vi.mock('./v2NativeSession', () => ({ nativeListInbox: listInbox }))
vi.mock('../store/messageStore', () => ({
  messageStore: {
    getLoadedSessionKeysForServer: getKeys,
    upsertRemoteUserMessage: upsertUser,
  },
}))
vi.mock('../store/activeSessionStore', () => ({
  activeSessionStore: { touchSession },
}))
vi.mock('../utils/sessionKey', () => ({
  makeSessionKey: (serverId: string, id: string) => `${serverId}::${id}`,
}))
vi.mock('../utils', () => ({ logger: { warn: vi.fn() } }))

const { recoverPendingInbox } = await import('./inboxRecovery')

describe('recoverPendingInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getKeys.mockReturnValue(['local::ses_1'])
    listInbox.mockResolvedValue([])
  })

  it('把未投递的 user 入队消息补成可见消息', async () => {
    listInbox.mockResolvedValue([
      { type: 'user', id: 'msg_a', payload: { text: '继续' }, time: { created: 1000 } },
    ])

    await recoverPendingInbox('local')

    expect(upsertUser).toHaveBeenCalledWith('local::ses_1', {
      messageId: 'msg_a',
      text: '继续',
      createdAt: 1000,
    })
  })

  it('跳过 synthetic / compaction / move 等内部条目', async () => {
    listInbox.mockResolvedValue([
      { type: 'synthetic', id: 'msg_s', payload: { text: '内部' }, time: { created: 1 } },
      { type: 'compaction', id: 'msg_c', payload: {}, time: { created: 2 } },
      { type: 'move', id: 'msg_m', payload: {}, time: { created: 3 } },
      { type: 'user', id: 'msg_u', payload: { text: '真实' }, time: { created: 4 } },
    ])

    await recoverPendingInbox('local')

    expect(upsertUser).toHaveBeenCalledOnce()
    expect(upsertUser.mock.calls[0][1].messageId).toBe('msg_u')
  })

  it('空文本的条目跳过（无可渲染内容）', async () => {
    listInbox.mockResolvedValue([{ type: 'user', id: 'msg_x', payload: { text: '' }, time: { created: 1 } }])
    await recoverPendingInbox('local')
    expect(upsertUser).not.toHaveBeenCalled()
  })

  it('没有已加载会话时不发请求', async () => {
    getKeys.mockReturnValue([])
    await recoverPendingInbox('local')
    expect(listInbox).not.toHaveBeenCalled()
  })

  it('单个会话失败不影响其它会话', async () => {
    getKeys.mockReturnValue(['local::ses_1', 'local::ses_2'])
    listInbox
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ type: 'user', id: 'msg_b', payload: { text: 'ok' }, time: { created: 5 } }])

    await recoverPendingInbox('local')

    expect(upsertUser).toHaveBeenCalledOnce()
    expect(upsertUser.mock.calls[0][0]).toBe('local::ses_2')
  })

  it('缺少 time 时用当前时间兜底', async () => {
    listInbox.mockResolvedValue([{ type: 'user', id: 'msg_t', payload: { text: 'x' } }])
    await recoverPendingInbox('local')
    expect(typeof upsertUser.mock.calls[0][1].createdAt).toBe('number')
  })
})
