import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * v2 事件流测试。
 *
 * v2 SDK 的 event.subscribe() 返回 AsyncIterable；这里用 AsyncGenerator 模拟，
 * 由测试逐条产出 v2 原生事件，断言适配层（v2/events.ts）与分发层（events.ts）
 * 归一后的回调载荷。
 */

const { subscribeMock, getV2ClientMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  getV2ClientMock: vi.fn(),
}))

vi.mock('./sdkV2', () => ({
  getV2Client: (...args: unknown[]) => getV2ClientMock(...args),
  getV2ClientAsync: (...args: unknown[]) => getV2ClientMock(...args),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'local',
    getApiVersion: () => 'v2',
    getServerBaseUrl: () => 'http://example.test',
    getServerAuth: () => undefined,
    getActiveAuth: () => undefined,
    onServerChange: () => () => {},
  },
  getUnifiedFetch: async () => globalThis.fetch,
  makeAuthHeader: () => ({}),
}))

/** 一条 v2 事件（SDK 的 envelope：{type, data, location, created}）。 */
function v2Event(type: string, data: Record<string, unknown>): unknown {
  return { type, data, location: { directory: '/repo' }, created: 1 }
}

/** 把若干 v2 事件包成 AsyncIterable，产出完即结束。 */
function source(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  subscribeMock.mockReset()
  getV2ClientMock.mockReset()
  getV2ClientMock.mockReturnValue({
    event: { subscribe: (...args: unknown[]) => subscribeMock(...args) },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('subscribeToEvents (v2 stream)', () => {
  it('maps session.text.delta while preserving multi-byte characters', async () => {
    subscribeMock.mockReturnValue(source([v2Event('session.text.delta', { sessionID: 'ses-1', assistantMessageID: 'msg-1', ordinal: 0, delta: '中文𠮷😀' })]))

    const { subscribeToEvents } = await import('./events')

    const received = await new Promise<string>((resolve, reject) => {
      const unsubscribe = subscribeToEvents({
        onPartDelta(data) {
          unsubscribe()
          resolve(data.delta)
        },
        onError(error) {
          unsubscribe()
          reject(error)
        },
      })
    })

    expect(received).toBe('中文𠮷😀')
  })

  it('dispatches server.connected with the server timestamp', async () => {
    subscribeMock.mockReturnValue(source([v2Event('server.connected', {})]))

    const { subscribeToEvents } = await import('./events')

    const received = await new Promise<unknown>((resolve) => {
      const unsubscribe = subscribeToEvents({
        onServerConnected(data) {
          unsubscribe()
          resolve(data)
        },
      })
    })

    expect(received).toMatchObject({ timestamp: 1 })
  })

  it('normalizes session.tool.success into a settled callback', async () => {
    subscribeMock.mockReturnValue(
      source([
        v2Event('session.tool.success', {
          sessionID: 'ses-1',
          callID: 'call-1',
          content: [
            { type: 'text', text: 'line one' },
            { type: 'text', text: 'line two' },
          ],
        }),
      ]),
    )

    const { subscribeToEvents } = await import('./events')

    const received = await new Promise<unknown>((resolve) => {
      const unsubscribe = subscribeToEvents({
        onNextToolSettled(data) {
          unsubscribe()
          resolve(data)
        },
      })
    })

    expect(received).toEqual({
      sessionID: 'ses-1',
      callID: 'call-1',
      status: 'completed',
      output: 'line one\nline two',
      metadata: undefined,
    })
  })

  it('normalizes session.tool.failed errors', async () => {
    subscribeMock.mockReturnValue(
      source([
        v2Event('session.tool.failed', {
          sessionID: 'ses-1',
          id: 'call-fail',
          error: { type: 'ToolError', message: 'exploded' },
        }),
      ]),
    )

    const { subscribeToEvents } = await import('./events')

    const received = await new Promise<unknown>((resolve) => {
      const unsubscribe = subscribeToEvents({
        onNextToolSettled(data) {
          unsubscribe()
          resolve(data)
        },
      })
    })

    expect(received).toEqual({
      sessionID: 'ses-1',
      callID: 'call-fail',
      status: 'error',
      error: 'exploded',
      metadata: undefined,
    })
  })

  it('reports connection state while the stream is open', async () => {
    // 一条永不结束的流：订阅保持 connected。
    subscribeMock.mockReturnValue({
      // 永不产出、也永不结束：模拟连接建立后一直待命。
      async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {
        await new Promise(() => {})
        yield* []
      },
    })

    const { subscribeToEvents, getConnectionInfo } = await import('./events')
    const unsubscribe = subscribeToEvents({})

    await vi.waitFor(() => expect(getConnectionInfo().state).toBe('connected'))
    unsubscribe()
  })
})
