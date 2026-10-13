// ============================================
// SDK Client - 基于 @opencode-ai/sdk 的统一客户端
//
// 职责：
// 1. 根据当前活动服务器动态创建 SDK client
// 2. 整合 baseUrl / auth / tauri fetch
// 3. 为上层 API 模块提供统一的 client 获取方式
// ============================================

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client'
import { serverStore, makeAuthHeader } from '../store/serverStore'
import { isTauri } from '../utils/tauri'
import { createV2Facade } from './clientFacade'

// Tauri fetch 缓存
let _tauriFetch: typeof globalThis.fetch | null = null
let _tauriFetchLoading: Promise<typeof globalThis.fetch> | null = null
let _apiRequestGeneration = 0
const _apiRequestControllers = new Set<AbortController>()

export async function getTauriFetch(): Promise<typeof globalThis.fetch> {
  if (_tauriFetch) return _tauriFetch
  if (_tauriFetchLoading) return _tauriFetchLoading
  _tauriFetchLoading = import('@tauri-apps/plugin-http').then(mod => {
    _tauriFetch = mod.fetch as unknown as typeof globalThis.fetch
    return _tauriFetch
  })
  return _tauriFetchLoading
}

/**
 * 等待 tauri fetch 就绪；导入失败时回退原生 fetch。
 *
 * 移动端（Android）同样走 Tauri 分支，但连的是远程服务器，远程 https 用
 * webview 原生 fetch 本就可达。若插件在某些环境导入失败，回退原生 fetch
 * 比直接硬失败更稳妥，也保持与旧行为一致。
 */
async function resolveTauriFetch(): Promise<typeof globalThis.fetch> {
  try {
    return await getTauriFetch()
  } catch {
    return globalThis.fetch
  }
}

/**
 * 已就绪的 fetch 实现；Tauri 插件尚未加载完成时返回 null。
 *
 * 浏览器环境恒为 globalThis.fetch；Tauri 下只有插件加载完成才算就绪，
 * 避免首屏请求落到 webview 原生 fetch 访问 127.0.0.1 时抛 Failed to fetch。
 */
function readyFetchImpl(): typeof globalThis.fetch | null {
  if (isTauri()) return _tauriFetch
  return globalThis.fetch
}

function createAbortError(message: string) {
  return new DOMException(message, 'AbortError')
}

/** 请求超时：服务端半死时避免请求永久挂起，超时后按瞬态错误重试。 */
const API_REQUEST_TIMEOUT_MS = 30_000

export async function trackedFetch(input: RequestInfo | URL, init: RequestInit | undefined, generation: number): Promise<Response> {
  const controller = new AbortController()
  const externalSignal = init?.signal
  const abortFromExternal = () => controller.abort(externalSignal?.reason)

  if (externalSignal?.aborted) {
    abortFromExternal()
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  }

  // 外部已带 signal 时不叠加超时，避免和调用方的取消语义打架
  const timeoutId = externalSignal
    ? null
    : setTimeout(() => controller.abort(createAbortError('API request timed out')), API_REQUEST_TIMEOUT_MS)

  _apiRequestControllers.add(controller)

  try {
    if (generation !== _apiRequestGeneration) {
      throw createAbortError('Stale API request')
    }

    // 快路径：fetch 已就绪时同步发起，保证 abortInFlightApiRequests 能在
    // 请求真正开始前取消它（不引入微任务间隙）。
    const ready = readyFetchImpl()
    if (ready) {
      return await ready(input, { ...init, signal: controller.signal })
    }

    // 慢路径：Tauri 插件尚未加载完成，等待就绪后再发；期间若端点已切换则放弃。
    // 插件导入失败时回退原生 fetch，避免移动端等环境硬失败。
    const fetchImpl = await resolveTauriFetch()
    if (generation !== _apiRequestGeneration) {
      throw createAbortError('Stale API request')
    }
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
    externalSignal?.removeEventListener('abort', abortFromExternal)
    _apiRequestControllers.delete(controller)
  }
}

/** 当前 API 请求代次。供其它客户端工厂（如 v2 SDK）在构造 fetch 时捕获。 */
export function getApiRequestGeneration(): number {
  return _apiRequestGeneration
}

export function abortInFlightApiRequests(reason = 'Server endpoint changed'): void {
  _apiRequestGeneration++
  for (const controller of _apiRequestControllers) {
    controller.abort(createAbortError(reason))
  }
  _apiRequestControllers.clear()
}

// Client 缓存：按 serverId → "baseUrl + authHash" 缓存实例，避免重复创建
// 缺省 serverId（undefined）表示活动服务器
interface CachedClientEntry {
  key: string
  client: OpencodeClient
}

const _cachedClients = new Map<string | undefined, CachedClientEntry>()

export function buildCacheKey(serverId?: string): string {
  const baseUrl = serverId ? serverStore.getServerBaseUrl(serverId) : serverStore.getActiveBaseUrl()
  const auth = serverId ? serverStore.getServerAuth(serverId) : serverStore.getActiveAuth()
  const authPart = auth?.password ? `${auth.username}:${auth.password}` : ''
  return `${baseUrl}|${authPart}`
}

export function buildHeaders(serverId?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  const auth = serverId ? serverStore.getServerAuth(serverId) : serverStore.getActiveAuth()
  if (auth?.token || auth?.password) {
    headers['Authorization'] = makeAuthHeader(auth)
  }
  return headers
}

/**
 * 同步获取 SDK client。
 * 每次请求经 trackedFetch：fetch 已就绪时同步发起；Tauri 插件尚未加载完成时
 * 等待其就绪后再发，不会回退到 webview 原生 fetch。
 * @param serverId 指定服务器（缺省用活动服务器）
 */
export function getSDKClient(serverId?: string): OpencodeClient {
  const key = buildCacheKey(serverId)
  const cached = _cachedClients.get(serverId)
  if (cached && cached.key === key) {
    return cached.client
  }

  // v2 服务器：返回对 v1 SDK 形状的 facade（内部走 @opencode/client 并适配响应）。
  // 版本由 serverStore 健康检查探测并缓存；未探测到时按 v1 处理（默认路径）。
  const resolvedServerId = serverId ?? serverStore.getActiveServerId()
  const apiVersion = resolvedServerId ? serverStore.getApiVersion(resolvedServerId) : undefined
  if (apiVersion === 'v2') {
    const facade = createV2Facade(serverId)
    _cachedClients.set(serverId, { key, client: facade })
    return facade
  }

  const baseUrl = serverId ? serverStore.getServerBaseUrl(serverId) : serverStore.getActiveBaseUrl()
  const headers = buildHeaders(serverId)
  const generation = _apiRequestGeneration

  const client = createOpencodeClient({
    baseUrl,
    headers,
    fetch: (input, init) => trackedFetch(input, init, generation),
  })
  _cachedClients.set(serverId, { key, client })
  return client
}

/**
 * 异步获取 SDK client（确保 tauri fetch 已加载）
 * 在应用初始化时应该先调一次这个
 * @param serverId 指定服务器（缺省用活动服务器）
 */
export async function getSDKClientAsync(serverId?: string): Promise<OpencodeClient> {
  if (isTauri()) {
    await getTauriFetch()
  }
  // 使 cache 失效以便用新的 tauri fetch 重建
  _cachedClients.delete(serverId)
  return getSDKClient(serverId)
}

/**
 * 强制重建 client（服务器切换时调用）
 * @param serverId 指定服务器（缺省全部失效）
 */
export function invalidateSDKClient(serverId?: string): void {
  if (serverId) {
    _cachedClients.delete(serverId)
  } else {
    _cachedClients.clear()
  }
}

/**
 * 从 SDK 返回值中提取 data，如果有 error 则抛出
 *
 * SDK 默认返回 { data, error, request, response }
 * 我们的上层 API 函数期望直接返回数据，所以需要 unwrap
 */
export function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error != null) {
    const err = result.error
    if (err instanceof Error) throw err
    if (typeof err === 'string') throw new Error(err)
    throw new Error(JSON.stringify(err))
  }
  return result.data as T
}
