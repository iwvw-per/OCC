import { beforeEach, describe, expect, it } from 'vitest'
import { activeSessionStore } from './activeSessionStore'

describe('activeSessionStore scoped refresh handling', () => {
  beforeEach(() => {
    activeSessionStore.initialize({})
    activeSessionStore.initializePendingRequests([], [])
  })

  it('preserves existing busy child sessions when merging scoped status refreshes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
      child: { type: 'busy' },
    })

    activeSessionStore.mergeStatusRefresh({
      root: { type: 'busy' },
    })

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['root', 'child'])
  })

  it('drops missing sessions on full status replacement refreshes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
      child: { type: 'busy' },
    })

    activeSessionStore.initialize({
      root: { type: 'busy' },
    })

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['root'])
  })

  it('keeps existing pending child requests during scoped pending refresh merges', () => {
    activeSessionStore.addPendingRequest('req-child', 'child', 'question', 'Need approval')

    activeSessionStore.mergePendingRequests([], [])

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['child'])
    expect(activeSessionStore.getBusySessions()[0]?.pendingAction).toEqual({
      type: 'question',
      description: 'Need approval',
    })
  })

  it('reuses the busySessions array reference when content is unchanged', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
    })
    activeSessionStore.setSessionMeta('root', 'Root', '/repo')

    const first = activeSessionStore.getBusySessionsSnapshot()
    activeSessionStore.mergeStatusRefresh({
      root: { type: 'busy' },
    })
    const second = activeSessionStore.getBusySessionsSnapshot()

    expect(second).toBe(first)
    expect(second).toEqual([
      {
        sessionId: 'root',
        status: { type: 'busy' },
        source: 'server',
        title: 'Root',
        directory: '/repo',
        pendingAction: undefined,
      },
    ])
  })

  it('replaces the busySessions array reference when status content changes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
    })
    const first = activeSessionStore.getBusySessionsSnapshot()

    activeSessionStore.updateStatus('root', {
      type: 'retry',
      attempt: 1,
      message: 'retrying',
      next: 1000,
    })
    const second = activeSessionStore.getBusySessionsSnapshot()

    expect(second).not.toBe(first)
    expect(second[0]?.status).toEqual({
      type: 'retry',
      attempt: 1,
      message: 'retrying',
      next: 1000,
    })
  })

  describe('updateStatus idle return value', () => {
    it('returns true when an idle status clears the session', () => {
      activeSessionStore.initialize({ root: { type: 'busy' } })

      const cleared = activeSessionStore.updateStatus('root', { type: 'idle' })

      expect(cleared).toBe(true)
      expect(activeSessionStore.getSessionStatus('root')).toBeUndefined()
    })

    it('returns false when an idle status is deferred by a pending request', () => {
      activeSessionStore.initialize({ root: { type: 'busy' } })
      activeSessionStore.addPendingRequest('req-1', 'root', 'permission', 'Approve')

      const cleared = activeSessionStore.updateStatus('root', { type: 'idle' })

      expect(cleared).toBe(false)
      expect(activeSessionStore.getSessionStatus('root')).toEqual({ type: 'busy' })
    })

    it('returns true for an idle status even when the session was never tracked', () => {
      activeSessionStore.initialize({})

      const cleared = activeSessionStore.updateStatus('root', { type: 'idle' })

      expect(cleared).toBe(true)
      expect(activeSessionStore.getSessionStatus('root')).toBeUndefined()
    })
  })

  describe('replaceServerStatus', () => {
    it('clears stale busy entries for the replaced server', () => {
      activeSessionStore.initialize({
        'srv::a': { type: 'busy' },
        'srv::b': { type: 'busy' },
      })

      activeSessionStore.replaceServerStatus('srv', { 'srv::a': { type: 'busy' } })

      expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['srv::a'])
    })

    it('preserves other servers status', () => {
      activeSessionStore.initialize({
        'srv::a': { type: 'busy' },
        'other::x': { type: 'busy' },
      })

      activeSessionStore.replaceServerStatus('srv', {})

      expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['other::x'])
    })

    it('keeps sessions with unresolved pending requests even if absent from the snapshot', () => {
      activeSessionStore.initialize({
        'srv::a': { type: 'busy' },
      })
      activeSessionStore.addPendingRequest('req-1', 'srv::a', 'permission', 'Approve')

      activeSessionStore.replaceServerStatus('srv', {})

      expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['srv::a'])
      expect(activeSessionStore.getBusySessions()[0]?.pendingAction).toEqual({
        type: 'permission',
        description: 'Approve',
      })
    })
  })

  describe('scoped initialize (D1 多服务器并发首连)', () => {
    it('keeps other servers status when initializing with a serverId', () => {
      activeSessionStore.initialize({ 'srv-a::a': { type: 'busy' } }, 'srv-a')
      activeSessionStore.initialize({ 'srv-b::b': { type: 'busy' } }, 'srv-b')

      expect(
        activeSessionStore
          .getBusySessions()
          .map(entry => entry.sessionId)
          .sort(),
      ).toEqual(['srv-a::a', 'srv-b::b'])
    })

    it('replaces only the named server on re-initialize', () => {
      activeSessionStore.initialize({ 'srv-a::old': { type: 'busy' } }, 'srv-a')
      activeSessionStore.initialize({ 'srv-b::keep': { type: 'busy' } }, 'srv-b')
      activeSessionStore.initialize({ 'srv-a::new': { type: 'busy' } }, 'srv-a')

      expect(
        activeSessionStore
          .getBusySessions()
          .map(entry => entry.sessionId)
          .sort(),
      ).toEqual(['srv-a::new', 'srv-b::keep'])
    })

    it('keeps other servers pending requests when initializing with a serverId', () => {
      activeSessionStore.initializePendingRequests(
        [{ id: 'p-a', sessionID: 'srv-a::a', permission: 'edit' }],
        [],
        'srv-a',
      )
      activeSessionStore.initializePendingRequests(
        [{ id: 'p-b', sessionID: 'srv-b::b', permission: 'read' }],
        [],
        'srv-b',
      )

      const ids = activeSessionStore
        .getBusySessions()
        .map(entry => entry.sessionId)
        .sort()
      expect(ids).toEqual(['srv-a::a', 'srv-b::b'])
    })
  })
})
