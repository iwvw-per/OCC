// ============================================
// 深合并（配置专用）
// ============================================
//
// 配置合并有两处需要它：
// 1. `config.get` 返回多份文档，要按优先级从低到高合并成一份「生效配置」；
// 2. 保存时把 patch 合进目标文件的原始内容。
//
// 语义与 JSON merge patch（RFC 7386）对齐：对象递归合并，**数组与标量整体覆盖**。
// 数组不做元素级合并是刻意的 —— 配置里的数组（instructions、plugin 列表等）代表
// 「这一项完整的值」，逐元素合并会让用户无法删除数组中的某一项。

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把 `patch` 深合并进 `base`，返回新对象（不修改入参）。
 *
 * `undefined` 值表示「删除该键」—— 与 merge patch 的语义一致，这样用户在编辑器里
 * 清空一个字段时能真正把它删掉，而不是留下一个 `undefined`（JSON.stringify 会丢弃
 * 它，但中间态会干扰比较）。
 */
export function deepMergeConfig(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete out[key]
      continue
    }
    const previous = out[key]
    out[key] = isPlainRecord(previous) && isPlainRecord(value) ? deepMergeConfig(previous, value) : value
  }
  return out
}
