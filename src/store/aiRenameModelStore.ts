import { useSyncExternalStore } from 'react'
import { serverStorage } from '../utils/perServerStorage'
import { serverStore } from './serverStore'

// ============================================
// AiRenameModelStore — AI 重命名使用的模型偏好
// ============================================
//
// 用户可在设置中为「AI 重命名生成会话标题」指定一个偏好的模型，按服务器保存
// （模型列表随服务器不同）。值为 `providerId:modelId` 复合键；未设置时回退到
// 「当前所选模型 / 第一个可见模型」。

type Listener = () => void

const STORAGE_KEY = 'ai-rename-model'
export const AI_RENAME_MODEL_STORAGE_KEY = STORAGE_KEY

function loadKey(): string | null {
  const raw = serverStorage.get(STORAGE_KEY)
  if (!raw) return null
  const trimmed = raw.trim()
  return trimmed || null
}

class AiRenameModelStore {
  private key: string | null = null
  private listeners = new Set<Listener>()
  private snapshot: string | null = null

  constructor() {
    this.reload()
    serverStore.onServerChange(() => {
      this.reload()
      this.emit()
    })
  }

  private reload() {
    this.key = loadKey()
    this.snapshot = this.key
  }

  private emit() {
    this.listeners.forEach(listener => listener())
  }

  private commit(value: string | null) {
    if (value) serverStorage.set(STORAGE_KEY, value)
    else serverStorage.set(STORAGE_KEY, '')
    this.reload()
    this.emit()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): string | null => this.snapshot

  /** 当前服务器（设置 UI 用）的偏好模型 key */
  get(): string | null {
    return this.key
  }

  /** 指定服务器的偏好模型 key */
  getFor(serverId: string): string | null {
    const raw = serverStorage.getFor(STORAGE_KEY, serverId)
    if (!raw) return null
    const trimmed = raw.trim()
    return trimmed || null
  }

  set(value: string | null) {
    this.commit(value)
  }
}

export const aiRenameModelStore = new AiRenameModelStore()

export function useAiRenameModelKey(): string | null {
  return useSyncExternalStore(aiRenameModelStore.subscribe, aiRenameModelStore.getSnapshot)
}
