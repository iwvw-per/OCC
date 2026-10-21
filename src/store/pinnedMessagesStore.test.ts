import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/perServerStorage', () => {
  const store = new Map<string, string>()
  return {
    serverStorage: {
      get: (key: string) => store.get(key) ?? null,
      set: (key: string, value: string) => void store.set(key, value),
      remove: (key: string) => void store.delete(key),
      getJSON: (key: string) => {
        const raw = store.get(key)
        return raw ? JSON.parse(raw) : null
      },
      setJSON: (key: string, value: unknown) => void store.set(key, JSON.stringify(value)),
    },
  }
})

vi.mock('./serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'local',
    onServerChange: () => () => {},
  },
}))

import { pinnedMessagesStore, buildPinnedMessageExcerpt, PINNED_MESSAGE_EXCERPT_MAX } from './pinnedMessagesStore'

const entry = (sessionId: string, messageId: string, excerpt = 'text') => ({
  sessionId,
  messageId,
  role: 'user' as const,
  excerpt,
  createdAt: 1,
})

describe('pinnedMessagesStore', () => {
  beforeEach(() => {
    pinnedMessagesStore.reset()
  })

  it('pins and reports a message as pinned', () => {
    pinnedMessagesStore.pin(entry('s1', 'm1'))
    expect(pinnedMessagesStore.isPinned('s1', 'm1')).toBe(true)
    expect(pinnedMessagesStore.getPinned('s1')).toHaveLength(1)
  })

  it('toggle flips the pinned state', () => {
    expect(pinnedMessagesStore.toggle(entry('s1', 'm1'))).toBe(true)
    expect(pinnedMessagesStore.isPinned('s1', 'm1')).toBe(true)
    expect(pinnedMessagesStore.toggle(entry('s1', 'm1'))).toBe(false)
    expect(pinnedMessagesStore.isPinned('s1', 'm1')).toBe(false)
  })

  it('updates an existing pin when the excerpt changes', () => {
    pinnedMessagesStore.pin(entry('s1', 'm1', 'old'))
    pinnedMessagesStore.pin(entry('s1', 'm1', 'new'))
    const list = pinnedMessagesStore.getPinned('s1')
    expect(list).toHaveLength(1)
    expect(list[0].excerpt).toBe('new')
  })

  it('returns a stable snapshot reference until mutated', () => {
    pinnedMessagesStore.pin(entry('s1', 'm1'))
    const first = pinnedMessagesStore.getPinned('s1')
    expect(pinnedMessagesStore.getPinned('s1')).toBe(first)

    pinnedMessagesStore.pin(entry('s1', 'm2'))
    expect(pinnedMessagesStore.getPinned('s1')).not.toBe(first)
  })

  it('unpin removes a single message and clears the session when empty', () => {
    pinnedMessagesStore.pin(entry('s1', 'm1'))
    pinnedMessagesStore.unpin('s1', 'm1')
    expect(pinnedMessagesStore.getPinned('s1')).toHaveLength(0)
    expect(pinnedMessagesStore.isPinned('s1', 'm1')).toBe(false)
  })

  it('clearSession only affects the target session', () => {
    pinnedMessagesStore.pin(entry('s1', 'm1'))
    pinnedMessagesStore.pin(entry('s2', 'm2'))
    pinnedMessagesStore.clearSession('s1')
    expect(pinnedMessagesStore.getPinned('s1')).toHaveLength(0)
    expect(pinnedMessagesStore.getPinned('s2')).toHaveLength(1)
  })

  it('notifies subscribers on mutation', () => {
    const listener = vi.fn()
    pinnedMessagesStore.subscribe(listener)
    pinnedMessagesStore.pin(entry('s1', 'm1'))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('buildPinnedMessageExcerpt', () => {
  it('collapses whitespace', () => {
    expect(buildPinnedMessageExcerpt('a   b\n c')).toBe('a b c')
  })

  it('truncates long text with an ellipsis', () => {
    const long = 'x'.repeat(PINNED_MESSAGE_EXCERPT_MAX + 50)
    const out = buildPinnedMessageExcerpt(long)
    expect(out.length).toBe(PINNED_MESSAGE_EXCERPT_MAX + 1)
    expect(out.endsWith('\u2026')).toBe(true)
  })
})
