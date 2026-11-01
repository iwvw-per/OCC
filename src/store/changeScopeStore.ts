import { useCallback, useSyncExternalStore } from 'react'

export type ChangeScopeMode = 'git' | 'branch' | 'session' | 'turn'

/**
 * 未显式选择时的默认范围：Git 变更。
 *
 * 与 SessionChangesPanel 的 getDefaultChangeMode 保持一致 —— 两处都兜底到同一个
 * 值，否则首次打开（store 里还没记录）会落到 turn，与面板的选择器不一致。
 */
export const DEFAULT_CHANGE_SCOPE_MODE: ChangeScopeMode = 'git'

type Subscriber = () => void

class ChangeScopeStore {
  private modes = new Map<string, ChangeScopeMode>()
  private subscribers = new Set<Subscriber>()

  subscribe = (fn: Subscriber): (() => void) => {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  getMode(sessionId: string | null): ChangeScopeMode {
    if (!sessionId) return DEFAULT_CHANGE_SCOPE_MODE
    return this.modes.get(sessionId) ?? DEFAULT_CHANGE_SCOPE_MODE
  }

  setMode(sessionId: string | null, mode: ChangeScopeMode) {
    if (!sessionId) return
    if (this.modes.get(sessionId) === mode) return
    this.modes.set(sessionId, mode)
    this.subscribers.forEach(fn => fn())
  }

  clearSession(sessionId: string | null) {
    if (!sessionId) return
    if (!this.modes.delete(sessionId)) return
    this.subscribers.forEach(fn => fn())
  }

  clearAll() {
    if (this.modes.size === 0) return
    this.modes.clear()
    this.subscribers.forEach(fn => fn())
  }
}

export const changeScopeStore = new ChangeScopeStore()

export function useSessionChangeScope(sessionId: string | null): ChangeScopeMode {
  const getSnapshot = useCallback(() => changeScopeStore.getMode(sessionId), [sessionId])
  return useSyncExternalStore(changeScopeStore.subscribe, getSnapshot, getSnapshot)
}
