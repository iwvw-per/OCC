// ============================================
// Global API - 全局管理
// ============================================

import type { GlobalHealthResponse as HealthInfo } from '@opencode-ai/sdk/v2/client'
import { getV2Client } from './sdkV2'
import { serverStore } from '../store/serverStore'

/**
 * 获取服务器健康状态
 */
export async function getHealth(): Promise<HealthInfo> {
  const sid = serverStore.getActiveServerId()
  const client = getV2Client(sid)
  const info = await client.server.info()
  return { healthy: true, version: info.version } as HealthInfo
}

/**
 * 释放当前实例
 *
 * v2 无对应能力（实例由 server 进程管理），客户端退出/清理时调用，安全 no-op。
 */
export async function disposeInstance(_directory?: string): Promise<boolean> {
  return true
}
