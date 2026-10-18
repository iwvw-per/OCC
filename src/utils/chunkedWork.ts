/**
 * 适配层分块化：把一次性的同步适配（一页几千条消息 → 逐条映射）
 * 拆到多个任务里执行，主线程每个任务之间都能让出一帧。
 *
 * 只影响「量大的批量适配」（消息分页）；单条事件的适配仍然同步，
 * 延迟要求比吞吐更高。
 */

/** 每个任务的预算：约一帧的长度，超过就让出。 */
const SLICE_BUDGET_MS = 6

/** 让出主线程：优先用 scheduler.yield，回退到 setTimeout(0)。 */
function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler?.yield) return scheduler.yield().catch(() => undefined)
  return new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * 分块映射。返回顺序与输入一致。
 *
 * @param items 待处理数组
 * @param map 单条映射（同步）
 * @param budgetMs 每个任务的预算
 */
export async function mapInSlices<T, R>(
  items: readonly T[],
  map: (item: T, index: number) => R,
  budgetMs = SLICE_BUDGET_MS,
): Promise<R[]> {
  if (items.length === 0) return []
  // 小批量不必分块：让出一次主线程的成本比直接算完更高
  if (items.length <= 50) return items.map(map)

  const out: R[] = new Array(items.length)
  let index = 0

  while (index < items.length) {
    const startedAt = performance.now()
    while (index < items.length && performance.now() - startedAt < budgetMs) {
      out[index] = map(items[index], index)
      index++
    }
    if (index < items.length) await yieldToMain()
  }

  return out
}
