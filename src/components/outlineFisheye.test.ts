import { describe, expect, it } from 'vitest'
import { nearestIndexFromY, outlineStep, type OutlineFisheyeConfig } from './outlineFisheye'

const FISHEYE: OutlineFisheyeConfig = {
  tickWidth: { min: 8, max: 22 },
  tickHeight: 2.5,
  margin: { min: 4, max: 14 },
  labelThreshold: 0.65,
  css: { strengthRadius: 30, shiftAmp: 28.5, shiftRadius: 30, ease: 0.3 },
}

const STEP = outlineStep(FISHEYE)

describe('nearestIndexFromY：鱼眼吸附', () => {
  it('snaps to the tick directly under the cursor instead of leaving a dead zone', () => {
    /**
     * 回归：命中判定原先用「离静止中心超过 strengthRadius 就返回 -1」，而 tick
     * 激活时会被推开最多 shiftAmp。两者不一致，光标明明压在 tick 上却选不中，
     * 或选中旁边那个 —— 用户报的「没有鼠标吸附、无法精准选中」。
     */
    const count = 20
    const railCenterY = 500
    const mid = (count - 1) / 2
    for (let i = 0; i < count; i++) {
      const centerY = railCenterY + (i - mid) * STEP
      expect(nearestIndexFromY(count, centerY, railCenterY, FISHEYE)).toBe(i)
    }
  })

  it('returns -1 far outside the rail so hovering elsewhere does not change the selection', () => {
    expect(nearestIndexFromY(10, 0, 500, FISHEYE)).toBe(-1)
    expect(nearestIndexFromY(10, 2000, 500, FISHEYE)).toBe(-1)
  })

  it('never returns an index outside the entry range', () => {
    const count = 3
    const railCenterY = 300
    const mid = (count - 1) / 2
    const top = railCenterY - mid * STEP
    const bottom = railCenterY + mid * STEP
    expect(nearestIndexFromY(count, top, railCenterY, FISHEYE)).toBe(0)
    expect(nearestIndexFromY(count, bottom, railCenterY, FISHEYE)).toBe(count - 1)
    expect(nearestIndexFromY(count, top - 5, railCenterY, FISHEYE)).toBe(0)
    expect(nearestIndexFromY(count, bottom + 5, railCenterY, FISHEYE)).toBe(count - 1)
  })

  it('prefers the visually nearest tick, not the statically nearest one', () => {
    /**
     * 鱼眼把光标两侧的 tick 往两边推。取光标与两个 tick 静止中心的中点：
     * 静止几何上它同时远离两者，但位移后总有一个离光标更近，必须选中那一个。
     */
    const count = 10
    const railCenterY = 400
    const mid = (count - 1) / 2
    const upperCenter = railCenterY + (4 - mid) * STEP
    const lowerCenter = railCenterY + (5 - mid) * STEP
    const cursorY = (upperCenter + lowerCenter) / 2

    const shiftOf = (centerY: number) => {
      const dy = cursorY - centerY
      const u = Math.max(-1, Math.min(1, dy / FISHEYE.css.shiftRadius))
      return -FISHEYE.css.shiftAmp * Math.sin((u * Math.PI) / 2)
    }
    const upperDist = Math.abs(upperCenter + shiftOf(upperCenter) - cursorY)
    const lowerDist = Math.abs(lowerCenter + shiftOf(lowerCenter) - cursorY)
    const expected = upperDist <= lowerDist ? 4 : 5

    expect(nearestIndexFromY(count, cursorY, railCenterY, FISHEYE)).toBe(expected)
  })

  it('respects an explicit step override (keeps geometry and hit-testing in sync)', () => {
    const count = 5
    const railCenterY = 200
    const widerStep = STEP * 3
    const mid = (count - 1) / 2
    expect(nearestIndexFromY(count, railCenterY, railCenterY, FISHEYE, widerStep)).toBe(Math.floor(mid))
  })
})
