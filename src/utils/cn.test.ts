import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('merges conflicting tailwind classes with the later one winning', () => {
    expect(cn('px-3 py-1', 'px-5')).toBe('py-1 px-5')
  })

  it('keeps data-variant classes separate from base color classes', () => {
    const result = cn('text-text-500 hover:text-text-300', 'data-[state=active]:text-text-100')
    expect(result).toContain('text-text-500')
    expect(result).toContain('data-[state=active]:text-text-100')
  })

  it('keeps text-ui-* font size tokens when a text color follows', () => {
    const result = cn('px-2.5 text-ui-sm text-text-400')
    expect(result).toContain('text-ui-sm')
    expect(result).toContain('text-text-400')
  })

  it('lets a later text-ui-* token override the earlier one', () => {
    expect(cn('text-ui-sm', 'text-ui-base')).toBe('text-ui-base')
  })

  it('handles conditional values', () => {
    const active = true
    expect(cn('base', active && 'bg-accent-main-100/15', !active && 'bg-bg-200')).toBe('base bg-accent-main-100/15')
  })

  it('ignores falsy inputs', () => {
    expect(cn('a', undefined, null, false, '', 'b')).toBe('a b')
  })
})
