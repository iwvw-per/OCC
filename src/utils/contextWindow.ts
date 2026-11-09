// ============================================
// 上下文窗口口径（与服务端压缩判据对齐）
// ============================================
//
// 背景：服务端自动压缩的窗口取值是 `limit.input || limit.context`，
// 见 opencode `packages/core/src/session/compaction.ts`：
//
//   const window = limit.input || limit.context
//   const ceiling = window - Math.max(Math.floor(window * 0.1),
//                                    window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
//   // RESERVE_MIN = 16000
//
// 而 OCC 此前只映射了 `limit.context`。实测 models.dev 快照里同时声明两者的
// 1563 个模型中，input/context < 0.9 的有 789 个、< 0.7 的有 335 个
// （最低 0.25）。对这些模型：
//
//   - 圆环分母偏大 → 百分比系统性偏低，看起来「不涨」；
//   - 服务端按更小的窗口更早压缩 → 用户觉得「明明没满怎么就压缩了」。
//
// 所以圆环的分母必须和服务端用同一个数。

/**
 * 模型的有效输入窗口。
 *
 * 优先级与 `calculateCeiling` 完全一致：`limit.input || limit.context`。
 * 两者都没有（模型未声明 / 模型列表没到手）时返回 0，表示**未知** ——
 * 调用方必须把它当成「不显示百分比」，不能用猜的默认值兜底。
 */
export function effectiveContextWindow(
  model:
    | {
        contextLimit?: number
        inputLimit?: number
      }
    | null
    | undefined,
): number {
  if (!model) return 0
  const input = typeof model.inputLimit === 'number' && model.inputLimit > 0 ? model.inputLimit : 0
  if (input > 0) return input
  const context = typeof model.contextLimit === 'number' && model.contextLimit > 0 ? model.contextLimit : 0
  return context
}

/** 服务端压缩时预留的最小空闲 token 数（`RESERVE_MIN`）。 */
export const COMPACTION_RESERVE_MIN = 16_000

/**
 * 自动压缩触发线（token 数）。
 *
 * 逐字对齐服务端 `calculateCeiling`：
 *   window - max(floor(window * 0.1), (window >= 32000 ? 16000 : 0))
 *
 * 注意 `window >= 2 * RESERVE_MIN` 即 `window >= 32000`。
 * 窗口未知（<= 0）时返回 0 —— 服务端此时永不自动压缩（返回 Infinity），
 * 这里返回 0 表示「没有可显示的触发线」，两者语义一致。
 */
export function autoCompactCeiling(window: number): number {
  if (!Number.isFinite(window) || window <= 0) return 0
  const tenPercent = Math.floor(window * 0.1)
  const reserve = Math.max(tenPercent, window >= 2 * COMPACTION_RESERVE_MIN ? COMPACTION_RESERVE_MIN : 0)
  return window - reserve
}

/**
 * 占用相对「触发线」的比例（0-1+）。
 *
 * 圆环用它上色，而不是用「相对窗口」的比例：服务端在触发线就压缩，
 * 95% 窗口往往早已超过触发线。用窗口比例上色会让用户以为「还没到 90%，
 * 为什么压缩了」，反之也可能停在「才 60%，其实已经满了」。
 *
 * 窗口未知时返回 null。
 */
export function compactRatio(used: number, window: number): number | null {
  const ceiling = autoCompactCeiling(window)
  if (ceiling <= 0 || !Number.isFinite(used)) return null
  return used / ceiling
}
