import { beforeEach, describe, expect, it, vi } from 'vitest'

const { nativeListMessagesMock, adaptPageMock } = vi.hoisted(() => ({
  adaptPageMock: vi.fn(),
  nativeListMessagesMock: vi.fn(),
}))

vi.mock('./v2/message', () => ({
  adaptMessagePage: (...args: unknown[]) => adaptPageMock(...args),
}))

vi.mock('./v2NativeMessage', () => ({
  nativeListMessages: (...args: unknown[]) => nativeListMessagesMock(...args),
  nativePrompt: vi.fn(),
}))

vi.mock('./sdk', () => ({
  buildHeaders: () => ({}),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'srv',
    getServerBaseUrl: (serverId: string) => `https://${serverId}.example.com`,
    getServerAuth: () => undefined,
    getActiveAuth: () => undefined,
  },
  makeAuthHeader: () => ({}),
  getUnifiedFetch: async () => globalThis.fetch,
}))

vi.mock('../utils/sessionKey', () => ({
  resolveSessionTarget: (sessionId: string, serverId?: string) => ({ sessionId, serverId: serverId ?? 'srv' }),
}))

vi.mock('../utils/directoryUtils', () => ({
  formatPathForApi: (dir?: string) => dir,
  directoryCacheKey: (dir?: string | null) => dir ?? '',
}))

const { storageMock } = vi.hoisted(() => {
  const data = new Map<string, unknown>()
  return {
    storageMock: {
      data,
      getJSONFor: vi.fn((key: string, serverId: string) => data.get(`${serverId}:${key}`)),
      setJSONFor: vi.fn((key: string, value: unknown, serverId: string) => {
        data.set(`${serverId}:${key}`, value)
      }),
    },
  }
})

vi.mock('../utils/perServerStorage', () => ({ serverStorage: storageMock }))

beforeEach(() => {
  nativeListMessagesMock.mockReset()
})

import {
  getSessionMessagePage,
  getSessionMessages,
  getSessionTurnPage,
  getSessionFirstScreen,
  encodeMessageCursor,
  decodeMessageCursor,
  encodeV2MessageCursor,
  encodeBeforeCursor,
  probeLightweightSupport,
  resetLightweightSupportCache,
  getSessionLightweightMessages,
  resetLightweightInflight,
} from './message'

type AnyMessage = {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

function envelope(overrides: Partial<AnyMessage> = {}): AnyMessage {
  return {
    info: { id: 'msg-1', sessionID: 'ses-1', role: 'user', time: { created: 1 } },
    parts: [],
    ...overrides,
  }
}

describe('getSessionMessagePage projection', () => {
  beforeEach(() => {
    nativeListMessagesMock.mockReset()
  })

  /** nativeListMessages 返回升序消息 + 游标（已是适配后的内部形状）。 */
  function nativePage(messages: AnyMessage[], nextCursor?: string, compactedAt?: number) {
    nativeListMessagesMock.mockResolvedValue({ messages, nextCursor, compactedAt })
  }

  it('strips summary.diffs while keeping the rest of summary', async () => {
    nativePage([
      envelope({
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'user',
          time: { created: 1 },
          summary: { title: 'Keep me', diffs: [{ file: 'a.ts', patch: 'x'.repeat(5000) }] },
        },
      }),
    ])

    const page = await getSessionMessagePage('ses-1', 50)

    const summary = page.messages[0].info.summary as Record<string, unknown>
    expect(summary.title).toBe('Keep me')
    expect(summary.diffs).toBeUndefined()
  })

  it('strips tool state.attachments but keeps output and error', async () => {
    nativePage([
      envelope({
        parts: [
          {
            id: 'prt-1',
            type: 'tool',
            tool: 'read',
            state: {
              status: 'completed',
              output: 'file contents',
              attachments: [{ id: 'att-1', url: 'data:image/png;base64,' + 'A'.repeat(4000) }],
            },
          },
        ],
      }),
    ])

    const page = await getSessionMessagePage('ses-1', 50)

    const state = (page.messages[0].parts[0] as unknown as { state: Record<string, unknown> }).state
    expect(state.attachments).toBeUndefined()
    expect(state.output).toBe('file contents')
    expect(state.status).toBe('completed')
  })

  it('leaves messages without heavy fields untouched', async () => {
    const original = envelope({
      parts: [{ id: 'prt-1', type: 'text', text: 'hello' }],
    })
    nativePage([original])

    const page = await getSessionMessagePage('ses-1', 50)

    expect(page.messages[0]).toBe(original)
  })

  it('passes through the cursor from native page', async () => {
    nativePage([envelope()], 'cursor-abc')

    const page = await getSessionMessagePage('ses-1', 50, 'cursor-prev')

    expect(page.nextCursor).toBe('cursor-abc')
    expect(nativeListMessagesMock).toHaveBeenCalledWith(
      'srv',
      expect.objectContaining({ sessionID: 'ses-1', limit: 50, cursor: 'cursor-prev' }),
    )
  })

  it('skips projection when project:false so summary.diffs survives', async () => {
    nativePage([
      envelope({
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'user',
          time: { created: 1 },
          summary: { title: 'Keep me', diffs: [{ file: 'a.ts', patch: 'diff-body' }] },
        },
      }),
    ])

    const messages = await getSessionMessages('ses-1', 50, undefined, undefined, { project: false })

    const summary = messages[0].info.summary as Record<string, unknown>
    expect(summary.diffs).toEqual([{ file: 'a.ts', patch: 'diff-body' }])
  })
})

function userMsg(index: number): AnyMessage {
  return {
    info: { id: `user-${index}`, sessionID: 'ses-1', role: 'user', time: { created: index } },
    parts: [],
  }
}

function assistantMsg(index: number): AnyMessage {
  return {
    info: { id: `asst-${index}`, sessionID: 'ses-1', role: 'assistant', time: { created: index } },
    parts: [],
  }
}

describe('encodeMessageCursor', () => {
  it('encodes {id,time} as base64url and is decodable by the server format', () => {
    const message = envelope({
      info: { id: 'msg-1', sessionID: 'ses-1', role: 'user', time: { created: 1234 } },
    })
    const cursor = encodeMessageCursor(message as never)
    expect(cursor).not.toContain('=')
    const json = decodeURIComponent(
      atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    )
    expect(JSON.parse(json)).toEqual({ id: 'msg-1', time: 1234 })
  })

  it('offsets time by +1 when inclusive so the message itself is included', () => {
    const message = envelope({
      info: { id: 'msg-1', sessionID: 'ses-1', role: 'user', time: { created: 1234 } },
    })
    const cursor = encodeMessageCursor(message as never, true)
    const json = decodeURIComponent(
      atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    )
    expect(JSON.parse(json)).toEqual({ id: 'msg-1', time: 1235 })
  })

  // 跨版本隐式契约回归：编码 → 解码必须往返一致。
  // 上游若更改游标结构（换字段、加签名、改序列化），这里会失败，
  // 提示「客户端本地构造的游标可能不再被服务端接受」。
  it('round-trips through decodeMessageCursor (cross-version contract)', () => {
    const message = envelope({
      info: { id: 'ses-1/msg-42', sessionID: 'ses-1', role: 'user', time: { created: 1_700_000_000_123 } },
    })

    expect(decodeMessageCursor(encodeMessageCursor(message as never))).toEqual({
      id: 'ses-1/msg-42',
      time: 1_700_000_000_123,
    })
    expect(decodeMessageCursor(encodeMessageCursor(message as never, true))).toEqual({
      id: 'ses-1/msg-42',
      time: 1_700_000_000_124,
    })
  })

  it('decodeMessageCursor returns undefined for malformed input instead of throwing', () => {
    // 上游改编码后，诊断工具应降级而不是把调用方打断
    expect(decodeMessageCursor('not-a-cursor')).toBeUndefined()
    expect(decodeMessageCursor('')).toBeUndefined()
    expect(decodeMessageCursor(btoa('{"id":1}'))).toBeUndefined()
  })
})

function decodeCursorJson(cursor: string): unknown {
  const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return JSON.parse(atob(padded))
}

describe('encodeV2MessageCursor', () => {
  it('encodes {id,order,direction:next} as base64url (v2 server format)', () => {
    const message = envelope({
      info: { id: 'msg-9', sessionID: 'ses-1', role: 'user', time: { created: 1234 } },
    })
    const cursor = encodeV2MessageCursor(message as never)
    expect(cursor).not.toContain('=')
    expect(decodeCursorJson(cursor)).toEqual({ id: 'msg-9', order: 'desc', direction: 'next' })
  })

  it('supports the newer-side direction', () => {
    const message = envelope({
      info: { id: 'msg-9', sessionID: 'ses-1', role: 'user', time: { created: 1234 } },
    })
    expect(decodeCursorJson(encodeV2MessageCursor(message as never, 'previous'))).toEqual({
      id: 'msg-9',
      order: 'desc',
      direction: 'previous',
    })
  })

  it('is NOT the v1 format (a v2 server rejects {id,time})', () => {
    const message = envelope({
      info: { id: 'msg-9', sessionID: 'ses-1', role: 'user', time: { created: 1234 } },
    })
    expect(decodeCursorJson(encodeV2MessageCursor(message as never))).not.toHaveProperty('time')
    expect(decodeCursorJson(encodeMessageCursor(message as never))).toEqual({ id: 'msg-9', time: 1234 })
  })
})

describe('encodeBeforeCursor', () => {
  it('uses the v2 {id,order,direction} cursor', () => {
    const message = envelope({
      info: { id: 'msg-9', sessionID: 'ses-1', role: 'user', time: { created: 1234 } },
    })
    expect(decodeCursorJson(encodeBeforeCursor(message as never, 'srv-1'))).toEqual({
      id: 'msg-9',
      order: 'desc',
      direction: 'next',
    })
  })
})

describe('getSessionFirstScreen', () => {
  /**
   * 首屏必须「先出内容」：用小页拿到第一批就返回，剩余轮次由 rest() 后台补齐。
   * 大会话一次取 200 条要 536KB，而 3 轮通常只需几十条 —— 这是首屏慢的主因。
   */
  it('returns a small first page and exposes rest() when turns are not enough', async () => {
    // 第一页只有 1 轮（尾部），未达 2 轮目标
    nativeListMessagesMock
      .mockResolvedValueOnce({ messages: [userMsg(3), assistantMsg(3)], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ messages: [userMsg(1), assistantMsg(1), userMsg(2), assistantMsg(2)], nextCursor: 'cursor-2' })

    const first = await getSessionFirstScreen('ses-1', 2)

    // 第一段只发一次请求，且用的是小页上限
    expect(nativeListMessagesMock).toHaveBeenCalledTimes(1)
    expect(nativeListMessagesMock).toHaveBeenNthCalledWith(
      1,
      'srv',
      expect.objectContaining({ sessionID: 'ses-1', cursor: undefined }),
    )
    expect(first.complete).toBe(false)
    expect(first.messages).toHaveLength(2)
    expect(typeof first.rest).toBe('function')

    const rest = await first.rest!()
    // 补齐后按时间升序拼接，且游标以更早那段为准
    expect(rest.messages.map(m => m.info.id)).toEqual([
      'user-1',
      'asst-1',
      'user-2',
      'asst-2',
      'user-3',
      'asst-3',
    ])
    expect(rest.nextCursor).toBe('cursor-2')
  })

  it('marks the first page complete when the target turns are already covered', async () => {
    nativeListMessagesMock.mockResolvedValueOnce({
      messages: [userMsg(1), assistantMsg(1), userMsg(2), assistantMsg(2)],
      nextCursor: 'cursor-1',
    })

    const first = await getSessionFirstScreen('ses-1', 2)
    expect(first.complete).toBe(true)
    expect(first.rest).toBeUndefined()
    expect(nativeListMessagesMock).toHaveBeenCalledTimes(1)
  })
})

describe('getSessionTurnPage', () => {
  beforeEach(() => {
    nativeListMessagesMock.mockReset()
  })

  it('keeps pulling older pages until the target turn count is met', async () => {
    // 第一页：只有 1 个 user（尾部），未达 2 轮 → 继续往前拉
    const page1 = [assistantMsg(1), assistantMsg(2), userMsg(3)]
    const page2 = [userMsg(1), assistantMsg(2), assistantMsg(3)]
    nativeListMessagesMock
      .mockResolvedValueOnce({ messages: page1, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ messages: page2, nextCursor: 'cursor-2' })

    const result = await getSessionTurnPage('ses-1', 2)

    expect(nativeListMessagesMock).toHaveBeenCalledTimes(2)
    expect(nativeListMessagesMock).toHaveBeenNthCalledWith(
      1,
      'srv',
      expect.objectContaining({ sessionID: 'ses-1', limit: 200, cursor: undefined }),
    )
    expect(nativeListMessagesMock).toHaveBeenNthCalledWith(
      2,
      'srv',
      expect.objectContaining({ sessionID: 'ses-1', limit: 200, cursor: 'cursor-1' }),
    )
    // 按时间升序拼接：page2 在 page1 之前
    expect(result.messages.map(m => m.info.id)).toEqual(['user-1', 'asst-2', 'asst-3', 'asst-1', 'asst-2', 'user-3'])
    expect(result.nextCursor).toBe('cursor-2')
    expect(result.hasMore).toBe(true)
  })

  it('stops when the target turn count is already met in one page', async () => {
    const page = [userMsg(1), assistantMsg(1), userMsg(2), assistantMsg(2)]
    nativeListMessagesMock.mockResolvedValueOnce({ messages: page, nextCursor: 'cursor-1' })

    const result = await getSessionTurnPage('ses-1', 2)

    expect(nativeListMessagesMock).toHaveBeenCalledTimes(1)
    expect(result.messages).toHaveLength(4)
    expect(result.nextCursor).toBe('cursor-1')
    expect(result.hasMore).toBe(true)
  })

  it('reports no more history when the server omits the cursor on a short page', async () => {
    const page = [userMsg(1), assistantMsg(1)]
    nativeListMessagesMock.mockResolvedValueOnce({ messages: page, nextCursor: undefined })

    const result = await getSessionTurnPage('ses-1', 3)

    expect(result.nextCursor).toBeUndefined()
    expect(result.hasMore).toBe(false)
  })

  it('a full page without a cursor means no more history', async () => {
    const page = Array.from({ length: 30 }, (_, index) => userMsg(index))
    nativeListMessagesMock.mockResolvedValue({ messages: page, nextCursor: undefined })

    const result = await getSessionTurnPage('ses-1', 3)

    expect(result.hasMore).toBe(false)
  })

  it('bounds the number of internal pages for pathologically long turns', async () => {
    const fullPage = () => Array.from({ length: 30 }, (_, index) => assistantMsg(index))
    nativeListMessagesMock.mockResolvedValue({ messages: fullPage(), nextCursor: 'cursor-x' })

    const result = await getSessionTurnPage('ses-1', 5)

    // 单轮几千条：最多 TURN_FETCH_MAX_PAGES 页就停，交给上滑继续加载
    expect(nativeListMessagesMock).toHaveBeenCalledTimes(4)
    expect(result.messages).toHaveLength(120)
    expect(result.hasMore).toBe(true)
  })

  it('an empty page with a residual next cursor stops and clears the cursor', async () => {
    nativeListMessagesMock
      .mockResolvedValueOnce({ messages: [userMsg(1)], nextCursor: 'c1' })
      .mockResolvedValueOnce({ messages: [], nextCursor: 'c2' })

    const result = await getSessionTurnPage('ses-1', 3)

    expect(nativeListMessagesMock).toHaveBeenCalledTimes(2)
    // 空页即到最早：不再把残留游标当「还有历史」，并清掉游标避免继续触发加载
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBeUndefined()
  })
})

describe('probeLightweightSupport', () => {
  beforeEach(() => {
    storageMock.data.clear()
    storageMock.getJSONFor.mockClear()
    storageMock.setJSONFor.mockClear()
    resetLightweightSupportCache()
  })

  it('persists a positive probe result and reuses it without a network call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'X-Lightweight': '1' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const first = await probeLightweightSupport('ses-1', '/dir', 'srv-1')
    expect(first).toBe(true)
    expect(storageMock.setJSONFor).toHaveBeenCalled()

    // 清内存缓存后应从持久化读取，不再发请求
    resetLightweightSupportCache()
    fetchMock.mockClear()
    const second = await probeLightweightSupport('ses-1', '/dir', 'srv-1')
    expect(second).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not persist a negative probe result and re-probes after restart', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await probeLightweightSupport('ses-1', '/dir', 'srv-2')
    expect(first).toBe(false)
    // 负结果不落盘：Agent 升级后能下次冷启动重探
    expect(storageMock.setJSONFor).not.toHaveBeenCalled()

    resetLightweightSupportCache()
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(new Response('[]', { status: 200, headers: { 'X-Lightweight': '1' } }))
    const second = await probeLightweightSupport('ses-1', '/dir', 'srv-2')
    expect(second).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('does not persist when the probe request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const result = await probeLightweightSupport('ses-1', '/dir', 'srv-3')
    expect(result).toBe(false)
    expect(storageMock.setJSONFor).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('cancels the response body so the probe never downloads the whole session', async () => {
    // 主机 Agent 实现轻量投影时**忽略 limit**：任何带 X-Lightweight 的消息
    // 请求都返回整个会话（实测 4810 条消息 = 25MB）。我们只要一个响应头，
    // 所以必须立刻 cancel 掉 body，否则「探测支持与否」本身就要下载 25MB。
    const cancel = vi.fn().mockResolvedValue(undefined)
    const response = new Response('[]', { status: 200, headers: { 'X-Lightweight': '1' } })
    Object.defineProperty(response, 'body', { value: { cancel }, configurable: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const supported = await probeLightweightSupport('ses-1', '/dir', 'srv-cancel')
    expect(supported).toBe(true)
    expect(cancel).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('getSessionLightweightMessages in-flight dedup (StrictMode)', () => {
  /** 裸 fetch 的响应体交给 adaptMessagePage 适配，这里直接桩掉适配层。 */
  function v2User() {
    return { data: [{ id: 'msg-1', sessionID: 'ses-1', type: 'user', text: 'hi', time: { created: 1 } }] }
  }

  beforeEach(() => {
    storageMock.data.clear()
    resetLightweightInflight()
    adaptPageMock.mockReset()
    adaptPageMock.mockReturnValue({
      messages: [{ info: { id: 'msg-1', role: 'user' }, parts: [] }],
    })
  })

  it('sends only one network request for concurrent same-session calls', async () => {
    // React StrictMode 会把 effect 跑两次：同一会话的轻量请求并发发出两次。
    // 单次响应可达 MB 级，必须合并在途请求。
    const fetchMock = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify([v2User()]), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([
      getSessionLightweightMessages('ses-1', '/dir', 'srv'),
      getSessionLightweightMessages('ses-1', '/dir', 'srv'),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a.messages).toHaveLength(1)
    expect(b.messages).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('does not share the caller abort signal, so one abort cannot kill the other', async () => {
    let release!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>(resolve => {
          release = resolve
        }),
      ),
    )

    const controller = new AbortController()
    const aborted = getSessionLightweightMessages('ses-1', '/dir', 'srv', { signal: controller.signal })
    const survivor = getSessionLightweightMessages('ses-1', '/dir', 'srv')

    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })

    // 底层共享请求不受影响，另一个调用方仍能拿到数据
    release(new Response(JSON.stringify([v2User()]), { status: 200 }))
    await expect(survivor).resolves.toMatchObject({ messages: [expect.anything()] })
    vi.unstubAllGlobals()
  })

  it('issues a fresh request after the previous one settles', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify([v2User()]), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getSessionLightweightMessages('ses-1', '/dir', 'srv')
    await getSessionLightweightMessages('ses-1', '/dir', 'srv')

    // 只合并在途，不做缓存：请求结束后应重新拉取
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })

  it('rejects immediately when the caller signal is already aborted', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify([v2User()]), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await expect(
      getSessionLightweightMessages('ses-1', '/dir', 'srv', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
