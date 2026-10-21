import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWriteBehind, flushAllWriteBehind } from './writeBehind'

describe('createWriteBehind', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst of writes into one batch (last value wins)', () => {
    const write = vi.fn()
    const wb = createWriteBehind<string, number>({ delay: 100, write })

    wb.set('a', 1)
    wb.set('a', 2)
    wb.set('b', 3)
    expect(write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)

    expect(write).toHaveBeenCalledTimes(1)
    const batch = write.mock.calls[0][0] as Map<string, number>
    expect(batch.get('a')).toBe(2)
    expect(batch.get('b')).toBe(3)
    wb.close()
  })

  it('flush is idempotent and clears the dirty flag', () => {
    const write = vi.fn()
    const wb = createWriteBehind<string, number>({ delay: 100, write })

    wb.set('a', 1)
    expect(wb.isDirty()).toBe(true)
    wb.flush()
    expect(wb.isDirty()).toBe(false)

    wb.flush()
    expect(write).toHaveBeenCalledTimes(1)
    wb.close()
  })

  it('keeps data queued when the write throws, and retries on the next flush', () => {
    const onError = vi.fn()
    const write = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('quota exceeded')
      })
      .mockImplementation(() => undefined)
    const wb = createWriteBehind<string, number>({ delay: 100, write, onError })

    wb.set('a', 1)
    vi.advanceTimersByTime(100)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(wb.isDirty()).toBe(true)

    wb.flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(wb.isDirty()).toBe(false)
    wb.close()
  })

  it('does not let a retried value overwrite a newer one', () => {
    const write = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('boom')
      })
      .mockImplementation(() => undefined)
    const wb = createWriteBehind<string, number>({ delay: 100, write })

    wb.set('a', 1)
    vi.advanceTimersByTime(100) // 失败，a=1 回填
    wb.set('a', 2) // 期间产生新值
    wb.flush()

    const batch = write.mock.calls[1][0] as Map<string, number>
    expect(batch.get('a')).toBe(2)
    wb.close()
  })

  it('flushAllWriteBehind flushes every registered writer', () => {
    const writeA = vi.fn()
    const writeB = vi.fn()
    const a = createWriteBehind<string, number>({ delay: 100, write: writeA })
    const b = createWriteBehind<string, number>({ delay: 100, write: writeB })

    a.set('x', 1)
    b.set('y', 2)
    flushAllWriteBehind()

    expect(writeA).toHaveBeenCalledTimes(1)
    expect(writeB).toHaveBeenCalledTimes(1)
    a.close()
    b.close()
  })
})
