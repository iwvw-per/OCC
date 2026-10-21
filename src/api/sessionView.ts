// ============================================
// 会话已读上报（v2 session.view）
// ============================================
//
// v2 把「用户看过这一轮」持久化在 `session.time.viewed` 上，未读语义因此是
// `time.viewed < time.idle`。这与 OCC 原先只在本地 notificationStore 维护未读点
// 有本质区别：
//   - 本地未读：换一台设备、换一个浏览器，未读点完全不同步；刷新即丢。
//   - 服务端水位：任何端打开过就是已读，其它端立刻一致。
//
// 本模块只负责「把已读水位推给服务端」，不改变现有 UI 的未读判断（那套逻辑
// 仍以 notificationStore 为准，避免一次性改动过大）。等水位数据稳定后，UI 可以
// 直接改成读 `viewed < idle`，本模块的上报就会成为唯一数据源。
//
// 设计要点：
// 1. 幂等：同一 (sessionId, idle) 只上报一次，避免每次渲染都发请求。
// 2. 只升不降：服务端本身会忽略更小的值，这里再挡一层，省掉无意义的往返。
// 3. 静默失败：这是体验优化，失败绝不能让打开会话的流程报错。

import { nativeViewSession } from '../api/v2NativeSession'
import { sessionKeyToSessionId, sessionKeyToServerId } from '../utils/sessionKey'
import { logger } from '../utils'

/** 已上报过的水位，key 为 `${serverId}::${sessionId}` */
const reported = new Map<string, number>()

/** 测试用：清空上报记录 */
export function resetViewReportCache(): void {
  reported.clear()
}

/**
 * 把会话的已读水位上报到服务端。
 *
 * @param sessionKey 复合会话 key（`local::ses_x` / `aiagent:inst_x::ses_x`）
 * @param idle       会话当前的 `time.idle`；缺省或 0 表示还没跑完过一轮，不上报
 */
export async function reportSessionViewed(sessionKey: string, idle: number | undefined): Promise<void> {
  if (!idle || idle <= 0) return
  const bareId = sessionKeyToSessionId(sessionKey)
  if (!bareId) return
  const serverId = sessionKeyToServerId(sessionKey)

  const cacheKey = `${serverId ?? ''}::${bareId}`
  const previous = reported.get(cacheKey)
  // 已经上报过「不早于这次」的水位：无需重复请求
  if (previous !== undefined && previous >= idle) return
  // 先记账再发请求：并发调用（焦点变化 + 完成事件同时触发）时只发一次。
  // 失败不回收 —— 下次有更新的 idle 时会自然重试，避免失败抖动放大请求量。
  reported.set(cacheKey, idle)

  try {
    await nativeViewSession(serverId, { sessionID: bareId, idle })
  } catch (error) {
    logger.warn('[sessionView] failed to report viewed watermark', { sessionKey, idle, error })
  }
}
