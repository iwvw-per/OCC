// ============================================
// Global API - 全局管理
// ============================================

import type { GlobalHealthResponse as HealthInfo } from '@opencode-ai/sdk/v2/client'
import { getSDKClient, unwrap } from './sdk'
import { getV2Client } from './sdkV2'
import { formatPathForApi } from '../utils/directoryUtils'
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
 */
export async function disposeInstance(directory?: string): Promise<boolean> {
  const sid = serverStore.getActiveServerId()
  const sdk = getSDKClient(sid)
  unwrap(await sdk.instance.dispose({ directory: formatPathForApi(directory, sid) }))
  return true
}
