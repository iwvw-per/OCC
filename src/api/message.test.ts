import { beforeEach, describe, expect, it, vi } from 'vitest'

const { messagesMock, messageMock, getSDKClientMock, getApiVersionMock, getActiveServerIdMock } = vi.hoisted(() => ({
  messagesMock: vi.fn(),
  messageMock: vi.fn(),
  getSDKClientMock: vi.fn(),
  getApiVersionMock: vi.fn(),
  getActiveServerIdMock: vi.fn(),
}))

vi.mock('./sdk', () => ({
  getSDKClient: (...args: unknown[]) => getSDKClientMock(...args),
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error != null) throw result.error
    return result.data
  },
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getApiVersion: (...args: unknown[]) => getApiVersionMock(...args),
    getActiveServerId: (...args: unknown[]) => getActiveServerIdMock(...args),
  },
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
  // 版本探测按会话协议分支：默认未知（走 v1），用例内用 mockReturnValueOnce 覆盖，
  // 避免某个用例设的 'v2' 泄漏到后续用例。
  getApiVersionMock.mockReset()
  getApiVersionMock.mockReturnValue(undefined)
  getActiveServerIdMock.mockReset()
  getActiveServerIdMock.mockReturnValue('srv')
})

import {
  getSessionMessagePage,
  getSessionMessages,
  getSessionTurnPage,
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

function sdkResult(messages: AnyMessage[], nextCursor?: string) {
  return {
    data: messages,
    response: {
      headers: {
        get: (name: string) => (name === 'X-Next-Cursor' ? (nextCursor ?? null) : null),
      },
    },
  }
}

describe('getSessionMessagePage projection', () => {
  beforeEach(() => {
    messagesMock.mockReset()
    messageMock.mockReset()
    getSDKClientMock.mockReset()
    getSDKClientMock.mockReturnValue({
      session: { messages: messagesMock, message: messageMock },
    })
  })

  it('strips summary.diffs while keeping the rest of summary', async () => {
    messagesMock.mockResolvedValue(
      sdkResult([
        envelope({
          info: {
            id: 'msg-1',
            sessionID: 'ses-1',
            role: 'user',
            time: { created: 1 },
            summary: { title: 'Keep me', diffs: [{ file: 'a.ts', patch: 'x'.repeat(5000) }] },
          },
        }),
      ]),
    )

    const page = await getSessionMessagePage('ses-1', 50)

    const summary = page.messages[0].info.summary as Record<string, unknown>
    expect(summary.title).toBe('Keep me')
    expect(summary.diffs).toBeUndefined()
  })

  it('strips tool state.attachments but keeps output and error', async () => {
    messagesMock.mockResolvedValue(
      sdkResult([
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
      ]),
    )

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
    messagesMock.mockResolvedValue(sdkResult([original]))

    const page = await getSessionMessagePage('ses-1', 50)

    expect(page.messages[0]).toBe(original)
  })

  it('passes through the cursor from X-Next-Cursor', async () => {
    messagesMock.mockResolvedValue(sdkResult([envelope()], 'cursor-abc'))

    const page = await getSessionMessagePage('ses-1', 50, 'cursor-prev')

    expect(page.nextCursor).toBe('cursor-abc')
    expect(messagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'ses-1', limit: 50, before: 'cursor-prev' }),
    )
  })

  it('skips projection when project:false so summary.diffs survives', async () => {
    messagesMock.mockResolvedValue(
      sdkResult([
        envelope({
          info: {
            id: 'msg-1',
            sessionID: 'ses-1',
            role: 'user',
            time: { created: 1 },
            summary: { title: 'Keep me', diffs: [{ file: 'a.ts', patch: 'diff-body' }] },
          },
        }),
      ]),
    )

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

describe('encodeBeforeCursor (protocol-aware)', () => {
  it('uses the v1 {id,time} cursor for v1 servers', () => {
    getApiVersionMock.mockReturnValue('v1')
    const message = envelope({
      info: { id: 'msg-9', sessionID: 'ses-1', role: 'user', time: { created: 1234 } },
    })
    expect(decodeCursorJson(encodeBeforeCursor(message as never, 'srv-1'))).toEqual({
      id: 'msg-9',
      time: 1234,
    })
  })

  it('uses the v2 {id,order,direction} cursor for v2 servers', () => {
    getApiVersionMock.mockReturnValue('v2')
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

describe('getSessionTurnPage', () => {
  beforeEach(() => {
    messagesMock.mockReset()
    messageMock.mockReset()
    getSDKClientMock.mockReset()
    getSDKClientMock.mockReturnValue({
      session: { messages: messagesMock, message: messageMock },
    })
  })

  it('keeps pulling older pages until the target turn count is met', async () => {
    // 第一页：只有 1 个 user（尾部），未达 2 轮 → 继续往前拉
    const page1 = [assistantMsg(1), assistantMsg(2), userMsg(3)]
    const page2 = [userMsg(1), assistantMsg(2), assistantMsg(3)]
    messagesMock
      .mockResolvedValueOnce(sdkResult(page1, 'cursor-1'))
      .mockResolvedValueOnce(sdkResult(page2, 'cursor-2'))

    const result = await getSessionTurnPage('ses-1', 2)

    expect(messagesMock).toHaveBeenCalledTimes(2)
    expect(messagesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionID: 'ses-1', limit: 30, before: undefined }),
    )
    expect(messagesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionID: 'ses-1', limit: 30, before: 'cursor-1' }),
    )
    // 按时间升序拼接：page2 在 page1 之前
    expect(result.messages.map(m => m.info.id)).toEqual(['user-1', 'asst-2', 'asst-3', 'asst-1', 'asst-2', 'user-3'])
    expect(result.nextCursor).toBe('cursor-2')
    expect(result.hasMore).toBe(true)
  })

  it('stops when the target turn count is already met in one page', async () => {
    const page = [userMsg(1), assistantMsg(1), userMsg(2), assistantMsg(2)]
    messagesMock.mockResolvedValueOnce(sdkResult(page, 'cursor-1'))

    const result = await getSessionTurnPage('ses-1', 2)

    expect(messagesMock).toHaveBeenCalledTimes(1)
    expect(result.messages).toHaveLength(4)
    expect(result.nextCursor).toBe('cursor-1')
    expect(result.hasMore).toBe(true)
  })

  it('reports no more history when the server omits the cursor on a short page', async () => {
    const page = [userMsg(1), assistantMsg(1)]
    messagesMock.mockResolvedValueOnce(sdkResult(page, undefined))

    const result = await getSessionTurnPage('ses-1', 3)

    expect(result.nextCursor).toBeUndefined()
    expect(result.hasMore).toBe(false)
  })

  it('treats a full page without a cursor as possibly having more history (legacy server)', async () => {
    // 旧版 serve 不给游标但返回满页：无法判定已到最早，按可能还有处理
    const page = Array.from({ length: 30 }, (_, index) => userMsg(index))
    messagesMock.mockResolvedValue(sdkResult(page, undefined))

    const result = await getSessionTurnPage('ses-1', 3)

    expect(result.hasMore).toBe(true)
  })

  it('bounds the number of internal pages for pathologically long turns', async () => {
    const fullPage = () => Array.from({ length: 30 }, (_, index) => assistantMsg(index))
    messagesMock.mockResolvedValue(sdkResult(fullPage(), 'cursor-x'))

    const result = await getSessionTurnPage('ses-1', 5)

    // 单轮几千条：最多 TURN_FETCH_MAX_PAGES 页就停，交给上滑继续加载
    expect(messagesMock).toHaveBeenCalledTimes(4)
    expect(result.messages).toHaveLength(120)
    expect(result.hasMore).toBe(true)
  })
})

describe('probeLightweightSupport', () => {
  beforeEach(() => {
    messagesMock.mockReset()
    getSDKClientMock.mockReset()
    storageMock.data.clear()
    storageMock.getJSONFor.mockClear()
    storageMock.setJSONFor.mockClear()
    resetLightweightSupportCache()
    getSDKClientMock.mockReturnValue({ session: { messages: messagesMock, message: messageMock } })
  })

  function resultWithLightweightHeader(value: string | null) {
    return {
      data: [],
      response: { headers: { get: (name: string) => (name === 'X-Lightweight' ? value : null) } },
    }
  }

  it('persists a positive probe result and reuses it without a network call', async () => {
    messagesMock.mockResolvedValueOnce(resultWithLightweightHeader('1'))

    const first = await probeLightweightSupport('ses-1', '/dir', 'srv-1')
    expect(first).toBe(true)
    expect(storageMock.setJSONFor).toHaveBeenCalled()

    // 清内存缓存后应从持久化读取，不再发请求
    resetLightweightSupportCache()
    messagesMock.mockClear()
    const second = await probeLightweightSupport('ses-1', '/dir', 'srv-1')
    expect(second).toBe(true)
    expect(messagesMock).not.toHaveBeenCalled()
  })

  it('does not persist a negative probe result and re-probes after restart', async () => {
    messagesMock.mockResolvedValueOnce(resultWithLightweightHeader(null))

    const first = await probeLightweightSupport('ses-1', '/dir', 'srv-2')
    expect(first).toBe(false)
    // 负结果不落盘：Agent 升级后能下次冷启动重探
    expect(storageMock.setJSONFor).not.toHaveBeenCalled()

    resetLightweightSupportCache()
    messagesMock.mockClear()
    messagesMock.mockResolvedValueOnce(resultWithLightweightHeader('1'))
    const second = await probeLightweightSupport('ses-1', '/dir', 'srv-2')
    expect(second).toBe(true)
    expect(messagesMock).toHaveBeenCalledTimes(1)
  })

  it('does not persist when the probe request fails', async () => {
    messagesMock.mockRejectedValueOnce(new Error('network down'))

    const result = await probeLightweightSupport('ses-1', '/dir', 'srv-3')
    expect(result).toBe(false)
    expect(storageMock.setJSONFor).not.toHaveBeenCalled()
  })
})

describe('getSessionLightweightMessages in-flight dedup (StrictMode)', () => {
  beforeEach(() => {
    messagesMock.mockReset()
    getSDKClientMock.mockReset()
    storageMock.data.clear()
    resetLightweightInflight()
    getSDKClientMock.mockReturnValue({ session: { messages: messagesMock, message: messageMock } })
  })

  it('sends only one network request for concurrent same-session calls', async () => {
    // React StrictMode 会把 effect 跑两次：同一会话的轻量请求并发发出两次。
    // 单次响应可达 MB 级，必须合并在途请求。
    messagesMock.mockResolvedValue({ data: [envelope()] })

    const [a, b] = await Promise.all([
      getSessionLightweightMessages('ses-1', '/dir', 'srv'),
      getSessionLightweightMessages('ses-1', '/dir', 'srv'),
    ])

    expect(messagesMock).toHaveBeenCalledTimes(1)
    expect(a.messages).toHaveLength(1)
    expect(b.messages).toHaveLength(1)
  })

  it('does not share the caller abort signal, so one abort cannot kill the other', async () => {
    let release!: (value: unknown) => void
    messagesMock.mockReturnValue(
      new Promise(resolve => {
        release = resolve
      }),
    )

    const controller = new AbortController()
    const aborted = getSessionLightweightMessages('ses-1', '/dir', 'srv', { signal: controller.signal })
    const survivor = getSessionLightweightMessages('ses-1', '/dir', 'srv')

    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })

    // 底层共享请求不受影响，另一个调用方仍能拿到数据
    release({ data: [envelope()] })
    await expect(survivor).resolves.toMatchObject({ messages: [expect.anything()] })
    expect(messagesMock).toHaveBeenCalledTimes(1)
  })

  it('issues a fresh request after the previous one settles', async () => {
    messagesMock.mockResolvedValue({ data: [envelope()] })

    await getSessionLightweightMessages('ses-1', '/dir', 'srv')
    await getSessionLightweightMessages('ses-1', '/dir', 'srv')

    // 只合并在途，不做缓存：请求结束后应重新拉取
    expect(messagesMock).toHaveBeenCalledTimes(2)
  })

  it('rejects immediately when the caller signal is already aborted', async () => {
    messagesMock.mockResolvedValue({ data: [envelope()] })
    const controller = new AbortController()
    controller.abort()

    await expect(
      getSessionLightweightMessages('ses-1', '/dir', 'srv', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(messagesMock).not.toHaveBeenCalled()
  })
})
