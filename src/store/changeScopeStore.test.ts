import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changeScopeStore, DEFAULT_CHANGE_SCOPE_MODE } from './changeScopeStore'

describe('changeScopeStore', () => {
  beforeEach(() => {
    changeScopeStore.clearAll()
  })

  /**
   * 默认范围是 Git 变更（不是上一轮变更）。
   *
   * 面板叫「变更」，用户第一反应是「仓库现在有什么改动」；而且 turn 为空时
   * 会显示「本轮无变更」，容易被误读成「什么都没改」。断言引用常量而不是
   * 字面量，避免以后改默认值时这里静默失配。
   */
  it('defaults to Git scope when no session or no explicit mode', () => {
    expect(DEFAULT_CHANGE_SCOPE_MODE).toBe('git')
    expect(changeScopeStore.getMode(null)).toBe(DEFAULT_CHANGE_SCOPE_MODE)
    expect(changeScopeStore.getMode('session-1')).toBe(DEFAULT_CHANGE_SCOPE_MODE)
  })

  it('stores and reads a mode per session', () => {
    changeScopeStore.setMode('session-1', 'branch')
    changeScopeStore.setMode('session-2', 'git')
    expect(changeScopeStore.getMode('session-1')).toBe('branch')
    expect(changeScopeStore.getMode('session-2')).toBe('git')
  })

  it('notifies subscribers when the mode actually changes', () => {
    const listener = vi.fn()
    const unsubscribe = changeScopeStore.subscribe(listener)

    changeScopeStore.setMode('session-1', 'git')
    expect(listener).toHaveBeenCalledTimes(1)

    // 相同值不应重复通知
    changeScopeStore.setMode('session-1', 'git')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    changeScopeStore.setMode('session-1', 'branch')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores writes for a null session', () => {
    const listener = vi.fn()
    changeScopeStore.subscribe(listener)
    changeScopeStore.setMode(null, 'git')
    expect(listener).not.toHaveBeenCalled()
    expect(changeScopeStore.getMode(null)).toBe(DEFAULT_CHANGE_SCOPE_MODE)
  })

  it('clears a single session and notifies only when something changed', () => {
    const listener = vi.fn()
    changeScopeStore.setMode('session-1', 'git')
    changeScopeStore.subscribe(listener)

    changeScopeStore.clearSession('session-1')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(changeScopeStore.getMode('session-1')).toBe(DEFAULT_CHANGE_SCOPE_MODE)

    // 再清一次：无变化，不通知
    changeScopeStore.clearSession('session-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clears all sessions and notifies only when non-empty', () => {
    const listener = vi.fn()
    changeScopeStore.subscribe(listener)

    changeScopeStore.clearAll()
    expect(listener).not.toHaveBeenCalled()

    changeScopeStore.setMode('session-1', 'git')
    changeScopeStore.setMode('session-2', 'branch')
    listener.mockClear()

    changeScopeStore.clearAll()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(changeScopeStore.getMode('session-1')).toBe(DEFAULT_CHANGE_SCOPE_MODE)
    expect(changeScopeStore.getMode('session-2')).toBe(DEFAULT_CHANGE_SCOPE_MODE)
  })
})
