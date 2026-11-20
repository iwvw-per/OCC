// ============================================
// LargeTextPasteStore — 大文本粘贴处理偏好
// ============================================
//
// 当用户粘贴的纯文本超过阈值时，询问如何处理：
// - ask    弹出选择（默认）：本次由用户决定
// - attach 作为附件插入（内容不进入输入框，避免撑爆 textarea）
// - inline 直接内联进输入框
//
// 与 hapticStore 同构：localStorage 持久化 + useSyncExternalStore 订阅。

import { useSyncExternalStore } from 'react'

export type LargeTextPasteBehavior = 'ask' | 'attach' | 'inline'

export const LARGE_TEXT_PASTE_BEHAVIORS: readonly LargeTextPasteBehavior[] = ['ask', 'attach', 'inline']

interface LargeTextPasteSettings {
  behavior: LargeTextPasteBehavior
}

type Subscriber = () => void

const STORAGE_KEY = 'opencode:large-text-paste'

function isBehavior(value: unknown): value is LargeTextPasteBehavior {
  return value === 'ask' || value === 'attach' || value === 'inline'
}

function loadSettings(): LargeTextPasteSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { behavior: 'ask' }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return { behavior: isBehavior(parsed.behavior) ? parsed.behavior : 'ask' }
  } catch {
    return { behavior: 'ask' }
  }
}

function saveSettings(settings: LargeTextPasteSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // quota exceeded
  }
}

class LargeTextPasteStore {
  private settings: LargeTextPasteSettings = loadSettings()
  private subscribers = new Set<Subscriber>()

  subscribe = (cb: Subscriber): (() => void) => {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  getSnapshot = (): LargeTextPasteSettings => this.settings

  setBehavior(behavior: LargeTextPasteBehavior) {
    if (this.settings.behavior === behavior) return
    this.settings = { behavior }
    saveSettings(this.settings)
    this.subscribers.forEach(cb => cb())
  }

  /** 从 localStorage 重读(供偏好同步拉取后调用)。 */
  reloadFromStorage() {
    this.settings = loadSettings()
    this.subscribers.forEach(cb => cb())
  }
}

export const largeTextPasteStore = new LargeTextPasteStore()

export function useLargeTextPasteSettings(): LargeTextPasteSettings {
  return useSyncExternalStore(largeTextPasteStore.subscribe, largeTextPasteStore.getSnapshot)
}
