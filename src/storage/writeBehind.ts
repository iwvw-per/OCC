// ============================================
// write-behind —— 把一阵写入合并成一次落盘
//
// 参考 OpenCode Desktop 主进程的存储策略：同一 key 在一小段时间内多次变更时
// 只保留最后值，到点统一写一次。收益在浏览器里同样成立：
//
//   - localStorage 是同步 IO，主线程上每写一次就是一次阻塞；
//   - 流式/拖动/批量编辑这类场景会在一帧内连续 commit 多次，
//     逐次 stringify + 写入的代价远高于「合并后写一次」。
//
// 关键约束（来自桌面版的实践经验）：
//   1. 不能依赖应用自己注册的 pagehide 监听顺序 —— 本模块在加载时就注册
//      持久化 flush，且 flush 是幂等的；
//   2. 写入失败（配额/隐私模式）不能丢数据：保留 dirty 标记，下次 flush 重试；
//   3. flush 之后必须允许「有新的变更」再排队，不能把 closed 语义混进普通 flush。
// ============================================

export interface WriteBehindOptions<K, V> {
  /** 合并窗口（ms）。0 表示退化为「排到微任务后立即写」。 */
  delay: number
  /** 实际写入；抛错会被吞并保留 dirty 以便重试。 */
  write: (batch: Map<K, V>) => void
  onError?: (error: unknown) => void
}

export interface WriteBehind<K, V> {
  set(key: K, value: V): void
  has(key: K): boolean
  get(key: K): V | undefined
  /** 立即写入所有待写项（幂等）。 */
  flush(): void
  /** 丢弃某个 key 的待写项。 */
  drop(predicate: (key: K, value: V) => boolean): void
  /** 丢弃并禁止后续写入（仅用于测试/销毁）。 */
  close(): void
  /** 当前是否有未落盘数据。 */
  isDirty(): boolean
}

/** 全局待 flush 集合：页面隐藏/卸载时统一冲刷。 */
const flushers = new Set<{ flush: () => void }>()
let lifecycleBound = false

/**
 * 绑定页面生命周期 → 统一 flush。
 *
 * 优先级：
 * - `pagehide`：比 `beforeunload` 更可靠（bfcache 场景也会触发）；
 * - `visibilitychange`（hidden）：移动端切后台时不一定触发 pagehide。
 */
function bindLifecycle(): void {
  if (lifecycleBound || typeof window === 'undefined') return
  lifecycleBound = true

  const flushAll = () => {
    for (const flusher of flushers) flusher.flush()
  }

  window.addEventListener('pagehide', flushAll)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll()
  })
}

/** 立即冲刷所有 write-behind 的待写数据（同步调用方，如测试或显式保存）。 */
export function flushAllWriteBehind(): void {
  for (const flusher of flushers) flusher.flush()
}

export function createWriteBehind<K, V>(options: WriteBehindOptions<K, V>): WriteBehind<K, V> {
  const pending = new Map<K, V>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (closed || pending.size === 0) return

    // 先取出再写：写入期间若有新 set，会进入新的 pending 并重新排队
    const batch = new Map(pending)
    pending.clear()
    try {
      options.write(batch)
    } catch (error) {
      // 失败回填（不覆盖写入期间产生的新值），等下次 flush 重试
      for (const [key, value] of batch) {
        if (!pending.has(key)) pending.set(key, value)
      }
      options.onError?.(error)
    }
  }

  const flusher = { flush }
  flushers.add(flusher)
  bindLifecycle()

  return {
    set(key, value) {
      if (closed) return
      pending.set(key, value)
      if (timer !== null) return
      timer = setTimeout(flush, options.delay)
    },
    has: key => pending.has(key),
    get: key => pending.get(key),
    flush,
    drop(predicate) {
      for (const [key, value] of pending) {
        if (predicate(key, value)) pending.delete(key)
      }
    },
    close() {
      flush()
      closed = true
      flushers.delete(flusher)
    },
    isDirty: () => pending.size > 0,
  }
}
