import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import { createStore, readStoreFor } from '../storage/createStore'
import { serverStore } from './serverStore'

// ============================================
// AiRenameModelStore — AI 重命名使用的模型偏好
// ============================================
//
// 用户可为「AI 重命名生成会话标题」指定偏好模型，按服务器保存（模型列表随
// 服务器不同）。值为 `providerId:modelId` 复合键；未设置时回退到「当前所选
// 模型 / 第一个可见模型」。
//
// 持久化统一走 createStore（单写入口 + schema 校验），本类只负责
// useSyncExternalStore 需要的那层订阅与快照。

const STORAGE_KEY = 'ai-rename-model'
export const AI_RENAME_MODEL_STORAGE_KEY = STORAGE_KEY

/** 空串与空白都视为「未设置」 */
const schema = z.string().transform(raw => raw.trim())

const serverOf = () => serverStore.getActiveServerId()

const store = createStore({
  key: STORAGE_KEY,
  scope: { kind: 'server', serverId: serverOf() },
  schema,
  defaultValue: '',
})

class AiRenameModelStore {
  private listeners = new Set<() => void>()
  private unsubscribes: Array<() => void> = []

  constructor() {
    // 存储变化（本页写入 / 跨标签页 / 同步引擎）统一转发给 React 订阅者
    this.unsubscribes.push(store.subscribe(() => this.emit()))
    this.unsubscribes.push(
      serverStore.onServerChange(() => {
        store.rebind(serverOf())
        this.emit()
      }),
    )
  }

  private emit() {
    this.listeners.forEach(listener => listener())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** useSyncExternalStore 的快照：空串归一为 null */
  getSnapshot = (): string | null => store.get() || null

  /** 当前服务器的偏好模型 key */
  get(): string | null {
    return store.get() || null
  }

  /** 指定服务器的偏好模型 key（只读，不影响当前绑定） */
  getFor(serverId: string): string | null {
    return readStoreFor(STORAGE_KEY, serverId, schema, '') || null
  }

  set(value: string | null) {
    const next = value?.trim() ?? ''
    store.commit(prev => (prev === next ? prev : next))
  }

  /** 仅测试/登出用 */
  dispose() {
    this.unsubscribes.forEach(fn => fn())
    this.unsubscribes = []
    this.listeners.clear()
  }
}

export const aiRenameModelStore = new AiRenameModelStore()

export function useAiRenameModelKey(): string | null {
  return useSyncExternalStore(aiRenameModelStore.subscribe, aiRenameModelStore.getSnapshot)
}
