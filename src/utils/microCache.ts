// ============================================
// microCache - 「在途合并 + 极短 TTL」的组合缓存
//
// 与既有工具的分工：
// - singleFlight：只合并**同一时刻在途**的并发调用，请求一结束就摘除。
// - ttlCache：只做结果缓存（get/set），没有在途合并，并发未命中会各发一次。
// - 本模块：两者结合，并复用 ttlCache 的存储，避免出现两套互相看不见的缓存。
//
// 为什么需要它：经隧道（远程 Agent）时每个请求约 1.1s 固定往返成本。实测点击一个
// 会话触发 32 个请求，其中 15 个是重复的 —— 它们并非同一帧并发，而是分几批先后
// 发出（组件挂载一批、目录变化一批、SSE 重连一批）。singleFlight 对「前一批已结束、
// 后一批才开始」无能为力；ttlCache 又挡不住并发。两者结合才能收敛干净。
//
// TTL 取小值（默认 1.5s）：只吸收「同一次交互引发的重复」，不会让用户看到陈旧数据。
// 有明确变更信号时由调用方 invalidate。
// ============================================

import { ttlCacheGet, ttlCacheSet, ttlCacheInvalidate } from './ttlCache'

const inflight = new Map<string, Promise<unknown>>()

export interface MicroCacheOptions {
  /** 缓存有效期（毫秒）。0 表示不缓存结果，仅做在途合并。 */
  ttlMs?: number
}

/**
 * 取缓存或发起请求。
 *
 * - 有在途请求：共享同一个 Promise（并发只发一次网络）。
 * - 命中 TTL 内的结果：直接返回，零网络（先后重复调用不再重发）。
 * - 否则发起请求并写入缓存。
 *
 * 失败不缓存：错误立即向上抛，也不留条目，下次调用会重试。
 */
export function microCache<T>(key: string, factory: () => Promise<T>, options: MicroCacheOptions = {}): Promise<T> {
  const ttlMs = options.ttlMs ?? 1500

  // 1) 在途合并优先：此时缓存里还没有值
  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending

  // 2) 结果缓存
  if (ttlMs > 0) {
    const cached = ttlCacheGet<T>(key, ttlMs)
    if (cached !== undefined) return Promise.resolve(cached)
  }

  const request = factory()
    .then(value => {
      /**
       * 只在「本请求仍是在途登记」时才回写。
       *
       * `invalidateMicroCache` 会同时删掉 ttl 条目与在途登记。若本请求是在失效
       * 之前发起、失效之后才落地的,此处 `inflight.get(key)` 已不是自己 —— 此时
       * 回写会把**失效前的旧结果**重新塞回缓存:表现为「刚答完的授权/提问弹窗
       * 又冒出来」「已删除的条目复活」等,直到 TTL 过期。跳过回写即可,返回值
       * 仍照常交给调用方。
       */
      if (ttlMs > 0 && inflight.get(key) === request) ttlCacheSet(key, value, ttlMs)
      return value
    })
    .finally(() => {
      // 只清理自己这一条，避免并发场景下误删后来者的登记
      if (inflight.get(key) === request) inflight.delete(key)
    })

  inflight.set(key, request)
  return request
}

/** 让某个 key 立即失效（前缀匹配） */
export function invalidateMicroCache(keyPrefix: string): void {
  ttlCacheInvalidate(keyPrefix)
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(keyPrefix)) inflight.delete(key)
  }
}
