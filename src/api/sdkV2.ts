// ============================================
// SDK V2 Client - 基于 @opencode/client@2.0.28 的 v2 客户端
//
// 与 sdk.ts 并存：sdk.ts 保留 v1（@opencode-ai/sdk）客户端；本模块提供
// v2（/api/* 前缀）客户端的构造。二者复用同一套 fetch/鉴权/取消代次机制。
//
// 注意：本模块不缓存 client。缓存由 sdk.ts 的 facade 层负责（按 serverId +
// baseUrl + auth 失效），避免出现「v1/v2 两份缓存各自失效」的不一致。
// ============================================

import { OpenCode, type OpenCodeClient } from '@opencode/client'
import { serverStore } from '../store/serverStore'
import { isTauri } from '../utils/tauri'
import { buildHeaders, getApiRequestGeneration, getTauriFetch, trackedFetch } from './sdk'

/**
 * 构造 v2 SDK client。
 * 每次请求经 trackedFetch：fetch 已就绪时同步发起；Tauri 插件尚未加载完成时
 * 等待其就绪后再发，不会回退到 webview 原生 fetch。
 * @param serverId 指定服务器（缺省用活动服务器）
 */
export function getV2Client(serverId?: string): OpenCodeClient {
  const baseUrl = serverId ? serverStore.getServerBaseUrl(serverId) : serverStore.getActiveBaseUrl()
  const headers = buildHeaders(serverId)
  const generation = getApiRequestGeneration()

  return OpenCode.make({
    baseUrl,
    headers,
    fetch: (input, init) => trackedFetch(input, init, generation),
  })
}

/** 异步获取 v2 SDK client（确保 tauri fetch 已加载） */
export async function getV2ClientAsync(serverId?: string): Promise<OpenCodeClient> {
  if (isTauri()) {
    await getTauriFetch()
  }
  return getV2Client(serverId)
}
