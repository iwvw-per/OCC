// ============================================
// PTY API - 终端管理
// ============================================

import { getV2Client } from './sdkV2'
import {
  nativeListPtySessions,
  nativeCreatePtySession,
  nativeGetPtySession,
  nativeUpdatePtySession,
  nativeRemovePtySession,
} from './v2NativePty'
import { getApiBaseUrl, getAuthHeader, buildQueryString } from './http'
import { formatPathForApi } from '../utils/directoryUtils'
import { serverStore, getUnifiedFetch } from '../store/serverStore'
import { isTauri } from '../utils/tauri'
import type { Pty, PtyCreateParams, PtyUpdateParams } from '../types/domain/pty'

export interface ShellInfo {
  path: string
  name: string
  acceptable: boolean
}

interface PtyConnectUrlOptions {
  /**
   * false = 不在 URL 里放认证（Tauri bridge 通过 header 传）
   * true  = 在 URL 里放认证（浏览器原生 WebSocket 无法设 header）
   */
  includeAuthInUrl?: boolean
  cursor?: number
  /**
   * 浏览器模式下用于 WebSocket 握手鉴权的一次性短令牌。
   * 仅本地服务器不需要；远程需要认证的服务器在连接前换取。
   */
  streamToken?: string
}

/**
 * 获取所有 PTY 会话列表
 */
export async function listPtySessions(directory?: string, serverId?: string): Promise<Pty[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return nativeListPtySessions(sid, { directory })
}

/**
 * 获取当前机器可用 shell 列表，用于 opencode config.shell 的候选项。
 */
export async function listAvailableShells(_directory?: string, serverId?: string): Promise<ShellInfo[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  const res = await getV2Client(sid).config.shells()
  return res as unknown as ShellInfo[]
}

/**
 * 创建新的 PTY 会话
 */
export async function createPtySession(params: PtyCreateParams, directory?: string, serverId?: string): Promise<Pty> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return nativeCreatePtySession(sid, { directory, ...params })
}

/**
 * 获取单个 PTY 会话（含退出状态与 exitCode）。
 */
export async function getPtySession(ptyId: string, directory?: string, serverId?: string): Promise<Pty> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return nativeGetPtySession(sid, { ptyID: ptyId, directory })
}

/**
 * 更新 PTY 会话
 */
export async function updatePtySession(
  ptyId: string,
  params: PtyUpdateParams,
  _directory?: string,
  serverId?: string,
): Promise<Pty> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return nativeUpdatePtySession(sid, { ptyID: ptyId, ...params })
}

/**
 * 删除 PTY 会话
 */
export async function removePtySession(ptyId: string, _directory?: string, serverId?: string): Promise<boolean> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return nativeRemovePtySession(sid, ptyId)
}

/**
 * 获取 PTY 连接 WebSocket URL
 *
 * 浏览器 WebSocket 不支持自定义 header，认证方式：
 * - 远程/直连服务器的首选：先用 `getPtyConnectUrlAsync` 换一次性短令牌（`st`）；
 * - 同源：浏览器会复用页面的 Basic auth 凭据；
 * - Tauri bridge：不走这里，通过 Rust 的 HTTP header 传认证。
 *
 * 本函数**不再**默认写入 `auth_token` / userinfo —— 那会把长期密码暴露在 URL
 * （日志、浏览器历史、错误上报）。仅当调用方显式传 `streamToken` 时带上凭据。
 */
export function getPtyConnectUrl(
  ptyId: string,
  directory?: string,
  options?: PtyConnectUrlOptions,
  serverId?: string,
): string {
  const httpBase = getApiBaseUrl(serverId)
  const wsBase = httpBase.replace(/^http/, 'ws')
  const includeAuthInUrl = options?.includeAuthInUrl ?? true
  const cursor =
    typeof options?.cursor === 'number' && Number.isSafeInteger(options.cursor) && options.cursor >= 0
      ? options.cursor
      : undefined

  const formatted = formatPathForApi(directory, serverId)
  // v2：/api/pty/{id}/connect?location[directory]=
  const connectPath = `/api/pty/${ptyId}/connect`
  const dirParam = 'location[directory]'
  // Tauri bridge 不需要在 URL 里放认证
  if (!includeAuthInUrl) {
    return `${wsBase}${connectPath}${buildQueryString({ [dirParam]: formatted, cursor })}`
  }

  // 浏览器原生 WebSocket：同源时浏览器会自动复用 Basic auth；
  // 跨域时依靠一次性短令牌（见上）。
  const queryParams: Record<string, string | number | undefined> = { [dirParam]: formatted, cursor }

  // 一次性短令牌：远程网关（API Monitor）与直连 opencode 都支持，由
  // `getPtyConnectUrlAsync` 在连接前换取。URL 里只出现这个短令牌，不出现长期密码。
  if (options?.streamToken) {
    queryParams.st = options.streamToken
  }

  // 同源场景浏览器会自动复用页面的 Basic 凭据，无需写进 URL。
  // 跨域且没有短令牌时，只能依赖服务端放行或调用方显式提供令牌——
  // 宁可握手失败暴露问题，也不把密码放进 URL。

  return `${wsBase}${connectPath}${buildQueryString(queryParams)}`
}

/**
 * 获取 PTY 连接 WebSocket URL（异步）。
 *
 * 浏览器模式下 WebSocket 无法自定义请求头，只能把凭据放进 URL。为不给长期密码
 * 留机会，凡需要鉴权的服务器都先换一次性短令牌，再拼 `st` 参数：
 *
 * - 本地服务器（Local）：无鉴权，返回原始 URL。
 * - Tauri bridge：走 header 传认证，返回不带鉴权的 URL。
 * - 远程网关（API Monitor）：`POST /stream-token` 换 `st`。
 * - 直连 opencode（Basic）：`GET /api/server/token` 换 `st`（同一网关接口）。
 * - 换取失败：返回不带凭据的 URL，让握手失败暴露真实错误，而不是回退到明文密码。
 */
export async function getPtyConnectUrlAsync(
  ptyId: string,
  directory?: string,
  options?: PtyConnectUrlOptions,
  serverId?: string,
): Promise<string> {
  const auth = serverId ? serverStore.getServerAuth(serverId) : serverStore.getActiveAuth()
  const includeAuthInUrl = options?.includeAuthInUrl ?? true

  // Tauri bridge 走 header，不需换短令牌。
  if (!includeAuthInUrl || isTauri()) {
    return getPtyConnectUrl(ptyId, directory, options, serverId)
  }

  // 无鉴权的本地服务器：直接连。
  if (!auth) {
    return getPtyConnectUrl(ptyId, directory, options, serverId)
  }

  // 需要鉴权：一律换一次性短令牌（网关或直连 opencode 均走同一接口）。
  // 换取失败时返回不带凭据的 URL —— 握手会失败并暴露真实错误，绝不回退到
  // 把长期密码写进 URL。
  try {
    const streamToken = await fetchStreamToken(serverId)
    if (streamToken) {
      return getPtyConnectUrl(ptyId, directory, { ...options, streamToken }, serverId)
    }
  } catch {
    // ignore: fallthrough to credential-free URL
  }
  return getPtyConnectUrl(ptyId, directory, options, serverId)
}

/** 向服务器换取一次性短令牌（用于 WebSocket 握手鉴权）。 */
async function fetchStreamToken(serverId?: string): Promise<string> {
  const baseUrl = getApiBaseUrl(serverId)
  const authHeader = getAuthHeader(serverId)
  const f = await getUnifiedFetch()

  const response = await f(`${baseUrl}/stream-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader,
    },
  })
  if (!response.ok) {
    throw new Error(`stream-token request failed: ${response.status}`)
  }
  const payload: unknown = await response.json().catch(() => ({}))
  if (!payload || typeof payload !== 'object') return ''
  const data = (payload as Record<string, unknown>).data
  if (!data || typeof data !== 'object') return ''
  const token = (data as Record<string, unknown>).streamToken
  return typeof token === 'string' ? token : ''
}
