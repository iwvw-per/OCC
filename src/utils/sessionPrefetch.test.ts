import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSessionMock, getSessionTurnPageMock, messageStoreMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionTurnPageMock: vi.fn(),
  messageStoreMock: {
    getSessionState: vi.fn(),
    setMessages: vi.fn(),
    getRevertGeneration: vi.fn(() => 0),
  },
}))

vi.mock('../api', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  getSessionTurnPage: (...args: unknown[]) => getSessionTurnPageMock(...args),
}))

vi.mock('../store/messageStore', () => ({
  messageStore: messageStoreMock,
}))

import { prefetchSessionMessages, resetSessionPrefetch } from './sessionPrefetch'

describe('sessionPrefetch', () => {
  beforeEach(() => {
    resetSessionPrefetch()
    getSessionMock.mockReset()
    getSessionTurnPageMock.mockReset()
    messageStoreMock.getSessionState.mockReset()
    messageStoreMock.setMessages.mockReset()
    messageStoreMock.getRevertGeneration.mockReset()
    messageStoreMock.getRevertGeneration.mockReturnValue(0)

    messageStoreMock.getSessionState.mockReturnValue(null)
    getSessionMock.mockResolvedValue({ id: 'session-1', directory: '/workspace/demo' })
    getSessionTurnPageMock.mockResolvedValue({
      messages: [{ info: { id: 'm1' } }],
      nextCursor: 'cursor-1',
      hasMore: true,
    })
  })

  it('seeds the message store with the first page', async () => {
    prefetchSessionMessages('session-1', '/workspace/demo', 'server-1')
    await vi.waitFor(() => expect(messageStoreMock.setMessages).toHaveBeenCalledTimes(1))

    const [key, messages, options] = messageStoreMock.setMessages.mock.calls[0]
    expect(key).toBe('server-1::session-1')
    expect(messages).toHaveLength(1)
    expect(options).toMatchObject({ directory: '/workspace/demo', historyCursor: 'cursor-1', hasMoreHistory: true })
  })

  it('skips prefetch when the session already has content', () => {
    messageStoreMock.getSessionState.mockReturnValue({ messages: [{ info: { id: 'm1' } }], loadState: 'idle' })
    prefetchSessionMessages('session-1', '/workspace/demo', 'server-1')
    expect(getSessionTurnPageMock).not.toHaveBeenCalled()
  })

  it('skips prefetch when the session is already loaded', () => {
    messageStoreMock.getSessionState.mockReturnValue({ messages: [], loadState: 'loaded' })
    prefetchSessionMessages('session-1', '/workspace/demo', 'server-1')
    expect(getSessionTurnPageMock).not.toHaveBeenCalled()
  })

  it('does not overwrite when the session loads during the prefetch', async () => {
    let resolvePage: (value: unknown) => void = () => {}
    getSessionTurnPageMock.mockReturnValue(
      new Promise(resolve => {
        resolvePage = resolve
      }),
    )

    prefetchSessionMessages('session-1', '/workspace/demo', 'server-1')
    // 请求在途期间，正常加载路径已把会话填好
    messageStoreMock.getSessionState.mockReturnValue({ messages: [{ info: { id: 'm2' } }], loadState: 'loaded' })

    resolvePage({ messages: [{ info: { id: 'm1' } }] })
    await vi.waitFor(() => expect(getSessionTurnPageMock).toHaveBeenCalled())

    expect(messageStoreMock.setMessages).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent prefetches for the same session', () => {
    prefetchSessionMessages('session-1', '/workspace/demo', 'server-1')
    prefetchSessionMessages('session-1', '/workspace/demo', 'server-1')
    expect(getSessionTurnPageMock).toHaveBeenCalledTimes(1)
  })

  it('swallows prefetch failures', async () => {
    getSessionTurnPageMock.mockRejectedValue(new Error('network down'))
    prefetchSessionMessages('session-1', '/workspace/demo', 'server-1')
    await vi.waitFor(() => expect(getSessionTurnPageMock).toHaveBeenCalledTimes(1))
    expect(messageStoreMock.setMessages).not.toHaveBeenCalled()
  })
})
