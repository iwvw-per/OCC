import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dedupeSessionListRequest,
  sessionListCacheKey,
  sessionListCacheToken,
  writeSessionListCache,
  readSessionListCache,
  invalidateSessionListCache,
} from './sessionListCache'
import { ttlCacheInvalidate } from '../utils/ttlCache'
import type { ApiSession } from './types'

vi.mock('../store/serverStore', () => ({
  serverStore: { getActiveServerId: () => 'test-server' },
}))

function makeSessions(ids: string[]): ApiSession[] {
  return ids.map(id => ({ id }) as ApiSession)
}

describe('sessionListCacheKey', () => {
  it('treats forward and backslash forms of the same directory as one key', () => {
    const forward = sessionListCacheKey('srv', { directory: 'E:/Code/App', limit: 51 })
    const backslash = sessionListCacheKey('srv', { directory: 'E:\\Code\\App', limit: 51 })
    expect(forward).toBe(backslash)
  })

  it('keeps distinct directories distinct', () => {
    const a = sessionListCacheKey('srv', { directory: 'E:/Code/App', limit: 51 })
    const b = sessionListCacheKey('srv', { directory: 'E:/Code/Other', limit: 51 })
    expect(a).not.toBe(b)
  })

  it('keeps case distinct so case-sensitive backends are not merged', () => {
    const lower = sessionListCacheKey('srv', { directory: '/srv/app', limit: 51 })
    const upper = sessionListCacheKey('srv', { directory: '/srv/App', limit: 51 })
    expect(lower).not.toBe(upper)
  })

  it('separates archived modes', () => {
    const active = sessionListCacheKey('srv', { directory: 'E:/Code/App', limit: 51 })
    const archived = sessionListCacheKey('srv', { directory: 'E:/Code/App', limit: 51, archivedOnly: true })
    expect(active).not.toBe(archived)
  })
})

describe('dedupeSessionListRequest', () => {
  beforeEach(() => {
    ttlCacheInvalidate('session-list:')
  })

  it('shares one in-flight request across concurrent callers with the same key', async () => {
    const resolvers: Array<(value: ApiSession[]) => void> = []
    const factory = vi.fn(
      () =>
        new Promise<ApiSession[]>(r => {
          resolvers.push(r)
        }),
    )

    const first = dedupeSessionListRequest('srv', { directory: 'E:/Code/App', limit: 51 }, factory)
    const second = dedupeSessionListRequest('srv', { directory: 'E:\\Code\\App', limit: 51 }, factory)

    expect(factory).toHaveBeenCalledTimes(1)

    const payload = makeSessions(['a', 'b'])
    resolvers[0](payload)

    await expect(first).resolves.toEqual(payload)
    await expect(second).resolves.toEqual(payload)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('does not share requests across different directories', async () => {
    const factory = vi.fn(async () => makeSessions(['a']))

    await Promise.all([
      dedupeSessionListRequest('srv', { directory: 'E:/Code/A', limit: 51 }, factory),
      dedupeSessionListRequest('srv', { directory: 'E:/Code/B', limit: 51 }, factory),
    ])

    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('issues a fresh request after the previous one settles', async () => {
    const factory = vi.fn(async () => makeSessions(['a']))

    await dedupeSessionListRequest('srv', { directory: 'E:/Code/App', limit: 51 }, factory)
    await dedupeSessionListRequest('srv', { directory: 'E:/Code/App', limit: 51 }, factory)

    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('clears the in-flight entry when the request rejects', async () => {
    const failing = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(dedupeSessionListRequest('srv', { directory: 'E:/Code/App', limit: 51 }, failing)).rejects.toThrow(
      'boom',
    )

    const succeeding = vi.fn(async () => makeSessions(['b']))
    await expect(dedupeSessionListRequest('srv', { directory: 'E:/Code/App', limit: 51 }, succeeding)).resolves.toEqual(
      makeSessions(['b']),
    )
    expect(succeeding).toHaveBeenCalledTimes(1)
  })
})

/**
 * 回归:列表请求在途期间发生失效(删除/归档)时,该请求落地不得回写旧列表,
 * 否则已删除的会话会在 30s 缓存里复活。
 */
describe('writeSessionListCache 失效代次防护', () => {
  it('拒绝把失效之后才落地的旧列表写回缓存', () => {
    const serverId = 'srv-token-stale'
    const query = { directory: 'E:/Code/App', limit: 51 }
    // 请求发起时取 token
    const token = sessionListCacheToken(serverId)
    const stale = makeSessions(['deleted', 'kept'])

    // 请求在途期间发生失效(等价于 session.deleted 事件到达)
    invalidateSessionListCache(serverId)

    writeSessionListCache(serverId, query, stale, token)
    expect(readSessionListCache(serverId, query)).toBeUndefined()
  })

  it('未失效时按 token 正常写入', () => {
    const serverId = 'srv-token-ok'
    const query = { directory: 'E:/Code/App', limit: 51 }
    const token = sessionListCacheToken(serverId)
    const list = makeSessions(['a'])

    writeSessionListCache(serverId, query, list, token)
    expect(readSessionListCache(serverId, query)).toEqual(list)
  })

  it('不传 token 时保持既有行为(仍然写入)', () => {
    const serverId = 'srv-token-legacy'
    const query = { directory: 'E:/Code/App', limit: 51 }
    const list = makeSessions(['a'])

    writeSessionListCache(serverId, query, list)
    expect(readSessionListCache(serverId, query)).toEqual(list)
  })
})
