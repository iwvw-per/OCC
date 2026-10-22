import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reclaimIdleLocations, sameDirectory, listLoadedLocations, evictLocation } from './location'

const { getUnifiedFetchMock, buildHeadersMock, getServerBaseUrlMock } = vi.hoisted(() => ({
  getUnifiedFetchMock: vi.fn(),
  buildHeadersMock: vi.fn(() => ({ Authorization: 'Bearer t' })),
  getServerBaseUrlMock: vi.fn(() => 'http://host'),
}))

vi.mock('./sdk', () => ({ buildHeaders: buildHeadersMock }))
vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'local',
    getServerBaseUrl: getServerBaseUrlMock,
  },
  // 生产实现是 async（动态 import Tauri/http 实现），这里同样返回 Promise
  getUnifiedFetch: getUnifiedFetchMock,
}))

/** 造一个可编程的 fetch：按调用顺序返回预设的 location 列表 */
function makeFetch(responses: Array<Array<{ directory: string }>>) {
  let listIndex = 0
  const calls: Array<{ url: string; method: string }> = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url: String(url), method })
    if (method === 'DELETE') {
      return { ok: true, status: 204, json: async () => ({}) } as unknown as Response
    }
    const payload = responses[Math.min(listIndex, responses.length - 1)]
    listIndex += 1
    return { ok: true, status: 200, json: async () => payload } as unknown as Response
  })
  return { impl, calls }
}

describe('sameDirectory', () => {
  it('忽略大小写与斜杠方向', () => {
    expect(sameDirectory('E:\\Code\\App', 'e:/code/app')).toBe(true)
    expect(sameDirectory('/opt/code/App/', '/opt/code/App')).toBe(true)
  })

  it('不同目录不相等', () => {
    expect(sameDirectory('E:\\Code\\A', 'E:\\Code\\B')).toBe(false)
  })
})

describe('listLoadedLocations', () => {
  beforeEach(() => {
    getUnifiedFetchMock.mockReset()
  })

  it('解析服务端返回的 location 列表', async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ directory: 'E:\\Code\\A' }, { directory: 'E:\\Code\\B', workspaceID: 'w1' }],
    }) as unknown as Response)
    getUnifiedFetchMock.mockResolvedValue(impl)

    const locations = await listLoadedLocations('local')
    expect(locations).toEqual([
      { directory: 'E:\\Code\\A' },
      { directory: 'E:\\Code\\B', workspaceID: 'w1' },
    ])
  })

  it('老版本没有调试端点（404）时返回空数组而不是抛错', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response)
    getUnifiedFetchMock.mockResolvedValue(impl)
    await expect(listLoadedLocations('local')).resolves.toEqual([])
  })

  it('丢弃缺少 directory 的条目', async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ directory: 'E:\\Code\\A' }, {}, { directory: '' }, null],
    }) as unknown as Response)
    getUnifiedFetchMock.mockResolvedValue(impl)
    const locations = await listLoadedLocations('local')
    expect(locations).toEqual([{ directory: 'E:\\Code\\A' }])
  })
})

describe('evictLocation', () => {
  beforeEach(() => {
    getUnifiedFetchMock.mockReset()
  })

  it('必须用 deepObject 形式的参数（location[directory]）', async () => {
    // 上游对 `?directory=` 这种普通参数**不报错也不生效**（静默失败），
    // 这曾是排查耗时最久的一个坑。
    const { impl, calls } = makeFetch([[]])
    getUnifiedFetchMock.mockResolvedValue(impl)

    await evictLocation('E:\\Code\\A', 'local')

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toContain('location%5Bdirectory%5D=')
    expect(calls[0].url).not.toMatch(/[?&]directory=/)
  })
})

describe('reclaimIdleLocations', () => {
  beforeEach(() => {
    getUnifiedFetchMock.mockReset()
  })

  it('回收非当前目录，保留正在使用的目录', async () => {
    // 第 1 次 list：3 个目录；第 2 次 list（evict 之后）：只剩当前目录
    const { impl, calls } = makeFetch([
      [{ directory: 'E:\\Code\\A' }, { directory: 'E:\\Code\\B' }, { directory: 'E:\\Code\\Current' }],
      [{ directory: 'E:\\Code\\Current' }],
    ])
    getUnifiedFetchMock.mockResolvedValue(impl)

    const result = await reclaimIdleLocations('E:\\Code\\Current', 'local', { settleTimeoutMs: 0 })

    expect(result.before).toBe(3)
    expect(result.after).toBe(1)
    expect(result.evicted).toHaveLength(2)
    expect(result.evicted).not.toContain('E:\\Code\\Current')
    expect(result.kept).toEqual(['E:\\Code\\Current'])

    const deletes = calls.filter(c => c.method === 'DELETE')
    expect(deletes).toHaveLength(2)
  })

  it('只有当前目录时直接收敛，不发任何 DELETE', async () => {
    const { impl, calls } = makeFetch([[{ directory: 'E:\\Code\\Current' }]])
    getUnifiedFetchMock.mockResolvedValue(impl)

    const result = await reclaimIdleLocations('E:\\Code\\Current', 'local', { settleTimeoutMs: 0 })

    expect(result).toMatchObject({ before: 1, after: 1, evicted: [] })
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
  })

  it('多轮回收：有活跃会话占着时，下一轮继续清', async () => {
    // 实测：单轮 evict 后仍会残留（服务端拒绝关闭有 borrower 的图），
    // 需要再清一轮。这里模拟「第 1 轮清不掉、第 2 轮清干净」。
    const { impl, calls } = makeFetch([
      [{ directory: 'E:\\Code\\A' }, { directory: 'E:\\Code\\B' }],
      [{ directory: 'E:\\Code\\A' }, { directory: 'E:\\Code\\B' }],
      [{ directory: 'E:\\Code\\Current' }],
    ])
    getUnifiedFetchMock.mockResolvedValue(impl)

    const result = await reclaimIdleLocations('E:\\Code\\Current', 'local', { settleTimeoutMs: 0 })

    expect(result.after).toBe(1)
    expect(result.settled).toBe(true)
    // 两轮各发 2 个 DELETE
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(4)
  })

  it('不传 keepDirectory 时回收全部', async () => {
    const { impl } = makeFetch([[{ directory: 'E:\\Code\\A' }], []])
    getUnifiedFetchMock.mockResolvedValue(impl)

    const result = await reclaimIdleLocations(undefined, 'local', { settleTimeoutMs: 0 })
    expect(result.after).toBe(0)
    expect(result.evicted).toEqual(['E:\\Code\\A'])
  })

  it('被会话占用的 location 会如实报成 stuck（服务端拒绝关闭）', async () => {
    // 实测：有会话引用的 location，DELETE 回 204 但不会真正关闭。
    // 必须让用户知道「这些还在」，而不是假装成功。
    const { impl } = makeFetch([
      [{ directory: 'E:\\Code\\A' }, { directory: 'E:\\Code\\Busy' }, { directory: 'E:\\Code\\Current' }],
      [{ directory: 'E:\\Code\\Busy' }, { directory: 'E:\\Code\\Current' }],
      [{ directory: 'E:\\Code\\Busy' }, { directory: 'E:\\Code\\Current' }],
      [{ directory: 'E:\\Code\\Busy' }, { directory: 'E:\\Code\\Current' }],
    ])
    getUnifiedFetchMock.mockResolvedValue(impl)

    const result = await reclaimIdleLocations('E:\\Code\\Current', 'local', { settleTimeoutMs: 0, maxRounds: 2 })

    expect(result.evicted).toContain('E:\\Code\\A')
    expect(result.stuck).toEqual(['E:\\Code\\Busy'])
    expect(result.kept).toEqual(['E:\\Code\\Current'])
    expect(result.settled).toBe(false)
  })
})
