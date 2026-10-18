import { afterEach, describe, expect, it } from 'vitest'
import { readHostBootstrap, windowNamespace, windowScopedKey } from './hostBootstrap'

const GLOBAL = '__OCC_BOOTSTRAP__'

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[GLOBAL]
})

describe('readHostBootstrap', () => {
  it('returns empty when the host injected nothing (browser)', () => {
    expect(readHostBootstrap()).toEqual({})
  })

  it('reads typed fields and ignores junk', () => {
    ;(window as unknown as Record<string, unknown>)[GLOBAL] = {
      windowId: 'win-2',
      firstLaunch: false,
      host: 'tauri',
      extra: 1,
    }
    expect(readHostBootstrap()).toEqual({ windowId: 'win-2', firstLaunch: false, host: 'tauri' })

    ;(window as unknown as Record<string, unknown>)[GLOBAL] = { host: 'nonsense' }
    expect(readHostBootstrap()).toEqual({})
  })
})

describe('windowNamespace', () => {
  it('isolates state per window and sanitizes the id', () => {
    ;(window as unknown as Record<string, unknown>)[GLOBAL] = { windowId: 'win/2 a' }
    expect(windowNamespace()).toBe('win-2-a')
    expect(windowScopedKey('last-route')).toBe('occ.window.win-2-a.last-route')
  })

  it('falls back to main in the browser', () => {
    expect(windowNamespace()).toBe('main')
  })
})
