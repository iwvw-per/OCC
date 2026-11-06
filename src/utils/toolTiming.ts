/**
 * 工具耗时的统一口径与坏值防护。
 *
 * 为什么需要单独一个模块：工具耗时同时被「统计面板」「工具卡片计时」消费，
 * 而数据来源有两个形状 ——
 *   - v2 历史消息：时间在 part 级 `time.{created,ran,completed}`；
 *   - 实时事件 / 本地对账：时间在 `state.time.{start,end}`。
 *
 * 历史适配层在字段缺失时曾把 `start` 写成 0，落定路径又把 0 当成合法起点
 * （`?? now` 只兜 null/undefined），于是 `end - start` 变成 `now - 0`
 * ≈ 当前 epoch 毫秒 ≈ 两万天。实测会话统计面板显示
 * 「工具调用用时 20763d 2h 53m」，就是这条链路的产物。
 *
 * 因此凡是「读取工具耗时」的地方都必须过这里：起点必须是正数，时长必须在
 * 合理上限内，否则一律视为未知（不参与统计、不显示读数），而不是算出一个
 * 看起来精确的错值。
 */

/** 工具耗时不可能超过 30 天；超过说明 start 是坏值（0 或单位错）。 */
export const MAX_TOOL_DURATION_MS = 30 * 24 * 60 * 60 * 1000

/** 工具时间窗口（与各 ToolState 的 time 字段形状一致） */
export interface ToolTimeWindow {
  start?: number
  end?: number
}

/**
 * 取可用的工具时间窗口；缺失或不可信时返回 undefined。
 *
 * 拒绝条件：
 *   1. start/end 任一不是有限数字；
 *   2. start <= 0 —— 历史数据缺字段时被写成 0 的典型坏值，
 *      `end - 0` 会等于当前 epoch 毫秒（约两万天）；
 *   3. end <= start，或时长超过 30 天（单位错、时钟错）。
 */
export function toolTimeWindow(time: ToolTimeWindow | undefined): { start: number; end: number } | undefined {
  const start = time?.start
  const end = time?.end
  if (typeof start !== 'number' || typeof end !== 'number') return undefined
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  if (start <= 0) return undefined
  const duration = end - start
  if (duration <= 0 || duration > MAX_TOOL_DURATION_MS) return undefined
  return { start, end }
}

/** 取工具执行时长（ms）；时间缺失或不可信时返回 undefined。 */
export function toolDurationMs(time: ToolTimeWindow | undefined): number | undefined {
  const window = toolTimeWindow(time)
  return window === undefined ? undefined : window.end - window.start
}
