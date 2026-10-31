// ============================================
// outlineFisheye — 鱼眼索引条的几何与命中判定
// ============================================
//
// 纯函数，不依赖 DOM 与 React：
//   - 静止几何：item 以固定 step 居中排列，中心 Y = railCenter + (i - mid) * step
//   - 鱼眼位移：光标附近的 tick 被推开，位移与 CSS `--oi-shift` 同一条公式
//
// 命中判定必须使用**位移后**的位置，否则「眼睛看到的 tick」和「选中项」
// 不是同一个 —— 表现就是没有吸附、点不准。

export interface OutlineFisheyeConfig {
  tickWidth: { min: number; max: number }
  tickHeight: number
  margin: { min: number; max: number }
  labelThreshold: number
  css: {
    strengthRadius: number
    shiftAmp: number
    shiftRadius: number
    ease: number
  }
}

/** item 之间的固定间距（tick 高度 + 上下 margin） */
export function outlineStep(fisheye: OutlineFisheyeConfig): number {
  return fisheye.tickHeight + fisheye.margin.min * 2
}

/**
 * 单个 item 激活时的纵向位移（px），与 CSS `--oi-shift` 同一公式：
 *   -amp * sin(clamp(dy / shiftRadius, -1, 1) * 90°)，dy = cursorY - 静止中心 Y
 */
export function fisheyeShift(dy: number, fisheye: OutlineFisheyeConfig): number {
  const u = Math.max(-1, Math.min(1, dy / fisheye.css.shiftRadius))
  return -fisheye.css.shiftAmp * Math.sin((u * Math.PI) / 2)
}

/**
 * 根据光标 Y 算最近的 item 下标（用于选中 / overlay 标题 / 触觉反馈）。
 *
 * 不读 DOM：几何由 rail 中心 + 固定 step 推导，位移由 `fisheyeShift` 解析计算，
 * 与 CSS 渲染保持一致。
 *
 * 命中策略是**吸附**：只要光标落在轨道纵向范围内（含少量余量），就返回视觉上
 * 最近的那一个，不留死区。此前用「离静止中心超过 strengthRadius 就返回 -1」，
 * 而 tick 激活时最多被推开 shiftAmp，两者不一致 —— 于是光标明明压着 tick 却
 * 选不中，或者选中偏了。
 *
 * @param step 覆盖间距（默认按 fisheye 推导），供需要与外部布局对齐时使用
 */
export function nearestIndexFromY(
  count: number,
  cursorY: number,
  railCenterY: number,
  fisheye: OutlineFisheyeConfig,
  step?: number,
): number {
  if (count <= 0) return -1
  const gap = step ?? outlineStep(fisheye)
  const mid = (count - 1) / 2
  const span = mid * gap
  // 轨道纵向范围外：不吸附（否则光标离得很远也会改选中项）
  const slack = Math.max(fisheye.css.strengthRadius, gap)
  if (Math.abs(cursorY - railCenterY) > span + slack) return -1

  // 静止几何只用来圈定候选邻域；最终按渲染后位置取最近
  const approx = Math.round((cursorY - railCenterY) / gap + mid)
  const from = Math.max(0, approx - 2)
  const to = Math.min(count - 1, approx + 2)
  let best = Math.min(Math.max(approx, 0), count - 1)
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = from; i <= to; i++) {
    const centerY = railCenterY + (i - mid) * gap
    const renderedY = centerY + fisheyeShift(cursorY - centerY, fisheye)
    const dist = Math.abs(renderedY - cursorY)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}
