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
  if (serverStore.getApiVersion(sid) === 'v2') {
    const client = getV2Client(sid)
    const info = await client.server.info()
    return { healthy: true, version: info.version } as HealthInfo
  }
  const sdk = getSDKClient()
  return unwrap(await sdk.global.health())
}

/**
 * 释放当前实例
 */
export async function disposeInstance(directory?: string): Promise<boolean> {
  const sdk = getSDKClient()
  unwrap(await sdk.instance.dispose({ directory: formatPathForApi(directory) }))
  return true
}
