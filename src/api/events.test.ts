import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventTypes } from '../types/api/event'

vi.mock('./http', () => ({
  getApiBaseUrl: () => 'http://example.test',
  getAuthHeader: () => ({}),
}))

vi.mock('../utils/tauri', () => ({
  isTauri: () => false,
}))

// 订阅路径会先确认 API 版本：这里让版本已知（v1），SSE 走原同步 connect 分支，
// 测试只断言事件解析，不掺入探测时序。
vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'local',
    getApiVersion: () => 'v1',
    ensureApiVersion: vi.fn(() => Promise.resolve('v1' as const)),
    onServerChange: () => () => {},
  },
}))

const encoder = new TextEncoder()

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(total)
  let offset = 0

  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }

  return result
}

function createEventChunks(delta: string, splitAt: number): Uint8Array[] {
  const marker = '__DELTA__'
  const raw = `data: ${JSON.stringify({
    directory: 'global',
    payload: {
      type: EventTypes.MESSAGE_PART_DELTA,
      properties: {
        messageID: 'session-1',
        partID: 'part-1',
        field: 'text',
        delta: marker,
      },
    },
  })}\n\n`

  const [before, after] = raw.split(marker)
  const deltaBytes = encoder.encode(delta)

  return [
    concatBytes(encoder.encode(before), deltaBytes.slice(0, splitAt)),
    concatBytes(deltaBytes.slice(splitAt), encoder.encode(after)),
  ]
}

function createStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

function createFetchResponse(chunks: Uint8Array[]): Pick<Response, 'ok' | 'body'> {
  return {
    ok: true,
    body: createStream(chunks) as Response['body'],
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createEventChunk(payload: object): Uint8Array[] {
  return [encoder.encode(`data: ${JSON.stringify({ directory: 'global', payload })}\n\n`)]
}

describe('subscribeToEvents', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('preserves Chinese text when UTF-8 bytes are split across chunks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse(createEventChunks('中文', 2)))
    vi.stubGlobal('fetch', fetchMock)

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

    expect(received).toBe('中文')
  })

  it('preserves four-byte characters when split in the middle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createFetchResponse(createEventChunks('𠮷😀', 3)))
    vi.stubGlobal('fetch', fetchMock)

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

    expect(received).toBe('𠮷😀')
  })

  it('dispatches server.connected payloads with timestamp', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse(
        createEventChunk({
          type: EventTypes.SERVER_CONNECTED,
          properties: { timestamp: '2026-04-22T15:00:00.000Z' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { subscribeToEvents } = await import('./events')

    const received = await new Promise<unknown>((resolve, reject) => {
      const unsubscribe = subscribeToEvents({
        onServerConnected(data) {
          unsubscribe()
          resolve(data.timestamp)
        },
        onError(error) {
          unsubscribe()
          reject(error)
        },
      })
    })

    expect(received).toBe('2026-04-22T15:00:00.000Z')
  })

  it('normalizes session.next.tool.success into a settled callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse(
        createEventChunk({
          type: EventTypes.SESSION_NEXT_TOOL_SUCCESS,
          properties: {
            sessionID: 'session-1',
            callID: 'call-1',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { subscribeToEvents } = await import('./events')

    const received = await new Promise<unknown>((resolve, reject) => {
      const unsubscribe = subscribeToEvents({
        onNextToolSettled(data) {
          unsubscribe()
          resolve(data)
        },
        onError(error) {
          unsubscribe()
          reject(error)
        },
      })
    })

    expect(received).toEqual({
      sessionID: 'session-1',
      callID: 'call-1',
      status: 'completed',
      output: 'line one\nline two',
    })
  })

  it('normalizes session.next.shell.ended output and session.next.tool.failed errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse([
        ...createEventChunk({
          type: EventTypes.SESSION_NEXT_SHELL_ENDED,
          properties: { sessionID: 'session-1', callID: 'call-shell', output: 'done' },
        }),
        ...createEventChunk({
          type: EventTypes.SESSION_NEXT_TOOL_FAILED,
          properties: { sessionID: 'session-1', callID: 'call-fail', error: { name: 'Boom', message: 'exploded' } },
        }),
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { subscribeToEvents } = await import('./events')
    const received: unknown[] = []

    subscribeToEvents({
      onNextToolSettled(data) {
        received.push(data)
      },
    })

    await vi.waitFor(() => {
      expect(received).toEqual([
        { sessionID: 'session-1', callID: 'call-shell', status: 'completed', output: 'done' },
        { sessionID: 'session-1', callID: 'call-fail', status: 'error', error: 'exploded' },
      ])
    })
  })

  it('ignores stale server.connected events from an old browser SSE generation after reconnect', async () => {    const firstFetch = createDeferred<Pick<Response, 'ok' | 'body'>>()
    const secondFetch = createDeferred<Pick<Response, 'ok' | 'body'>>()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstFetch.promise)
      .mockImplementationOnce(() => secondFetch.promise)
    vi.stubGlobal('fetch', fetchMock)

    const { subscribeToEvents, reconnectSSE } = await import('./events')
    const received: string[] = []

    const unsubscribe = subscribeToEvents({
      onServerConnected(data) {
        if (typeof data.timestamp === 'string') {
          received.push(data.timestamp)
        }
      },
    })

    reconnectSSE()

    secondFetch.resolve(
      createFetchResponse(
        createEventChunk({
          type: EventTypes.SERVER_CONNECTED,
          properties: { timestamp: 'new-server-time' },
        }),
      ),
    )

    await vi.waitFor(() => {
      expect(received).toEqual(['new-server-time'])
    })

    firstFetch.resolve(
      createFetchResponse(
        createEventChunk({
          type: EventTypes.SERVER_CONNECTED,
          properties: { timestamp: 'stale-server-time' },
        }),
      ),
    )

    await Promise.resolve()
    await Promise.resolve()

    expect(received).toEqual(['new-server-time'])
    unsubscribe()
  })

  it('ignores stale browser fetch failures from an old SSE generation after reconnect', async () => {
    const firstFetch = createDeferred<Pick<Response, 'ok' | 'body'>>()
    const secondFetch = createDeferred<Pick<Response, 'ok' | 'body'>>()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstFetch.promise)
      .mockImplementationOnce(() => secondFetch.promise)
    vi.stubGlobal('fetch', fetchMock)

    const { subscribeToEvents, reconnectSSE, getConnectionInfo } = await import('./events')
    const onError = vi.fn()

    const unsubscribe = subscribeToEvents({
      onError,
    })

    reconnectSSE()

    firstFetch.reject(new Error('stale failure'))

    await Promise.resolve()
    await Promise.resolve()

    expect(onError).not.toHaveBeenCalled()
    expect(getConnectionInfo().state).toBe('connecting')

    secondFetch.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    unsubscribe()
  })

  it('aborts the previous stream when the heartbeat-timeout path reconnects (no double-append)', async () => {
    vi.useFakeTimers()
    try {
      // 一条永不结束的流：reader 停在 read() 上，模拟持续连接但暂无事件。
      const firstSignals: AbortSignal[] = []
      const openStream = () =>
        new ReadableStream<Uint8Array>({ start() { /* 不 close，保持挂起 */ } })
      const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) firstSignals.push(init.signal)
        return Promise.resolve({ ok: true, body: openStream() })
      })
      vi.stubGlobal('fetch', fetchMock)

      const { subscribeToEvents } = await import('./events')
      const unsubscribe = subscribeToEvents({})

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const firstSignal = firstSignals[0]
      expect(firstSignal?.aborted).toBe(false)

      // 心跳超时（HEARTBEAT_TIMEOUT=60s）→ scheduleReconnect（首次退避 1s）→ connectServer。
      // 这条路径不经过 reconnectServerSSE，正是此前漏掉 generation++/abort、留下并发双流的路径。
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.advanceTimersByTimeAsync(1_000)

      // 旧流的 controller 必须被 abort（否则两条流并存，同一条 delta 被追加两次 → 正文成倍重复）
      expect(firstSignal.aborted).toBe(true)
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })
})
