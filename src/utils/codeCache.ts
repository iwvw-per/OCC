// ============================================
// codeCache — 语法高亮结果的跨组件复用缓存
//
// 背景：同一段代码会在多处渲染（消息流里的代码块 → 全屏查看器 →
// 右侧面板 diff 的另一侧），而每个 useSyntaxHighlight 实例各自持有一份
// LRU，重复的高亮结果是重复的 worker 往返 + 内存副本。
//
// 这里提供进程级共享缓存：按 (内容哈希 + 语言 + 主题) 存一份结果。
// 内容用哈希而非原文做 key，避免把大段代码作为 Map 的键长期持有。
// ============================================

/** 极简字符串哈希（FNV-1a 32 位，足够区分渲染用内容）。 */
export function hashContent(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** 带容量上限的 LRU：读写都是 O(1)，超限时淘汰最久未使用的条目。 */
export class LruCache<V> {
  private readonly map = new Map<string, V>()
  private readonly maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // 命中即移到队尾（Map 保持插入顺序）
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next()
      if (!oldest.done) this.map.delete(oldest.value)
    }
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

/** 高亮 HTML / tokens 的进程级共享缓存。 */
export const highlightHtmlCache = new LruCache<string>(200)
export const highlightTokensCache = new LruCache<unknown>(120)
