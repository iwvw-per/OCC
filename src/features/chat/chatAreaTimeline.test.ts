import { describe, expect, it } from 'vitest'
import { estimateTimelineItemSize, PROCESS_SHELL_HEADER, ROW_ESTIMATE } from './chatAreaTimeline'

const shell = (overrides: Record<string, unknown>) =>
  ({ kind: 'process', children: [], isActive: false, ...overrides }) as never

describe('estimateTimelineItemSize', () => {
  it('uses the row estimate for plain messages and unknown items', () => {
    expect(estimateTimelineItemSize(undefined)).toBe(ROW_ESTIMATE)
    expect(estimateTimelineItemSize({ kind: 'message' } as never)).toBe(ROW_ESTIMATE)
  })

  it('estimates an active shell with at least one body row', () => {
    expect(estimateTimelineItemSize(shell({ isActive: true }))).toBe(PROCESS_SHELL_HEADER + ROW_ESTIMATE)
    expect(estimateTimelineItemSize(shell({ isActive: true, children: [{}, {}] }))).toBe(
      PROCESS_SHELL_HEADER + 2 * ROW_ESTIMATE,
    )
  })

  it('estimates a finished shell as collapsed header (+ final row)', () => {
    // 折叠后如果仍按展开估算，刷新时会先占 120px 再回弹到 36px
    expect(estimateTimelineItemSize(shell({}))).toBe(PROCESS_SHELL_HEADER)
    expect(estimateTimelineItemSize(shell({ finalMessage: {} }))).toBe(PROCESS_SHELL_HEADER + ROW_ESTIMATE)
  })
})
