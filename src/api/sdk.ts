// ============================================
// HTTP 基础设施 - OpenCode 2.x
//
// 职责：
// 1. Tauri / 浏览器统一 fetch（trackedFetch：超时、端点切换时取消）
// 2. 认证头构造
// 3. unwrap：从 SDK 返回值中取 data / 抛 error
//
// 具体的 SDK client 由 sdkV2.ts（@opencode/client）创建。
// ============================================

import { serverStore, makeAuthHeader } from '../store/serverStore'
import { isTauri } from '../utils/tauri'

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

/** 构造认证头（令牌走 Bearer，否则回退 Basic）。 */
export function buildHeaders(serverId?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  const auth = serverId ? serverStore.getServerAuth(serverId) : serverStore.getActiveAuth()
  if (auth?.token || auth?.password) {
    headers['Authorization'] = makeAuthHeader(auth)
  }
  return headers
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
