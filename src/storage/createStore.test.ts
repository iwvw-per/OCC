import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createStore, storageKeyFor } from './createStore'

const schema = z.array(z.object({ path: z.string(), name: z.string() }))

describe('createStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('uses the default value when storage is empty', () => {
    const store = createStore({ key: 'k', scope: { kind: 'global' }, schema, defaultValue: [] })
    expect(store.get()).toEqual([])
  })

  it('writes through the single commit entry point', () => {
    const store = createStore({ key: 'k', scope: { kind: 'global' }, schema, defaultValue: [] })
    store.commit(list => [...list, { path: '/a', name: 'A' }])

    expect(store.get()).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('k') ?? '[]')).toEqual([{ path: '/a', name: 'A' }])
  })

  it('skips notifying when the mutator returns the same reference', () => {
    const store = createStore({ key: 'k', scope: { kind: 'global' }, schema, defaultValue: [] })
    const listener = vi.fn()
    store.subscribe(listener)

    store.commit(list => list)

    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects invalid values produced by commit instead of writing them', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createStore({ key: 'k', scope: { kind: 'global' }, schema, defaultValue: [] })

    store.commit(() => [{ path: 1 } as unknown as { path: string; name: string }])

    expect(store.get()).toEqual([])
    expect(errorSpy).toHaveBeenCalled()
  })

  it('falls back to default and keeps a copy of corrupt stored data', () => {
    localStorage.setItem('k', '{not json')
    const store = createStore({ key: 'k', scope: { kind: 'global' }, schema, defaultValue: [] })

    expect(store.get()).toEqual([])
    expect(localStorage.getItem('k:__invalid__')).toBe('{not json')
  })

  it('falls back to default when stored data fails schema validation', () => {
    localStorage.setItem('k', JSON.stringify([{ path: 1 }]))
    const store = createStore({ key: 'k', scope: { kind: 'global' }, schema, defaultValue: [] })

    expect(store.get()).toEqual([])
    expect(localStorage.getItem('k:__invalid__')).toBe(JSON.stringify([{ path: 1 }]))
  })

  it('prefixes server-scoped keys with srv:{serverId}', () => {
    const store = createStore({
      key: 'opencode-saved-directories',
      scope: { kind: 'server', serverId: 'aiagent:inst_1' },
      schema,
      defaultValue: [],
    })

    expect(store.getStorageKey()).toBe('srv:aiagent:inst_1:opencode-saved-directories')
    expect(storageKeyFor({ kind: 'server', serverId: 'local' }, 'k')).toBe('srv:local:k')
    expect(storageKeyFor({ kind: 'global' }, 'k')).toBe('k')
  })

  it('applies remote values without writing back', () => {
    const store = createStore({ key: 'k', scope: { kind: 'global' }, schema, defaultValue: [] })
    const setSpy = vi.spyOn(Storage.prototype, 'setItem')

    store.applyRemote([{ path: '/remote', name: 'R' }])

    expect(store.get()).toEqual([{ path: '/remote', name: 'R' }])
    // applyRemote 允许落盘一次（保持内存与磁盘一致），但绝不能触发 commit 链路
    expect(setSpy).toHaveBeenCalledTimes(1)
  })

  it('rebinds to another server bucket and reloads', () => {
    localStorage.setItem(
      'srv:a:opencode-saved-directories',
      JSON.stringify([{ path: '/a', name: 'A' }]),
    )
    localStorage.setItem(
      'srv:b:opencode-saved-directories',
      JSON.stringify([{ path: '/b', name: 'B' }]),
    )

    const store = createStore({
      key: 'opencode-saved-directories',
      scope: { kind: 'server', serverId: 'a' },
      schema,
      defaultValue: [],
    })
    expect(store.get()).toEqual([{ path: '/a', name: 'A' }])

    store.rebind('b')
    expect(store.get()).toEqual([{ path: '/b', name: 'B' }])
    expect(store.getStorageKey()).toBe('srv:b:opencode-saved-directories')
  })

  it('throttles writes but keeps the in-memory value immediate', () => {
    vi.useFakeTimers()
    const store = createStore({
      key: 'k',
      scope: { kind: 'global' },
      schema,
      defaultValue: [],
      writeThrottleMs: 100,
    })

    store.commit(list => [...list, { path: '/a', name: 'A' }])
    store.commit(list => [...list, { path: '/b', name: 'B' }])

    expect(store.get()).toHaveLength(2)
    expect(localStorage.getItem('k')).toBeNull()

    vi.advanceTimersByTime(100)
    expect(JSON.parse(localStorage.getItem('k') ?? '[]')).toHaveLength(2)
    vi.useRealTimers()
  })
})

describe('createStore write-behind', () => {
  it('exposes flush() that writes the pending value immediately', () => {
    vi.useFakeTimers()
    const store = createStore({
      key: 'flush-k',
      scope: { kind: 'global' },
      schema,
      defaultValue: [],
      writeThrottleMs: 1000,
    })

    store.commit(list => [...list, { path: '/a', name: 'A' }])
    expect(localStorage.getItem('flush-k')).toBeNull()

    store.flush()
    expect(JSON.parse(localStorage.getItem('flush-k') ?? '[]')).toHaveLength(1)
    vi.useRealTimers()
  })

  it('reset() writes through immediately even in write-behind mode', () => {
    vi.useFakeTimers()
    const store = createStore({
      key: 'reset-k',
      scope: { kind: 'global' },
      schema,
      defaultValue: [],
      writeThrottleMs: 1000,
    })

    store.commit(list => [...list, { path: '/a', name: 'A' }])
    store.reset()
    expect(localStorage.getItem('reset-k')).toBe('[]')
    vi.useRealTimers()
  })
})
