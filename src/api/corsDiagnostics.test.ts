import { describe, expect, it } from 'vitest'
import { diagnosePreflight, isPreflightCacheEffective } from './corsDiagnostics'

describe('diagnosePreflight', () => {
  it('treats plain GETs with a JSON Accept header as simple requests', () => {
    expect(diagnosePreflight({ Accept: 'application/json' })).toEqual({ willPreflight: false, triggeredBy: [] })
  })

  it('flags Authorization and custom X-* headers', () => {
    const result = diagnosePreflight({ Authorization: 'Bearer t', 'X-Lightweight': '1' })
    expect(result.willPreflight).toBe(true)
    expect(result.triggeredBy).toEqual(['authorization', 'x-lightweight'])
  })

  it('flags non-safelisted content types only', () => {
    expect(diagnosePreflight({ 'Content-Type': 'application/json' }).willPreflight).toBe(true)
    expect(diagnosePreflight({ 'Content-Type': 'text/plain;charset=UTF-8' }).willPreflight).toBe(false)
  })
})

describe('isPreflightCacheEffective', () => {
  it('requires an explicit Max-Age of at least a minute', () => {
    expect(isPreflightCacheEffective('7200')).toBe(true)
    expect(isPreflightCacheEffective('5')).toBe(false)
    expect(isPreflightCacheEffective(null)).toBe(false)
    expect(isPreflightCacheEffective('not-a-number')).toBe(false)
  })
})
