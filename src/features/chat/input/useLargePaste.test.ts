import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { isLargePasteText, useLargePaste } from './useLargePaste'

describe('isLargePasteText', () => {
  it('detects by character count', () => {
    expect(isLargePasteText('x'.repeat(1999))).toBe(false)
    expect(isLargePasteText('x'.repeat(2000))).toBe(true)
  })

  it('detects by line count', () => {
    expect(isLargePasteText(Array.from({ length: 24 }, () => 'a').join('\n'))).toBe(false)
    expect(isLargePasteText(Array.from({ length: 25 }, () => 'a').join('\n'))).toBe(true)
  })
})

describe('useLargePaste', () => {
  it('routes to attach / inline / ask by preference', () => {
    const attach = vi.fn()
    const insertInline = vi.fn()
    const ask = vi.fn()
    const big = 'y'.repeat(3000)

    const { result: attachHook } = renderHook(() =>
      useLargePaste({ behavior: 'attach', attach, insertInline, ask }),
    )
    expect(attachHook.current.handlePastedText(big)).toBe(true)
    expect(attach).toHaveBeenCalledWith(big)

    const { result: inlineHook } = renderHook(() =>
      useLargePaste({ behavior: 'inline', attach, insertInline, ask }),
    )
    inlineHook.current.handlePastedText(big)
    expect(insertInline).toHaveBeenCalledWith(big)

    const { result: askHook } = renderHook(() => useLargePaste({ behavior: 'ask', attach, insertInline, ask }))
    askHook.current.handlePastedText(big)
    expect(ask).toHaveBeenCalledWith(big)
  })

  it('leaves small pastes alone', () => {
    const ask = vi.fn()
    const { result } = renderHook(() => useLargePaste({ behavior: 'ask', attach: vi.fn(), insertInline: vi.fn(), ask }))
    expect(result.current.handlePastedText('short')).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })
})
