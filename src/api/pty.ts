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
 * - 跨域：auth_token query parameter（与官方 opencode app 一致）
 * - 同源：浏览器会复用页面的 Basic auth 凭据
 * - Tauri bridge：不走这里，通过 Rust 的 HTTP header 传认证
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

  const auth = serverId ? serverStore.getServerAuth(serverId) : serverStore.getActiveAuth()
  const formatted = formatPathForApi(directory, serverId)
  // v2：/api/pty/{id}/connect?location[directory]=
  const connectPath = `/api/pty/${ptyId}/connect`
  const dirParam = 'location[directory]'
  // Tauri bridge 不需要在 URL 里放认证
  if (!includeAuthInUrl) {
    return `${wsBase}${connectPath}${buildQueryString({ [dirParam]: formatted, cursor })}`
  }

  // 浏览器原生 WebSocket：
  // 跨域时用 auth_token query parameter + userinfo fallback
  // 同源时浏览器会自动复用 Basic auth
  const isCrossOrigin = (() => {
    try {
      return new URL(httpBase).origin !== location.origin
    } catch {
      return true
    }
  })()

  const queryParams: Record<string, string | number | undefined> = { [dirParam]: formatted, cursor }

  // 一次性短令牌：优先于 auth_token。远程服务器（如 API Monitor 网关）在
  // 需要认证时用短令牌握手，短令牌由调用方在连接前通过 streamToken 换取。
  if (options?.streamToken) {
    queryParams.st = options.streamToken
  }

  let wsUrl = wsBase
  if (auth?.password) {
    if (isCrossOrigin) {
      // auth_token = base64(username:password)，与官方 opencode app 一致
      queryParams.auth_token = btoa(`${auth.username}:${auth.password}`)
    }
    // 同时设 userinfo 作为 fallback（部分浏览器直连时能用）
    const creds = `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@`
    wsUrl = wsBase.replace('://', `://${creds}`)
  }

  return `${wsUrl}${connectPath}${buildQueryString(queryParams)}`
}

/**
 * 获取 PTY 连接 WebSocket URL（异步）。
 *
 * 浏览器模式下 WebSocket 无法自定义请求头，而远程服务器（API Monitor 网关）
 * 要求鉴权。思路：先用 fetch（可带 header）调网关的 stream-token 接口换取
 * 一次性短令牌，再拼进 WebSocket URL 的 `st` 参数完成握手。
 *
 * - 本地服务器（Local）：本地 opencode 通常无鉴权，返回原始 URL。
 * - Tauri bridge：走 header 传认证，返回不带鉴权的 URL。
 * - 浏览器 + 远程需要认证的服务器：先换短令牌再返回带 `st` 的 URL。
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

  // 非 token 服务器：本地无鉴权或走 password 的 auth_token 方案，直接用原始 URL。
  if (!auth?.token) {
    return getPtyConnectUrl(ptyId, directory, options, serverId)
  }

  // token 认证的远程服务器（如 API Monitor 的 AI Agent 网关）：浏览器 WebSocket
  // 无法带 Authorization header，必须先用 fetch 换一次性短令牌再拼进 URL。
  // 换取失败（服务器不支持/未登录）时回退到原始 URL，让握手失败暴露真实错误。
  try {
    const streamToken = await fetchStreamToken(serverId)
    if (streamToken) {
      return getPtyConnectUrl(ptyId, directory, { ...options, streamToken }, serverId)
    }
  } catch {
    // ignore: fallthrough to raw URL
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
