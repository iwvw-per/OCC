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
// 本模块负责「把已读水位推给服务端」，并在本地立即抬升 `readWatermarkStore`。
// 服务端侧的对应信号是 durable 事件 `session.viewed`（见 useGlobalEvents 的
// onSessionViewed）：其它端收到后抬升自己的水位，从而清掉未读点。
//
// 两套机制的关系（不是二选一，而是主备）：
//   - `session.viewed`（服务端，durable）：跨端、跨设备的主通道，无需登录账号；
//   - `readWatermarkStore`（本地 + 账号通道，max 合并）：离线兜底与同端持久化。
// 两者都只做「抬升水位」，语义一致且天然收敛（max），因此可以共存。
//
// 设计要点：
// 1. 幂等：同一 (sessionId, idle) 只上报一次，避免每次渲染都发请求。
// 2. 只升不降：服务端本身会忽略更小的值，这里再挡一层，省掉无意义的往返。
// 3. 静默失败：这是体验优化，失败绝不能让打开会话的流程报错。

import { nativeViewSession } from '../api/v2NativeSession'
import { rawSessionIdOfKey } from '../store/messagePartMerge'
import { readWatermarkStore } from '../store/readWatermarkStore'
import { sessionKeyToServerId } from '../utils/sessionKey'
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
  const bareId = rawSessionIdOfKey(sessionKey)
  if (!bareId) return
  const serverId = sessionKeyToServerId(sessionKey)

  const cacheKey = `${serverId ?? ''}::${bareId}`
  const previous = reported.get(cacheKey)
  // 已经上报过「不早于这次」的水位：无需重复请求
  if (previous !== undefined && previous >= idle) return
  // 先记账再发请求：并发调用（焦点变化 + 完成事件同时触发）时只发一次。
  // 失败不回收 —— 下次有更新的 idle 时会自然重试，避免失败抖动放大请求量。
  reported.set(cacheKey, idle)

  /**
   * 本地立即抬升水位，不等服务端回环。
   *
   * 本端自己读的会话应当立刻变已读；若等 `session.viewed` 事件回来，
   * 中间会有一次可见的「未读点闪一下」。服务端只升不降，本地提前抬升
   * 与随后到达的事件天然收敛（都是 max）。
   */
  readWatermarkStore.raise(sessionKey, idle)

  try {
    await nativeViewSession(serverId, { sessionID: bareId, idle })
  } catch (error) {
    logger.warn('[sessionView] failed to report viewed watermark', { sessionKey, idle, error })
  }
}
