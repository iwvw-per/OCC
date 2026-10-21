import { useSyncExternalStore, useCallback, useEffect } from 'react'
import { getActiveModels, type ModelInfo } from '../api'
import { serverStore } from '../store/serverStore'
import i18n from '../i18n'

// ============================================
// Per-server models cache — 每个服务器独立维护模型列表。
//
// 多服务器模式：每个 pane 绑定自己的服务器，模型选择器必须显示
// 该 pane 服务器的模型（而不是活动服务器的）。
// 单例缓存避免重复 API 请求与"后挂载 pane 看到空列表"的竞态。
// ============================================

interface ModelsState {
  models: ModelInfo[]
  isLoading: boolean
  error: Error | null
}

type Listener = () => void

const _states = new Map<string, ModelsState>()
const _fetchPromises = new Map<string, Promise<void> | null>()
const _fetchGenerations = new Map<string, number>()
const _listeners = new Set<Listener>()

function _getState(serverId: string): ModelsState {
  return _states.get(serverId) ?? { models: [], isLoading: true, error: null }
}

function _notify() {
  for (const fn of _listeners) fn()
}

function _setState(serverId: string, patch: Partial<ModelsState>) {
  const next = { ..._getState(serverId), ...patch }
  _states.set(serverId, next)
  _notify()
}

async function _fetchModels(serverId: string, force = false) {
  const existing = _fetchPromises.get(serverId)
  if (existing && !force) return existing

  const generation = (_fetchGenerations.get(serverId) ?? 0) + 1
  _fetchGenerations.set(serverId, generation)

  const promise = (async () => {
    _setState(serverId, { isLoading: true, error: null })
    try {
      const data = await getActiveModels(undefined, serverId)
      if (generation === _fetchGenerations.get(serverId)) {
        _setState(serverId, { models: data, isLoading: false })
        if (data.length > 0) {
          _failureCount.delete(serverId)
        } else {
          // 空列表也重试：服务端刚起来时 200 但 providers 为空是常见情况
          // （配置尚未加载完）。不重试就会一直显示「未找到模型」。
          _scheduleRetry(serverId)
        }
      }
    } catch (e) {
      if (generation === _fetchGenerations.get(serverId)) {
        _setState(serverId, {
          error: e instanceof Error ? e : new Error(i18n.t('chat:errors.fetchModels')),
          isLoading: false,
        })
        _scheduleRetry(serverId)
      }
    } finally {
      if (generation === _fetchGenerations.get(serverId)) {
        _fetchPromises.set(serverId, null)
      }
    }
  })()

  _fetchPromises.set(serverId, promise)
  return promise
}

/**
 * 失败后自动重试（指数退避，上限 RETRY_MAX_DELAYS）。
 *
 * 刷新页面时服务端常常还没就绪（本地 serve 刚启动、隧道刚建立），首拉必然失败。
 * 之前失败只记 error 就再也不管，模型选择器会一直空着，直到用户手动切换服务器
 * 或重新打开页面 —— 用户报的「模型一直是空的，刷新后没及时加载出来」正是这里。
 */
const _retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const _failureCount = new Map<string, number>()
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

function _scheduleRetry(serverId: string) {
  if (_retryTimers.has(serverId)) return
  const attempt = _failureCount.get(serverId) ?? 0
  if (attempt >= RETRY_DELAYS_MS.length) return
  _failureCount.set(serverId, attempt + 1)
  const delay = RETRY_DELAYS_MS[attempt]
  const timer = setTimeout(() => {
    _retryTimers.delete(serverId)
    void _fetchModels(serverId, true)
  }, delay)
  _retryTimers.set(serverId, timer)
}

/** 强制刷新指定服务器（缺省 = 活动服务器）的模型列表 */
export function refreshModels(serverId?: string) {
  const sid = serverId ?? serverStore.getActiveServerId()
  return _fetchModels(sid, true)
}

// 预取活动服务器的模型 — 组件挂载前模型就已就绪
_fetchModels(serverStore.getActiveServerId())

serverStore.onServerChange(newServerId => {
  void refreshModels(newServerId)
})

function _subscribe(listener: Listener) {
  _listeners.add(listener)
  return () => _listeners.delete(listener)
}

// ============================================
// Hook — 指定服务器（缺省跟随活动服务器）
// ============================================

interface UseModelsResult {
  models: ModelInfo[]
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

export function useModels(serverId?: string): UseModelsResult {
  const activeServerId = useSyncExternalStore(
    cb => serverStore.subscribe(cb),
    () => serverStore.getActiveServerId(),
    () => serverStore.getActiveServerId(),
  )
  const resolvedServerId = serverId ?? activeServerId

  const state = useSyncExternalStore(
    _subscribe,
    () => _getState(resolvedServerId),
    () => _getState(resolvedServerId),
  )

  // 首次挂载或服务器变化时确保已拉取
  useEffect(() => {
    void _fetchModels(resolvedServerId)
  }, [resolvedServerId])

  const refetch = useCallback(() => refreshModels(resolvedServerId), [resolvedServerId])

  return {
    models: state.models,
    isLoading: state.isLoading,
    error: state.error,
    refetch,
  }
}
