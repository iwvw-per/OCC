// ============================================
// MCP API - Model Context Protocol 服务器管理
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { nativeGetMcpStatus } from './v2NativeAgent'
import { formatPathForApi, directoryCacheKey } from '../utils/directoryUtils'
import { microCache, invalidateMicroCache } from '../utils/microCache'
import { serverStore } from '../store/serverStore'
import type { MCPResourceMap, MCPStatusResponse, McpServerConfig } from '../types/api/mcp'

/**
 * MCP 状态的缓存键。
 *
 * 经隧道时每个请求约 1.1s 固定成本，而 MCP 状态在「打开会话」这一步会被
 * 状态面板、MCP 面板、侧栏等多处各拉一次（实测 4 次）。这里按
 * (server, directory) 做极短 TTL 缓存，把同一轮交互内的重复请求收敛成 1 次。
 */
function mcpScopeKey(kind: 'status' | 'resources', directory?: string, serverId?: string): string {
  const sid = serverId ?? serverStore.getActiveServerId()
  return `mcp:${kind}:${sid}:${directoryCacheKey(directory)}`
}

/**
 * 获取所有 MCP 服务器状态
 */
export async function getMcpStatus(directory?: string, serverId?: string): Promise<MCPStatusResponse> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return microCache(mcpScopeKey('status', directory, serverId), async () => {
    return (await nativeGetMcpStatus(sid)) as MCPStatusResponse
  })
}

/**
 * 获取已连接 MCP 服务器暴露的 resources
 */
export async function getMcpResources(directory?: string, serverId?: string): Promise<MCPResourceMap> {
  return microCache(mcpScopeKey('resources', directory, serverId), async () => {
    const sdk = getSDKClient(serverId)
    return unwrap(await sdk.experimental.resource.list({ directory: formatPathForApi(directory, serverId) }))
  })
}

/** MCP 状态发生变更（连接/断开/增删）后调用，避免继续返回旧状态 */
function invalidateMcpStatus(directory?: string, serverId?: string): void {
  invalidateMicroCache(`mcp:status:${serverId ?? serverStore.getActiveServerId()}:`)
  invalidateMicroCache(`mcp:resources:${serverId ?? serverStore.getActiveServerId()}:`)
  void directory
}

/**
 * 添加 MCP 服务器
 */
export async function addMcpServer(name: string, config: McpServerConfig, directory?: string): Promise<void> {
  const sid = serverStore.getActiveServerId()
  const sdk = getSDKClient(sid)
  unwrap(await sdk.mcp.add({ name, config, directory: formatPathForApi(directory, sid) }))
  invalidateMcpStatus(directory)
}

/**
 * 连接到 MCP 服务器
 */
export async function connectMcpServer(name: string, directory?: string): Promise<void> {
  const sid = serverStore.getActiveServerId()
  const sdk = getSDKClient(sid)
  unwrap(await sdk.mcp.connect({ name, directory: formatPathForApi(directory, sid) }))
  invalidateMcpStatus(directory)
}

/**
 * 断开 MCP 服务器连接
 */
export async function disconnectMcpServer(name: string, directory?: string): Promise<void> {
  const sid = serverStore.getActiveServerId()
  const sdk = getSDKClient(sid)
  unwrap(await sdk.mcp.disconnect({ name, directory: formatPathForApi(directory, sid) }))
  invalidateMcpStatus(directory)
}

/**
 * 开始 MCP 认证流程
 */
export async function startMcpAuth(name: string, directory?: string): Promise<{ url: string }> {
  const sid = serverStore.getActiveServerId()
  const sdk = getSDKClient(sid)
  const result = unwrap(await sdk.mcp.auth.start({ name, directory: formatPathForApi(directory, sid) }))
  // SDK 返回 { authorizationUrl: string }，转换为我们期望的 { url: string }
  return { url: result.authorizationUrl }
}

/**
 * 启动完整的 OAuth 认证流程
 */
export async function authenticateMcp(name: string, directory?: string): Promise<void> {
  const sid = serverStore.getActiveServerId()
  const sdk = getSDKClient(sid)
  unwrap(await sdk.mcp.auth.authenticate({ name, directory: formatPathForApi(directory, sid) }))
}
