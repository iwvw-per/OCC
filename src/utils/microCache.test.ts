import { describe, expect, it, vi } from 'vitest'
import { invalidateMicroCache, microCache } from './microCache'

describe('microCache', () => {
  it('dedupes concurrent calls with the same key into one request', async () => {
    const key = 'mc-test:dedupe'
    const factory = vi.fn(async () => {
      await Promise.resolve()
      return 'value'
    })

    const [a, b] = await Promise.all([
      microCache(key, factory, { ttlMs: 1500 }),
      microCache(key, factory, { ttlMs: 1500 }),
    ])

    expect(a).toBe('value')
    expect(b).toBe('value')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('serves a later call from the TTL cache without refetching', async () => {
    const key = 'mc-test:ttl-hit'
    const factory = vi.fn(async () => 'cached')

    await microCache(key, factory, { ttlMs: 1500 })
    const second = await microCache(key, factory, { ttlMs: 1500 })

    expect(second).toBe('cached')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('refetches immediately after invalidateMicroCache', async () => {
    const key = 'mc-test:invalidate'
    const first = vi.fn(async () => 'old')
    await microCache(key, first, { ttlMs: 1500 })

    invalidateMicroCache(key)

    const second = vi.fn(async () => 'new')
    await expect(microCache(key, second, { ttlMs: 1500 })).resolves.toBe('new')
    expect(second).toHaveBeenCalledTimes(1)
  })

  // 回归:失效发生在请求在途期间。旧实现在 resolve 后无条件回写缓存,
  // 于是「失效前发起的请求」会把它拿到的旧结果重新塞回缓存,
  // 表现为刚答完的授权/提问弹窗又冒出来(直到 TTL 过期)。
  it('does not let an in-flight request repopulate the cache after invalidation', async () => {
    const key = 'mc-test:invalidate-inflight'
    let release!: (value: string) => void
    const staleFactory = vi.fn(() => new Promise<string>(resolve => (release = resolve)))

    const inFlight = microCache(key, staleFactory, { ttlMs: 1500 })
    // 请求尚未返回,此时显式失效(等价于用户刚答复完一个待处理请求)
    invalidateMicroCache(key)

    release('pre-reply')
    await expect(inFlight).resolves.toBe('pre-reply')

    // 旧结果不得落盘:下一次调用必须重新请求
    const freshFactory = vi.fn(async () => 'post-reply')
    await expect(microCache(key, freshFactory, { ttlMs: 1500 })).resolves.toBe('post-reply')
    expect(freshFactory).toHaveBeenCalledTimes(1)
  })

  it('clears the in-flight registration on invalidation so a concurrent call refetches', async () => {
    const key = 'mc-test:inflight-cleared'
    let releaseFirst!: (value: string) => void
    const first = vi.fn(() => new Promise<string>(resolve => (releaseFirst = resolve)))

    const pending = microCache(key, first, { ttlMs: 1500 })
    invalidateMicroCache(key)

    const second = vi.fn(async () => 'second')
    const next = await microCache(key, second, { ttlMs: 1500 })
    expect(next).toBe('second')
    expect(second).toHaveBeenCalledTimes(1)

    releaseFirst('first')
    await expect(pending).resolves.toBe('first')
  })
})
