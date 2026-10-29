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
    subscribeMock.mockReturnValue(
      source([
        v2Event('session.text.delta', {
          sessionID: 'ses-1',
          assistantMessageID: 'msg-1',
          ordinal: 0,
          delta: '中文𠮷😀',
        }),
      ]),
    )

    const { subscribeToEvents } = await import('./events')

    const received = await new Promise<string>((resolve, reject) => {
      const unsubscribe = subscribeToEvents({
        onPartDelta(data) {
          unsubscribe()
          resolve(data.delta ?? '')
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

    const received = await new Promise<unknown>(resolve => {
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

    const received = await new Promise<unknown>(resolve => {
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

    const received = await new Promise<unknown>(resolve => {
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

describe('心跳活性（onActivity 含注释心跳帧）', () => {
  it('订阅时传入 onActivity，让不带 data 的注释心跳也能续命', async () => {
    /**
     * 回归：服务端空闲期只发 `: heartbeat` 注释帧（实测约 15s 一次），
     * 而 SDK 的 SSE 解析器只在 data 非空时 yield —— 注释帧不进 for-await。
     * 若订阅时不传 onActivity，空闲会话会在 HEARTBEAT_TIMEOUT(60s) 后被
     * 误判为断连并重连，白白打断连接、触发一轮全量对账。
     */
    subscribeMock.mockReturnValue({
      async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {
        await new Promise(() => {})
        yield* []
      },
    })

    const { subscribeToEvents } = await import('./events')
    const unsubscribe = subscribeToEvents({})

    await vi.waitFor(() => expect(subscribeMock).toHaveBeenCalled())
    const options = subscribeMock.mock.calls[0][0] as { onActivity?: () => void }
    expect(typeof options.onActivity).toBe('function')
    unsubscribe()
  })

  it('onActivity 可安全重复调用（不会抛错、不会重复建连接）', async () => {
    subscribeMock.mockReturnValue({
      async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {
        await new Promise(() => {})
        yield* []
      },
    })

    const { subscribeToEvents, getConnectionInfo } = await import('./events')
    const unsubscribe = subscribeToEvents({})

    await vi.waitFor(() => expect(getConnectionInfo().state).toBe('connected'))
    const options = subscribeMock.mock.calls[0][0] as { onActivity: () => void }
    // 模拟连续多帧心跳
    expect(() => {
      options.onActivity()
      options.onActivity()
      options.onActivity()
    }).not.toThrow()
    // 状态仍应是 connected，且没有额外建立订阅
    expect(getConnectionInfo().state).toBe('connected')
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('取消订阅后旧代次的 onActivity 不再影响连接状态', async () => {
    subscribeMock.mockReturnValue({
      async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {
        await new Promise(() => {})
        yield* []
      },
    })

    const { subscribeToEvents, getConnectionInfo } = await import('./events')
    const unsubscribe = subscribeToEvents({})
    await vi.waitFor(() => expect(getConnectionInfo().state).toBe('connected'))
    const staleActivity = (subscribeMock.mock.calls[0][0] as { onActivity: () => void }).onActivity

    unsubscribe()
    // 旧连接已被代次作废：迟到的 onActivity 不应把状态改回 connected
    expect(() => staleActivity()).not.toThrow()
    expect(getConnectionInfo().state).not.toBe('connected')
  })
})

describe('seq 缺口检测（durable 事件序号）', () => {
  /** 构造带 durable 信封的 v2 事件 */
  function durableEvent(type: string, data: Record<string, unknown>, aggregateID: string, seq: number): unknown {
    return { type, data, location: { directory: '/repo' }, created: 1, durable: { aggregateID, seq, version: 1 } }
  }

  it('跳号的事件被丢弃，且触发一次缺口回调', async () => {
    /**
     * 场景：断连/背压期间丢了 seq 11–14，重连后直接收到 15。
     * 该会话的数据已不可信，必须丢弃这条事件并触发快照重拉，
     * 否则会把「缺了一段上下文」的状态写进 store。
     */
    subscribeMock.mockReturnValue(
      source([
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 10),
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 15), // 跳号
      ]),
    )

    const { subscribeToEvents, onSeqGap } = await import('./events')
    const gaps: Array<[string, string]> = []
    const offGap = onSeqGap((serverId, aggregateID) => gaps.push([serverId, aggregateID]))

    let applied = 0
    const unsubscribe = subscribeToEvents({
      onSessionStatus() {
        applied++
      },
    })

    await vi.waitFor(() => expect(gaps.length).toBe(1))
    expect(gaps[0]).toEqual(['local', 'ses-1'])
    // 只有 seq=10 那条被应用；跳号的 15 被丢弃
    expect(applied).toBe(1)
    offGap()
    unsubscribe()
  })

  it('连续序号全部正常应用，不触发缺口', async () => {
    subscribeMock.mockReturnValue(
      source([
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 1),
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 2),
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 3),
      ]),
    )

    const { subscribeToEvents, onSeqGap } = await import('./events')
    const gaps: string[] = []
    const offGap = onSeqGap((_s, a) => gaps.push(a))

    let applied = 0
    const unsubscribe = subscribeToEvents({ onSessionStatus: () => applied++ })

    await vi.waitFor(() => expect(applied).toBe(3))
    expect(gaps).toEqual([])
    offGap()
    unsubscribe()
  })

  it('ephemeral 事件（无 durable）不参与缺口检测', async () => {
    // delta / status 之类没有 seq，不能因为「没序号」就被当成缺口
    subscribeMock.mockReturnValue(
      source([
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 1),
        v2Event('session.text.delta', { sessionID: 'ses-1', assistantMessageID: 'm', ordinal: 0, delta: 'x' }),
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 2),
      ]),
    )

    const { subscribeToEvents, onSeqGap } = await import('./events')
    const gaps: string[] = []
    const offGap = onSeqGap((_s, a) => gaps.push(a))

    let applied = 0
    const unsubscribe = subscribeToEvents({ onSessionStatus: () => applied++ })

    await vi.waitFor(() => expect(applied).toBe(2))
    expect(gaps).toEqual([])
    offGap()
    unsubscribe()
  })

  it('ack 之后该会话重新从「首次见到」开始，不再反复报缺口', async () => {
    /**
     * 缺口修复（快照重拉）完成后必须 ack，否则后续每条事件都会被判为缺口，
     * 变成无限重拉。
     */
    subscribeMock.mockReturnValue(
      source([
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 10),
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 20), // gap
      ]),
    )

    const { subscribeToEvents, onSeqGap, ackSeqGap } = await import('./events')
    const gaps: string[] = []
    const offGap = onSeqGap((_s, a) => {
      gaps.push(a)
      // 模拟「重拉完成」：立即 ack
      ackSeqGap('local', a)
    })

    let applied = 0
    const unsubscribe = subscribeToEvents({ onSessionStatus: () => applied++ })

    await vi.waitFor(() => expect(gaps.length).toBe(1))
    expect(applied).toBe(1)
    offGap()
    unsubscribe()
  })

  it('缺口回调抛错不影响事件流', async () => {
    subscribeMock.mockReturnValue(
      source([
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 1),
        durableEvent('session.execution.started', { sessionID: 'ses-1' }, 'ses-1', 5), // gap
        durableEvent('session.execution.started', { sessionID: 'ses-2' }, 'ses-2', 1),
      ]),
    )

    const { subscribeToEvents, onSeqGap } = await import('./events')
    const offGap = onSeqGap(() => {
      throw new Error('observer boom')
    })

    let applied = 0
    const unsubscribe = subscribeToEvents({ onSessionStatus: () => applied++ })

    // ses-1 的 seq=1 与 ses-2 的 seq=1 都应被应用；中间的 gap 被丢弃
    await vi.waitFor(() => expect(applied).toBe(2))
    offGap()
    unsubscribe()
  })
})

describe('背压溢出（subscriber 队列满）', () => {
  it('溢出错误走立即重连，而不是退避', async () => {
    /**
     * SDK 的 subscriber 队列满（4096 条）时会抛
     * `Event subscriber exceeded its 4096-event capacity` 并停掉整条连接。
     * 这不是网络/服务端故障，而是本地消费不过来 —— 退避只会让积压更久。
     */
    const overflow = new Error('Event subscriber exceeded its 4096-event capacity')
    let call = 0
    subscribeMock.mockImplementation(() => {
      call++
      if (call === 1) {
        return {
          // 抛错前先 yield 一次，避免 lint 认为生成器没有 yield
          async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {
            if (false as boolean) yield undefined as never
            throw overflow
          },
        }
      }
      // 第二次订阅：保持连接
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {
          await new Promise(() => {})
          yield* []
        },
      }
    })

    const { subscribeToEvents } = await import('./events')
    const details: string[] = []
    const unsubscribe = subscribeToEvents({ onBackpressure: d => details.push(d) })

    // 立即重连（不等待 1s 退避）：说明没有走 scheduleReconnect
    await vi.waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(2), { timeout: 500 })
    expect(details).toHaveLength(1)
    expect(details[0]).toMatch(/capacity/i)
    unsubscribe()
  })

  it('普通错误仍走 onError + 退避，不误判为背压', async () => {
    subscribeMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<never, void, void> {
        if (false as boolean) yield undefined as never
        throw new Error('Network connection lost')
      },
    }))

    const { subscribeToEvents } = await import('./events')
    const errors: string[] = []
    const backpressure: string[] = []
    const unsubscribe = subscribeToEvents({
      onError: e => errors.push(e.message),
      onBackpressure: d => backpressure.push(d),
    })

    await vi.waitFor(() => expect(errors.length).toBe(1))
    expect(errors[0]).toContain('Network connection lost')
    expect(backpressure).toEqual([])
    unsubscribe()
  })
})
