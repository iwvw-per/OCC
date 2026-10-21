import { describe, expect, it } from 'vitest'
import { hashContent, LruCache } from './codeCache'

describe('hashContent', () => {
  it('is stable for equal content and differs for different content', () => {
    expect(hashContent('const a = 1')).toBe(hashContent('const a = 1'))
    expect(hashContent('const a = 1')).not.toBe(hashContent('const a = 2'))
  })
})

describe('LruCache', () => {
  it('evicts the least recently used entry beyond capacity', () => {
    const cache = new LruCache<number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    // 命中 a，使 b 成为最久未使用
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)

    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('c')).toBe(true)
  })

  it('returns undefined for missing keys', () => {
    expect(new LruCache<number>(1).get('nope')).toBeUndefined()
  })
})
