import { useSyncExternalStore } from 'react'
import type { ModelInfo } from '../types/ui'
import { serverStorage } from '../utils/perServerStorage'
import { getModelKey } from '../utils/modelUtils'
import { serverStore } from './serverStore'

type Listener = () => void

const STORAGE_KEY_HIDDEN_MODELS = 'hidden-model-keys'
const STORAGE_KEY_KNOWN_MODELS = 'known-model-keys'
const STORAGE_KEY_HIDDEN_PROVIDERS = 'hidden-provider-names'

function loadHiddenModelKeys(): string[] {
  const stored = serverStorage.getJSON<unknown>(STORAGE_KEY_HIDDEN_MODELS, serverStore.getActiveServerId())
  if (!Array.isArray(stored)) return []
  return stored.filter((item): item is string => typeof item === 'string')
}

function loadHiddenProviderNames(): string[] {
  const stored = serverStorage.getJSON<unknown>(STORAGE_KEY_HIDDEN_PROVIDERS, serverStore.getActiveServerId())
  if (!Array.isArray(stored)) return []
  return stored.filter((item): item is string => typeof item === 'string')
}

function loadKnownModelKeys(): string[] {
  const stored = serverStorage.getJSON<unknown>(STORAGE_KEY_KNOWN_MODELS, serverStore.getActiveServerId())
  if (!Array.isArray(stored)) return []
  return stored.filter((item): item is string => typeof item === 'string')
}

class ModelVisibilityStore {
  private hiddenModelKeys = new Set<string>()
  private knownModelKeys = new Set<string>()
  private hiddenProviders = new Set<string>()
  private listeners = new Set<Listener>()
  private snapshot: string[] = []
  private providerSnapshot: string[] = []

  constructor() {
    this.reload()
    serverStore.onServerChange(() => {
      this.reload()
      this.emit()
    })
  }

  private syncSnapshot() {
    this.snapshot = Array.from(this.hiddenModelKeys).sort()
    this.providerSnapshot = Array.from(this.hiddenProviders).sort()
  }

  private emit() {
    this.listeners.forEach(listener => listener())
  }

  private commit() {
    this.syncSnapshot()
    serverStorage.setJSON(STORAGE_KEY_HIDDEN_MODELS, this.snapshot, serverStore.getActiveServerId())
    this.emit()
  }

  private commitProviders() {
    this.syncSnapshot()
    serverStorage.setJSON(STORAGE_KEY_HIDDEN_PROVIDERS, this.providerSnapshot, serverStore.getActiveServerId())
    this.emit()
  }

  private reload() {
    this.hiddenModelKeys = new Set(loadHiddenModelKeys())
    this.knownModelKeys = new Set(loadKnownModelKeys())
    this.hiddenProviders = new Set(loadHiddenProviderNames())
    this.syncSnapshot()
  }

  private persistKnown() {
    serverStorage.setJSON(
      STORAGE_KEY_KNOWN_MODELS,
      Array.from(this.knownModelKeys).sort(),
      serverStore.getActiveServerId(),
    )
  }

  /**
   * 记录已见过的模型;上游新增的模型默认关闭,避免端点自动更新后
   * 选择器里突然冒出一堆没验证过的模型。
   *
   * 首次运行(已知集合为空)时把当前模型全部视为已知、不隐藏任何模型,
   * 否则全新安装会一个可选模型都没有。
   */
  syncKnownModels(models: ModelInfo[]) {
    const keys = models.map(getModelKey)
    if (keys.length === 0) return

    if (this.knownModelKeys.size === 0) {
      keys.forEach(key => this.knownModelKeys.add(key))
      this.persistKnown()
      return
    }

    const newKeys: string[] = []
    let hiddenChanged = false
    for (const key of keys) {
      if (this.knownModelKeys.has(key)) continue
      this.knownModelKeys.add(key)
      newKeys.push(key)
    }

    if (newKeys.length === 0) return
    this.persistKnown()

    // 整组模型都是新的(例如端点整体改名):按新装处理,全部保持可见,
    // 否则一次改名就会把用户原来启用的模型全关掉。
    if (newKeys.length === keys.length) return

    for (const key of newKeys) {
      if (!this.hiddenModelKeys.has(key)) {
        this.hiddenModelKeys.add(key)
        hiddenChanged = true
      }
    }
    if (!hiddenChanged) return

    // 兜底:若默认关闭后一个可见模型都不剩,保留第一个新模型
    if (keys.every(key => this.hiddenModelKeys.has(key))) {
      this.hiddenModelKeys.delete(newKeys[0])
    }
    this.commit()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): string[] => this.snapshot

  getProviderSnapshot = (): string[] => this.providerSnapshot

  isVisible(model: ModelInfo | string): boolean {
    const key = typeof model === 'string' ? model : getModelKey(model)
    return !this.hiddenModelKeys.has(key)
  }

  setVisible(model: ModelInfo | string, visible: boolean) {
    const key = typeof model === 'string' ? model : getModelKey(model)
    let changed = false
    if (visible) {
      changed = this.hiddenModelKeys.delete(key)
    } else if (!this.hiddenModelKeys.has(key)) {
      this.hiddenModelKeys.add(key)
      changed = true
    }
    if (!changed) return
    this.commit()
  }

  setManyVisible(models: ModelInfo[], visible: boolean) {
    let changed = false
    for (const model of models) {
      const key = getModelKey(model)
      if (visible) {
        changed = this.hiddenModelKeys.delete(key) || changed
      } else if (!this.hiddenModelKeys.has(key)) {
        this.hiddenModelKeys.add(key)
        changed = true
      }
    }
    if (!changed) return
    this.commit()
  }

  isProviderVisible(providerName: string): boolean {
    return !this.hiddenProviders.has(providerName)
  }

  setProviderVisible(providerName: string, visible: boolean) {
    let changed = false
    if (visible) {
      changed = this.hiddenProviders.delete(providerName)
    } else if (!this.hiddenProviders.has(providerName)) {
      this.hiddenProviders.add(providerName)
      changed = true
    }
    if (!changed) return
    this.commitProviders()
  }
}

export const modelVisibilityStore = new ModelVisibilityStore()

export function useHiddenModelKeys(): string[] {
  return useSyncExternalStore(modelVisibilityStore.subscribe, modelVisibilityStore.getSnapshot)
}

export function useHiddenProviderNames(): string[] {
  return useSyncExternalStore(modelVisibilityStore.subscribe, modelVisibilityStore.getProviderSnapshot)
}
