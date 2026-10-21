// ============================================
// 轮次大纲分页
// ============================================
//
// 大纲只需要 text，但 v2 会把内联附件一并返回（实测 150 轮 = 18MB）。
// 无法省略附件，因此改为分页渐进：每页到达立刻回调，首屏只需约 390KB。
// 这里锁住：分页参数、页内升序、逐页回调、abort 能真正中断。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

vi.mock('./sdk', () => ({ buildHeaders: () => ({}) }))
vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'local',
    getServerBaseUrl: () => 'http://localhost:4096',
  },
  getUnifiedFetch: async () => fetchMock,
}))

const { fetchSessionTurns } = await import('./turnOutline')

function page(items: unknown[], next?: string) {
  return {
    ok: true,
    json: async () => ({ data: items, cursor: next ? { next } : {} }),
  }
}

function user(id: string, text: string, created: number) {
  return { id, type: 'user', text, time: { created } }
}

/** 解析请求 URL，便于断言分页参数 */
function requestedUrl(call: number): URL {
  return new URL(fetchMock.mock.calls[call][0] as string)
}

describe('fetchSessionTurns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('首页用 order=desc + type=user + 分页 limit', async () => {
    fetchMock.mockResolvedValue(page([user('m1', 'hi', 1)]))
    await fetchSessionTurns('ses_1', { serverId: 'local' })

    const url = requestedUrl(0)
    expect(url.searchParams.get('type')).toBe('user')
    expect(url.searchParams.get('order')).toBe('desc')
    expect(url.searchParams.get('limit')).toBe('25')
  })

  it('页内反转成时间升序（服务端是 desc）', async () => {
    fetchMock.mockResolvedValue(
      page([user('m3', 'c', 3), user('m2', 'b', 2), user('m1', 'a', 1)]),
    )
    const { turns } = await fetchSessionTurns('ses_1', { serverId: 'local' })
    expect(turns.map(t => t.messageId)).toEqual(['m1', 'm2', 'm3'])
  })

  it('每页到达就回调，且能标记最后一页', async () => {
    fetchMock
      .mockResolvedValueOnce(page([user('m2', 'b', 2)], 'cur1'))
      .mockResolvedValueOnce(page([user('m1', 'a', 1)]))

    const pages: Array<{ ids: string[]; info: { page: number; complete: boolean } }> = []
    const result = await fetchSessionTurns('ses_1', {
      serverId: 'local',
      onPage: (turns, info) => pages.push({ ids: turns.map(t => t.messageId), info }),
    })

    expect(pages).toHaveLength(2)
    expect(pages[0]).toEqual({ ids: ['m2'], info: { page: 1, complete: false } })
    expect(pages[1]).toEqual({ ids: ['m1'], info: { page: 2, complete: true } })
    expect(result.complete).toBe(true)
  })

  it('第二页起用 cursor 翻页，不再带 order', async () => {
    fetchMock
      .mockResolvedValueOnce(page([user('m2', 'b', 2)], 'cur1'))
      .mockResolvedValueOnce(page([user('m1', 'a', 1)]))

    await fetchSessionTurns('ses_1', { serverId: 'local' })

    const second = requestedUrl(1)
    expect(second.searchParams.get('cursor')).toBe('cur1')
    expect(second.searchParams.get('order')).toBeNull()
  })

  it('翻到最后一页时 complete=true', async () => {
    fetchMock.mockResolvedValue(page([user('m1', 'a', 1)]))
    const result = await fetchSessionTurns('ses_1', { serverId: 'local' })
    expect(result.complete).toBe(true)
  })

  it('达到最大页数时 complete=false（可稍后再补）', async () => {
    // 永远有下一页
    fetchMock.mockImplementation(async () => page([user('mx', 'x', 1)], 'always'))
    const result = await fetchSessionTurns('ses_1', { serverId: 'local' })
    expect(result.complete).toBe(false)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(12)
  })

  it('HTTP 失败时抛错，由调用方静默处理', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    await expect(fetchSessionTurns('ses_1', { serverId: 'local' })).rejects.toThrow(/HTTP 500/)
  })

  it('已 abort 的 signal 不再发请求', async () => {
    const controller = new AbortController()
    controller.abort()
    await fetchSessionTurns('ses_1', { serverId: 'local', signal: controller.signal })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('跳过非 user 类型条目', async () => {
    fetchMock.mockResolvedValue(
      page([
        user('m1', 'real', 1),
        { id: 'm2', type: 'assistant', time: { created: 2 } },
      ]),
    )
    const { turns } = await fetchSessionTurns('ses_1', { serverId: 'local' })
    expect(turns.map(t => t.messageId)).toEqual(['m1'])
  })
})
